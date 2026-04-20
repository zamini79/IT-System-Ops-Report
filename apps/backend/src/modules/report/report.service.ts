/**
 * Report Service
 *
 * ─ 흐름 ───────────────────────────────────────────────────────────────────────
 *  1. report_jobs.status = RUNNING
 *  2. ReportBuilder.build(jobId) → HTML
 *  3. PdfGenerator.generate(html, outputPath) → PDF
 *  4. report_jobs.pdf_path = ..., status = COMPLETED
 *  5. SSE: report_done
 */

import fs   from "fs";
import path from "path";

import { query }         from "../../config/db";
import { AppError }      from "../../utils/errors";
import { logger }        from "../../utils/logger";
import { ReportBuilder } from "../../engines/report/ReportBuilder";
import { PdfGenerator }  from "../../engines/report/PdfGenerator";
import type { PdfOptions } from "../../engines/report/PdfGenerator";
import { jobEventBus }   from "../crawl/crawl.events";
import type { DivisionCode } from "../../engines/playwright/types";

// ── 내부 타입 ─────────────────────────────────────────────────────────────────

export interface StartGenerateParams {
  jobId:        string;
  divisionCode: DivisionCode;
  userId:       string;
}

interface JobRow {
  id:          string;
  status:      string;
  division_id: string;
  pdf_path:    string | null;
  created_at:  string;
}

interface HistoryRow {
  id:            string;
  status:        string;
  pdf_path:      string | null;
  error_message: string | null;
  started_at:    string | null;
  completed_at:  string | null;
  created_at:    string;
  division_code: string;
  division_name: string;
}

// ── 출력 경로 결정 ────────────────────────────────────────────────────────────

function buildOutputPath(divisionCode: string, jobId: string): string {
  const outputDir = path.resolve(process.env.OUTPUT_DIR ?? "outputs");
  const now       = new Date();
  const yyyymm    = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  // 형식: SKBS_{DIV}_Report_{YYYYMM}_{jobId}.pdf
  const filename  = `SKBS_${divisionCode}_Report_${yyyymm}_${jobId}.pdf`;
  return path.join(outputDir, filename);
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * PDF 보고서 생성을 백그라운드에서 시작합니다.
 *
 * 즉시 반환하고 생성 완료 시 SSE(report_done / report_error)를 발행합니다.
 */
export async function startReportGeneration(
  params: StartGenerateParams
): Promise<void> {
  const { jobId, divisionCode, userId } = params;

  // ── 사업부 ID 조회 (분기 존재 여부 검증) ──────────────────────────────
  const divRows = await query<{ id: string }>(
    "SELECT id FROM divisions WHERE code = $1",
    [divisionCode]
  );
  if (!divRows.length) {
    throw new AppError(400, `알 수 없는 사업부 코드: ${divisionCode}`);
  }
  const divisionId = divRows[0].id;

  // ── report_jobs upsert (없으면 생성, 있으면 RUNNING 으로 갱신) ─────────
  // ON CONFLICT 대신 SELECT → UPDATE/INSERT 로 처리 (unique constraint 의존 제거)
  const existingJob = await query<{ id: string }>(
    "SELECT id FROM report_jobs WHERE id = $1",
    [jobId]
  );
  if (existingJob.length) {
    await query(
      `UPDATE report_jobs
       SET status = 'RUNNING', started_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [jobId]
    );
  } else {
    await query(
      `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
       VALUES ($1, $2, 'RUNNING', NOW(), $3)`,
      [jobId, divisionId, userId]
    );
  }

  // ── SSE: 생성 시작 알림 ───────────────────────────────────────────────
  jobEventBus.emit(jobId, { type: "report_generating", jobId });

  // ── 백그라운드 실행 (fire-and-forget) ─────────────────────────────────
  void runGenerationInBackground({ jobId, divisionCode });

  logger.info(`[ReportService] Generation started: ${jobId} (${divisionCode})`);
}

/**
 * 보고서 생성 이력을 페이지네이션하여 반환합니다.
 */
export async function listReportHistory(params: {
  division?: string;
  page:      number;
  limit:     number;
}): Promise<{ items: HistoryRow[]; total: number }> {
  const { division, page, limit } = params;
  const offset = (page - 1) * limit;

  const [items, countRows] = await Promise.all([
    query<HistoryRow>(
      `SELECT rj.id, rj.status, rj.pdf_path, rj.error_message,
              rj.started_at, rj.completed_at, rj.created_at,
              d.code AS division_code,
              d.name AS division_name
       FROM report_jobs rj
       JOIN divisions   d ON rj.division_id = d.id
       WHERE ($1::text IS NULL OR d.code::text = $1::text)
       ORDER BY rj.created_at DESC
       LIMIT $2 OFFSET $3`,
      [division ?? null, limit, offset]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM report_jobs rj
       JOIN divisions   d ON rj.division_id = d.id
       WHERE ($1::text IS NULL OR d.code::text = $1::text)`,
      [division ?? null]
    ),
  ]);

  return { items, total: Number(countRows[0]?.count ?? 0) };
}

/**
 * 단일 report_jobs 레코드를 반환합니다.
 */
export async function getJobStatus(jobId: string): Promise<JobRow> {
  const rows = await query<JobRow>(
    `SELECT id, status, division_id, pdf_path, created_at
     FROM report_jobs WHERE id = $1`,
    [jobId]
  );
  if (!rows.length) throw new AppError(404, `보고서 작업을 찾을 수 없습니다: ${jobId}`);
  return rows[0];
}

/**
 * pdf_path 를 조회하고 파일이 존재하는지 확인합니다.
 */
export async function getPdfPath(jobId: string): Promise<string> {
  const rows = await query<{ pdf_path: string | null; status: string }>(
    "SELECT pdf_path, status FROM report_jobs WHERE id = $1",
    [jobId]
  );
  if (!rows.length) throw new AppError(404, `보고서 작업을 찾을 수 없습니다: ${jobId}`);

  const { pdf_path, status } = rows[0];

  if (status !== "COMPLETED" || !pdf_path) {
    throw new AppError(409, `PDF 가 아직 준비되지 않았습니다. 현재 상태: ${status}`);
  }
  if (!fs.existsSync(pdf_path)) {
    throw new AppError(404, "PDF 파일이 서버에 존재하지 않습니다.");
  }

  return pdf_path;
}

// ── 백그라운드 생성 ────────────────────────────────────────────────────────────

const DEFAULT_PDF_OPTIONS: PdfOptions = {
  format:          "A4",
  printBackground: true,
  margin: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" },
};

async function runGenerationInBackground(params: {
  jobId:        string;
  divisionCode: DivisionCode;
}): Promise<void> {
  const { jobId, divisionCode } = params;

  try {
    // ── HTML 생성 ──────────────────────────────────────────────────────────
    logger.info(`[ReportService] Building HTML: ${jobId}`);
    const builder = new ReportBuilder();
    const html    = await builder.build(jobId);

    // ── PDF 변환 ──────────────────────────────────────────────────────────
    const outputPath = buildOutputPath(divisionCode, jobId);
    logger.info(`[ReportService] Generating PDF → ${outputPath}`);

    const result = await PdfGenerator.generate(html, outputPath, DEFAULT_PDF_OPTIONS);

    // ── DB 완료 처리 ────────────────────────────────────────────────────────
    await query(
      `UPDATE report_jobs
       SET status       = 'COMPLETED',
           pdf_path     = $1,
           completed_at = NOW(),
           updated_at   = NOW()
       WHERE id = $2`,
      [result.filePath, jobId]
    );

    // ── SSE: report_done ───────────────────────────────────────────────────
    jobEventBus.emit(jobId, {
      type:      "report_done",
      jobId,
      pdfPath:   result.filePath,
      pageCount: result.pageCount,
      fileSize:  result.fileSize,
    });

    logger.info(
      `[ReportService] PDF done: ${result.filePath} ` +
      `(${result.pageCount} pages, ${(result.fileSize / 1024).toFixed(1)} KB)`
    );

  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error(`[ReportService] Generation failed: ${jobId} — ${errMsg}`);

    // ── DB 실패 처리 ────────────────────────────────────────────────────────
    await query(
      `UPDATE report_jobs
       SET status        = 'FAILED',
           error_message = $1,
           completed_at  = NOW(),
           updated_at    = NOW()
       WHERE id = $2`,
      [errMsg, jobId]
    ).catch((e: Error) =>
      logger.warn(`[ReportService] DB update failed: ${e.message}`)
    );

    // ── SSE: report_error ──────────────────────────────────────────────────
    jobEventBus.emit(jobId, {
      type:  "report_error",
      jobId,
      error: errMsg,
    });
  }

  jobEventBus.scheduleCleanup(jobId);
}
