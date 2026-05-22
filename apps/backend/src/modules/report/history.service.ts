/**
 * 보고서 History 서비스 — 매달 발행된 보고서 보관소
 *
 * 기존 report_jobs 는 생성 로그 성격. 본 서비스는 사용자가 명시적으로
 * "저장" 한 보고서만 (division, report_type, year, month) 단위로 1건씩 보관.
 *
 * 파일 보관 경로: SAVED_REPORTS_DIR/{division_code}/{YYYY-MM}/{filename}
 *   - outputs/ 와 분리해 매번 재생성으로 덮어씌어지지 않도록 사본 보관
 */

import path from "path";
import fs   from "fs";
import { query }    from "../../config/db";
import { logger }   from "../../utils/logger";
import { AppError } from "../../utils/errors";

export interface SavedReportRow {
  id:            string;
  division_code: string;
  report_type:   string;
  year:          number;
  month:         number;
  source_job_id: string | null;
  filename:      string;
  stored_path:   string;
  file_size:     number;
  saved_by:      string | null;
  saved_at:      string;
}

const SAVED_DIR = path.resolve(process.env.SAVED_REPORTS_DIR ?? "saved_reports");

/**
 * report_type → outputs/ 폴더 내 PDF 파일명 패턴.
 * 신규 본부 추가 시 여기에 정규식 추가.
 */
const REPORT_TYPE_PATTERN: Record<string, RegExp> = {
  bio_veeva: /Bio연구본부 시스템 운영 현황 Report\.pdf$/,
  bio_lims:  /Bio연구본부 임검분 LIMS 운영 현황 Report\.pdf$/,
  bio_eln:   /Bio연구본부 전자연구노트.*Report\.pdf$/,
  dev:       /개발본부 시스템 운영 현황 Report\.pdf$/,
  lhouse:    /L HOUSE Veeva System Report\.pdf$/,
};

/** outputs/ 에서 해당 report_type 의 가장 최근 PDF 파일 경로 반환 */
function findLatestOutputFile(reportType: string): string | null {
  const outputDir = path.resolve(process.env.OUTPUT_DIR ?? "outputs");
  if (!fs.existsSync(outputDir)) return null;

  const pattern = REPORT_TYPE_PATTERN[reportType];
  if (!pattern) return null;

  const candidates = fs.readdirSync(outputDir)
    .filter((f) => pattern.test(f))
    .map((f) => {
      const p = path.join(outputDir, f);
      return { path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return candidates[0]?.path ?? null;
}

/**
 * 보고서 PDF 를 History 에 저장.
 * 같은 (division, report_type, year, month) 가 이미 있으면 덮어쓰기.
 */
export async function saveReportToHistory(params: {
  divisionCode: string;
  reportType:   string;
  year:         number;
  month:        number;
  userId:       string;
  sourceJobId?: string | null;
}): Promise<SavedReportRow> {
  const { divisionCode, reportType, year, month, userId, sourceJobId } = params;

  if (!REPORT_TYPE_PATTERN[reportType]) {
    throw new AppError(400, `알 수 없는 report_type: ${reportType}`);
  }
  if (year < 2000 || year > 3000)  throw new AppError(400, "year 가 유효하지 않습니다.");
  if (month < 1 || month > 12)     throw new AppError(400, "month 는 1~12 사이여야 합니다.");

  // 1) outputs/ 에서 최신 PDF 찾기
  const sourcePath = findLatestOutputFile(reportType);
  if (!sourcePath) {
    throw new AppError(400, "저장할 PDF 가 없습니다. 먼저 보고서를 생성해주세요.");
  }

  // 2) saved_reports/{division}/{YYYY-MM}/ 로 복사
  const mm        = String(month).padStart(2, "0");
  const destDir   = path.join(SAVED_DIR, divisionCode, `${year}-${mm}`);
  fs.mkdirSync(destDir, { recursive: true });

  const filename = path.basename(sourcePath);
  const destPath = path.join(destDir, filename);
  fs.copyFileSync(sourcePath, destPath);

  const fileSize = fs.statSync(destPath).size;

  // 3) DB upsert
  const rows = await query<SavedReportRow>(
    `INSERT INTO saved_reports
       (division_code, report_type, year, month, source_job_id, filename, stored_path, file_size, saved_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (division_code, report_type, year, month) DO UPDATE
       SET source_job_id = EXCLUDED.source_job_id,
           filename      = EXCLUDED.filename,
           stored_path   = EXCLUDED.stored_path,
           file_size     = EXCLUDED.file_size,
           saved_by      = EXCLUDED.saved_by,
           saved_at      = NOW()
     RETURNING *`,
    [divisionCode, reportType, year, month, sourceJobId ?? null, filename, destPath, fileSize, userId]
  );

  logger.info(`[History] ${divisionCode}/${reportType} ${year}-${mm} 저장: ${destPath}`);
  return rows[0];
}

/** 저장된 보고서 목록 — 월/본부 필터 지원 */
export async function listSavedReports(filter: {
  divisionCode?: string;
  year?:         number;
  month?:        number;
}): Promise<SavedReportRow[]> {
  const conds: string[] = [];
  const args:  unknown[] = [];

  if (filter.divisionCode) {
    args.push(filter.divisionCode);
    conds.push(`division_code = $${args.length}`);
  }
  if (filter.year) {
    args.push(filter.year);
    conds.push(`year = $${args.length}`);
  }
  if (filter.month) {
    args.push(filter.month);
    conds.push(`month = $${args.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  return query<SavedReportRow>(
    `SELECT * FROM saved_reports ${where}
       ORDER BY year DESC, month DESC, division_code, report_type`,
    args
  );
}

export async function getSavedReport(id: string): Promise<SavedReportRow | null> {
  const rows = await query<SavedReportRow>(
    `SELECT * FROM saved_reports WHERE id = $1`, [id]
  );
  return rows[0] ?? null;
}

/** History 항목 삭제 — DB 레코드 + 디스크 파일 */
export async function deleteSavedReport(id: string): Promise<void> {
  const row = await getSavedReport(id);
  if (!row) throw new AppError(404, "저장된 보고서를 찾을 수 없습니다.");

  try {
    if (fs.existsSync(row.stored_path)) fs.unlinkSync(row.stored_path);
  } catch (e) {
    logger.warn(`[History] 파일 삭제 실패 (무시): ${row.stored_path} — ${(e as Error).message}`);
  }

  await query(`DELETE FROM saved_reports WHERE id = $1`, [id]);
  logger.info(`[History] 삭제: ${id}`);
}
