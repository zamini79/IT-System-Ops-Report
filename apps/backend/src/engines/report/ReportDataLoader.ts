/**
 * ReportDataLoader
 *
 * jobId 로 보고서 생성에 필요한 모든 데이터를 DB 에서 조회하고
 * 다운로드된 파일을 분석하여 ReportData 를 반환합니다.
 */

import fs   from "fs";
import path from "path";

import { query }   from "../../config/db";
import { AppError } from "../../utils/errors";
import { logger }   from "../../utils/logger";
import { analyze }  from "../analyzer";
import type { SpreadsheetAnalysisResult, StoredAnalysisResult } from "../analyzer/types";
import type { DivisionCode } from "../playwright/types";
import {
  SYSTEM_ORDER,
  SYSTEM_LABELS,
  type ReportData,
  type ReportJobInfo,
  type SystemReportData,
  type UploadedFileInfo,
} from "./types";

// ── DB Row 타입 ───────────────────────────────────────────────────────────────

interface JobRow {
  id:            string;
  status:        string;
  created_at:    string;
  division_code: string;
  division_name: string;
}

interface TaskRow {
  id:          string;
  system_name: string;
  task_type:   string;
  status:      string;
  result_path: string | null;
  error:       string | null;
}

interface FileRow {
  id:              string;
  original_name:   string;
  stored_path:     string;
  file_type:       string;
  file_size:       number;
  analysis_result: StoredAnalysisResult | null;
  created_at:      string;
}

// ── 유틸리티 ──────────────────────────────────────────────────────────────────

/** 파일 확장자에서 MIME 타입을 추론합니다. */
function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls":  "application/vnd.ms-excel",
    ".csv":  "text/csv",
    ".pdf":  "application/pdf",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
  };
  return map[ext] ?? "application/octet-stream";
}

/** PNG 파일을 base64 data URL 로 변환합니다. */
function toBase64DataUrl(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf  = fs.readFileSync(filePath);
    const mime = mimeFromPath(filePath);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** 시스템의 다운로드 파일을 분석합니다 (Excel / CSV 만). */
async function analyzeDownloadedFile(
  resultPath: string
): Promise<SpreadsheetAnalysisResult | null> {
  try {
    if (!fs.existsSync(resultPath)) return null;

    const mime   = mimeFromPath(resultPath);
    const result = await analyze(resultPath, mime);

    if (result.type === "excel" || result.type === "csv") {
      return result;
    }
  } catch (e) {
    logger.warn(`[ReportDataLoader] 파일 분석 실패: ${resultPath} — ${(e as Error).message}`);
  }
  return null;
}

// ── 공개 클래스 ───────────────────────────────────────────────────────────────

export class ReportDataLoader {
  /**
   * jobId 에 해당하는 모든 보고서 데이터를 로드합니다.
   *
   * @throws AppError(404)  jobId 에 해당하는 레코드가 없을 경우
   */
  async load(jobId: string): Promise<ReportData> {
    // ── 1. job + division 조회 ─────────────────────────────────────────────
    const jobRows = await query<JobRow>(
      `SELECT rj.id, rj.status, rj.created_at,
              d.code AS division_code,
              d.name AS division_name
       FROM report_jobs rj
       JOIN divisions   d  ON rj.division_id = d.id
       WHERE rj.id = $1`,
      [jobId]
    );

    if (!jobRows.length) {
      throw new AppError(404, `보고서 작업을 찾을 수 없습니다: ${jobId}`);
    }

    const jr           = jobRows[0];
    const divisionCode = jr.division_code as DivisionCode;

    const job: ReportJobInfo = {
      id:           jr.id,
      divisionCode,
      divisionName: jr.division_name,
      status:       jr.status,
      createdAt:    new Date(jr.created_at),
    };

    // ── 2. crawl_tasks 조회 ────────────────────────────────────────────────
    const taskRows = await query<TaskRow>(
      `SELECT id, system_name, task_type, status, result_path, error
       FROM crawl_tasks
       WHERE report_job_id = $1`,
      [jobId]
    );

    // ── 3. uploaded_files 조회 ────────────────────────────────────────────
    const fileRows = await query<FileRow>(
      `SELECT id, original_name, stored_path, file_type, file_size,
              analysis_result, created_at
       FROM uploaded_files
       WHERE report_job_id = $1
       ORDER BY created_at`,
      [jobId]
    );

    // ── 4. 시스템별 데이터 조립 (비동기 병렬) ────────────────────────────
    const systemOrder = SYSTEM_ORDER[divisionCode] ?? [];

    const systems: SystemReportData[] = await Promise.all(
      systemOrder.map(async (systemName): Promise<SystemReportData> => {
        const downloadTask = taskRows.find(
          (t) => t.system_name === systemName && t.task_type === "DOWNLOAD"
        );
        const screenshotTask = taskRows.find(
          (t) => t.system_name === systemName && t.task_type === "SCREENSHOT"
        );

        // 스크린샷 → base64
        const screenshotBase64 = screenshotTask?.result_path
          ? toBase64DataUrl(screenshotTask.result_path)
          : null;

        // 다운로드된 파일 분석 (Excel / CSV)
        const downloadedAnalysis = downloadTask?.result_path
          ? await analyzeDownloadedFile(downloadTask.result_path)
          : null;

        return {
          systemName,
          label:               SYSTEM_LABELS[systemName] ?? systemName,
          crawlStatus:         downloadTask?.status          ?? "PENDING",
          crawlError:          downloadTask?.error           ?? null,
          screenshotBase64,
          screenshotCapturedAt: null, // crawl_tasks 에 별도 저장된 타임스탬프 없음
          downloadedAnalysis,
        };
      })
    );

    // ── 5. 업로드 파일 매핑 ────────────────────────────────────────────────
    const uploadedFiles: UploadedFileInfo[] = fileRows.map((f) => ({
      id:             f.id,
      originalName:   f.original_name,
      storedPath:     f.stored_path,
      fileType:       f.file_type,
      fileSize:       f.file_size,
      analysisResult: f.analysis_result,
      createdAt:      new Date(f.created_at),
    }));

    // ── 6. 보고 기간 (job 생성일 기준 최근 3개월) ─────────────────────────
    const to   = new Date(jr.created_at);
    const from = new Date(to);
    from.setMonth(from.getMonth() - 3);

    return { job, systems, uploadedFiles, period: { from, to } };
  }
}
