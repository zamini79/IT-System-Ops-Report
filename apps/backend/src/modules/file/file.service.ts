/**
 * File Service
 *
 * uploaded_files 테이블 CRUD + 업로드 후 분석 트리거
 */

import fs   from "fs";
import { query }   from "../../config/db";
import { AppError } from "../../utils/errors";
import { logger }   from "../../utils/logger";
import { analyze }  from "../../engines/analyzer";
import type { StoredAnalysisResult } from "../../engines/analyzer";

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface UploadedFileRow {
  id:              string;
  report_job_id:   string;
  original_name:   string;
  stored_path:     string;
  file_type:       string;             // MIME type
  file_size:       number;             // bytes
  analysis_result: Record<string, unknown>;
  created_at:      string;
}

// ── 조회 ─────────────────────────────────────────────────────────────────────

/**
 * jobId(= report_jobs.id)로 업로드 파일 목록을 반환합니다.
 */
export async function listFilesByJobId(jobId: string): Promise<UploadedFileRow[]> {
  return query<UploadedFileRow>(
    `SELECT id, report_job_id, original_name, stored_path, file_type, file_size,
            analysis_result, created_at
     FROM uploaded_files
     WHERE report_job_id = $1
     ORDER BY created_at`,
    [jobId]
  );
}

// ── 저장 ─────────────────────────────────────────────────────────────────────

/**
 * 업로드된 파일 목록을 DB에 일괄 삽입합니다.
 * report_jobs 행이 없으면 PENDING 상태로 자동 생성합니다.
 *
 * @param jobId         report_jobs.id (프론트엔드 생성 UUID)
 * @param divisionCode  사업부 코드 (BIO / DEV / LHOUSE)
 * @param userId        업로드 요청자 users.id
 * @param files         multer 가 처리한 파일 배열
 */
export async function saveUploadedFiles(
  jobId:        string,
  divisionCode: string,
  userId:       string,
  files:        Express.Multer.File[]
): Promise<UploadedFileRow[]> {
  // report_jobs 없으면 PENDING 행 자동 생성 (크롤 시작 전 파일 먼저 올리는 경우 대응)
  const jobRows = await query<{ id: string }>(
    "SELECT id FROM report_jobs WHERE id = $1",
    [jobId]
  );
  if (!jobRows.length) {
    const divRows = await query<{ id: string }>(
      "SELECT id FROM divisions WHERE code = $1",
      [divisionCode]
    );
    if (!divRows.length) {
      throw new AppError(400, `알 수 없는 divisionCode 입니다: ${divisionCode}`);
    }
    await query(
      `INSERT INTO report_jobs (id, division_id, status, created_by)
       VALUES ($1, $2, 'PENDING', $3)`,
      [jobId, divRows[0].id, userId]
    );
  }

  const inserted: UploadedFileRow[] = [];

  for (const file of files) {
    const rows = await query<UploadedFileRow>(
      `INSERT INTO uploaded_files
         (report_job_id, original_name, stored_path, file_type, file_size)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, report_job_id, original_name, stored_path, file_type,
                 file_size, analysis_result, created_at`,
      [jobId, file.originalname, file.path, file.mimetype, file.size]
    );
    inserted.push(rows[0]);
  }

  return inserted;
}

// ── 고정명 저장 (upsert) ──────────────────────────────────────────────────────

/**
 * LHOUSE 전용 고정 파일명 업로드.
 *
 * 같은 jobId + originalName 레코드가 이미 있으면 덮어씁니다(물리 파일은
 * multer 가 이미 같은 경로에 저장했으므로 DB 레코드만 갱신).
 *
 * @param savedFilename  디스크에 저장된 최종 파일명 (e.g. "Activity.xlsx")
 */
export async function saveNamedUploadedFile(
  jobId:         string,
  divisionCode:  string,
  userId:        string,
  file:          Express.Multer.File,
  savedFilename: string,
): Promise<UploadedFileRow> {
  // report_jobs 없으면 자동 생성
  const jobRows = await query<{ id: string }>(
    "SELECT id FROM report_jobs WHERE id = $1",
    [jobId]
  );
  if (!jobRows.length) {
    const divRows = await query<{ id: string }>(
      "SELECT id FROM divisions WHERE code = $1",
      [divisionCode]
    );
    if (!divRows.length) throw new AppError(400, `알 수 없는 divisionCode: ${divisionCode}`);
    await query(
      `INSERT INTO report_jobs (id, division_id, status, created_by)
       VALUES ($1, $2, 'PENDING', $3)`,
      [jobId, divRows[0].id, userId]
    );
  }

  // 같은 (report_job_id, original_name) 레코드가 있으면 UPDATE, 없으면 INSERT
  const existing = await query<{ id: string }>(
    "SELECT id FROM uploaded_files WHERE report_job_id = $1 AND original_name = $2",
    [jobId, savedFilename]
  );

  if (existing.length) {
    const rows = await query<UploadedFileRow>(
      `UPDATE uploaded_files
       SET stored_path = $1, file_type = $2, file_size = $3,
           analysis_result = NULL, created_at = NOW()
       WHERE id = $4
       RETURNING id, report_job_id, original_name, stored_path,
                 file_type, file_size, analysis_result, created_at`,
      [file.path, file.mimetype, file.size, existing[0].id]
    );
    logger.info(`[FileService] Named file updated: ${savedFilename} (${existing[0].id})`);
    return rows[0];
  }

  const rows = await query<UploadedFileRow>(
    `INSERT INTO uploaded_files
       (report_job_id, original_name, stored_path, file_type, file_size)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, report_job_id, original_name, stored_path,
               file_type, file_size, analysis_result, created_at`,
    [jobId, savedFilename, file.path, file.mimetype, file.size]
  );
  logger.info(`[FileService] Named file created: ${savedFilename} (${rows[0].id})`);
  return rows[0];
}

// ── 삭제 ─────────────────────────────────────────────────────────────────────

/**
 * 파일 레코드와 실제 파일을 함께 삭제합니다.
 * 실제 파일이 없어도 DB 레코드 삭제는 진행합니다.
 */
export async function deleteFile(fileId: string): Promise<void> {
  const rows = await query<{ stored_path: string }>(
    "SELECT stored_path FROM uploaded_files WHERE id = $1",
    [fileId]
  );
  if (!rows.length) throw new AppError(404, "파일을 찾을 수 없습니다.");

  const { stored_path } = rows[0];

  try {
    fs.unlinkSync(stored_path);
  } catch (e) {
    // 파일이 이미 없거나 권한 오류 → 경고만 남기고 계속
    logger.warn(
      `[FileService] 파일 물리 삭제 실패 (무시): ${stored_path} — ${(e as Error).message}`
    );
  }

  await query("DELETE FROM uploaded_files WHERE id = $1", [fileId]);
  logger.info(`[FileService] File deleted: ${fileId}`);
}

// ── 분석 트리거 ───────────────────────────────────────────────────────────────

/**
 * 업로드 완료 후 분석을 백그라운드에서 시작합니다. (fire-and-forget)
 *
 * 현재는 analysis_result 에 { status: "pending" } 를 기록하고
 * 실제 분석 엔진 호출을 TODO 로 남깁니다.
 */
export function triggerAnalysis(fileIds: string[]): void {
  void runAnalysisInBackground(fileIds);
}

async function runAnalysisInBackground(fileIds: string[]): Promise<void> {
  for (const fileId of fileIds) {
    // ── 파일 메타 조회 ────────────────────────────────────────────────────────
    const rows = await query<{ stored_path: string; file_type: string }>(
      "SELECT stored_path, file_type FROM uploaded_files WHERE id = $1",
      [fileId]
    ).catch(() => [] as { stored_path: string; file_type: string }[]);

    if (!rows.length) {
      logger.warn(`[FileService] Analysis skipped — file not found: ${fileId}`);
      continue;
    }

    const { stored_path, file_type } = rows[0];

    // ── 분석 시작 상태 기록 ───────────────────────────────────────────────────
    const pending: StoredAnalysisResult = { status: "pending", analyzedAt: new Date().toISOString() };
    await query(
      "UPDATE uploaded_files SET analysis_result = $1 WHERE id = $2",
      [JSON.stringify(pending), fileId]
    ).catch((e: Error) => logger.warn(`[FileService] DB pending update failed: ${e.message}`));

    logger.info(`[FileService] Analysis started: ${fileId} (${file_type})`);

    try {
      // ── 실제 분석 엔진 호출 ────────────────────────────────────────────────
      const result = await analyze(stored_path, file_type);

      const completed: StoredAnalysisResult = {
        status:      "completed",
        analyzedAt:  new Date().toISOString(),
        result,
      };

      await query(
        "UPDATE uploaded_files SET analysis_result = $1 WHERE id = $2",
        [JSON.stringify(completed), fileId]
      );

      logger.info(`[FileService] Analysis completed: ${fileId}`);

    } catch (err) {
      const errMsg = (err as Error).message;
      logger.error(`[FileService] Analysis failed for ${fileId}: ${errMsg}`);

      const failed: StoredAnalysisResult = {
        status:     "failed",
        analyzedAt: new Date().toISOString(),
        error:      errMsg,
      };

      await query(
        "UPDATE uploaded_files SET analysis_result = $1 WHERE id = $2",
        [JSON.stringify(failed), fileId]
      ).catch(() => {/* ignore secondary failure */});
    }
  }
}
