/**
 * Crawl Service
 *
 * ─ 역할 ───────────────────────────────────────────────────────────────────────
 *  1. DB 조작 : report_jobs upsert, crawl_tasks CRUD
 *  2. 백그라운드 실행 : 각 시스템 크롤러를 순서대로 실행 (SSE 연결과 독립적)
 *  3. 이벤트 발행 : jobEventBus 를 통해 SSE 구독자에게 진행 상태 전달
 */

import path                         from "path";
import fs                          from "fs";
import { query, withTransaction }  from "../../config/db";
import { logger }                  from "../../utils/logger";
import { CrawlerFactory }          from "../../engines/playwright/CrawlerFactory";
import type {
  DivisionCode,
  ScreenshotOptions,
}                                  from "../../engines/playwright/types";
import { jobEventBus }             from "./crawl.events";
import { AppError }                from "../../utils/errors";

// ── 내부 타입 ─────────────────────────────────────────────────────────────────

interface StartCrawlJobParams {
  divisionCode: DivisionCode;
  jobId:        string;       // report_jobs.id (클라이언트가 제공하거나 신규 생성)
  userId:       string;       // users.id — created_by
}

interface CrawlTaskRow {
  id:         string;
  system_name: string;
  status:     string;
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * 크롤 잡을 시작합니다.
 *
 * 1. divisions 에서 division_id 조회
 * 2. report_jobs 레코드 생성 (또는 기존 레코드 재사용)
 * 3. CrawlerFactory.listAvailable() 로 시스템 목록 조회
 * 4. crawl_tasks 레코드 일괄 생성 (PENDING)
 * 5. runInBackground() 로 비동기 실행 시작 (await 하지 않음)
 *
 * @returns 생성된 crawl_task 레코드 배열
 */
export async function startCrawlJob(
  params: StartCrawlJobParams
): Promise<CrawlTaskRow[]> {
  const { divisionCode, jobId, userId } = params;

  // ── 1. 사업부 ID 조회 ─────────────────────────────────────────────────────
  const divRows = await query<{ id: string }>(
    "SELECT id FROM divisions WHERE code = $1",
    [divisionCode]
  );
  if (!divRows.length) {
    throw new AppError(400, `알 수 없는 사업부 코드: ${divisionCode}`);
  }
  const divisionId = divRows[0].id;

  // ── 2. 크롤러 목록 ────────────────────────────────────────────────────────
  const available = CrawlerFactory.listAvailable();
  const systems   = available[divisionCode];
  if (!systems?.length) {
    throw new AppError(400, `[${divisionCode}] 등록된 크롤러가 없습니다.`);
  }

  // ── 3. DB 트랜잭션: report_jobs upsert + crawl_tasks insert ──────────────
  const tasks = await withTransaction(async (client) => {
    // report_jobs: 이미 존재하면 RUNNING 으로 갱신, 없으면 생성
    // ON CONFLICT 대신 SELECT → UPDATE/INSERT 로 처리 (unique constraint 의존 제거)
    const { rows: existingJob } = await client.query<{ id: string }>(
      "SELECT id FROM report_jobs WHERE id = $1",
      [jobId]
    );
    if (existingJob.length) {
      await client.query(
        `UPDATE report_jobs
         SET status = 'RUNNING', started_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [jobId]
      );
    } else {
      await client.query(
        `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
         VALUES ($1, $2, 'RUNNING', NOW(), $3)`,
        [jobId, divisionId, userId]
      );
    }

    // crawl_tasks: 시스템별 PENDING 레코드 생성 (중복 실행 방지: 기존 레코드 유지)
    const inserted: CrawlTaskRow[] = [];
    for (const systemName of systems) {
      const { rows: existing } = await client.query<{ id: string }>(
        "SELECT id FROM crawl_tasks WHERE report_job_id = $1 AND system_name = $2",
        [jobId, systemName]
      );
      if (existing.length) continue;   // 이미 있으면 건너뜀

      const { rows } = await client.query<CrawlTaskRow>(
        `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
         VALUES ($1, $2, 'DOWNLOAD', 'PENDING')
         RETURNING id, system_name, status`,
        [jobId, systemName]
      );
      if (rows.length) inserted.push(rows[0]);
    }

    return inserted;
  });

  // ── 4. 백그라운드 실행 (fire-and-forget) ──────────────────────────────────
  // void: SSE 연결과 독립적으로 실행. 에러는 내부에서 로그.
  void runInBackground(divisionCode, jobId, systems);

  logger.info(`[CrawlService] Job started: ${jobId} (${divisionCode}, ${systems.length} systems)`);
  return tasks;
}

/**
 * job 상태 조회 — SSE 연결 전 현재 진행 상황 확인용
 */
export async function getCrawlJobStatus(jobId: string) {
  const tasks = await query<{
    id: string;
    system_name: string;
    status: string;
    result_path: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, system_name, status, result_path, error, created_at, updated_at
     FROM crawl_tasks
     WHERE report_job_id = $1
     ORDER BY created_at`,
    [jobId]
  );

  const job = await query<{
    status: string;
    started_at: string | null;
    completed_at: string | null;
  }>(
    "SELECT status, started_at, completed_at FROM report_jobs WHERE id = $1",
    [jobId]
  );

  return { job: job[0] ?? null, tasks };
}

// ── 스크린샷 잡 ───────────────────────────────────────────────────────────────

/** POST /api/crawl/screenshot 에서 받는 설정 (outputPath 는 서버가 결정) */
export interface ScreenshotConfig {
  url:       string;
  selector?: string;
  fullPage?: boolean;
  width?:    number;
  height?:   number;
}

/**
 * 스크린샷 태스크를 생성하고 비동기로 실행합니다.
 *
 * 1. crawl_tasks 레코드 생성 (task_type = 'SCREENSHOT')
 * 2. 백그라운드에서 CrawlerFactory.screenshot() 실행
 * 3. 완료 시 SSE screenshot_done / screenshot_error 이벤트 발행
 */
export async function takeScreenshotJob(params: {
  jobId:        string;
  divisionCode: DivisionCode;
  systemName:   string;
  config:       ScreenshotConfig;
  userId:       string;
}): Promise<{ taskId: string }> {
  const { jobId, divisionCode, systemName, config, userId } = params;

  // ── 사업부 조회 + report_jobs upsert ─────────────────────────────────────
  const divRows = await query<{ id: string }>(
    "SELECT id FROM divisions WHERE code = $1",
    [divisionCode]
  );
  if (!divRows.length) throw new AppError(400, `알 수 없는 사업부 코드: ${divisionCode}`);
  const divisionId = divRows[0].id;

  // ── crawl_tasks 레코드 생성 ─────────────────────────────────────────────
  const taskRows = await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
       VALUES ($1, $2, 'RUNNING', NOW(), $3)
       ON DUPLICATE KEY UPDATE status = 'RUNNING', updated_at = NOW()`,
      [jobId, divisionId, userId]
    );

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
       VALUES ($1, $2, 'SCREENSHOT', 'PENDING')
       ON DUPLICATE KEY UPDATE
         task_type = 'SCREENSHOT', status = 'PENDING', updated_at = NOW()
       RETURNING id`,
      [jobId, systemName]
    );
    return rows;
  });

  const taskId = taskRows[0].id;

  // ── outputPath 결정 ─────────────────────────────────────────────────────
  const uploadDir = process.env.UPLOAD_DIR ?? "uploads";
  const filename  = `screenshot_${systemName}_${Date.now()}.png`;
  const outputPath = path.resolve(uploadDir, jobId, filename);

  const options: ScreenshotOptions = { ...config, outputPath };

  // ── 백그라운드 실행 (fire-and-forget) ──────────────────────────────────
  void runScreenshotInBackground({ jobId, taskId, divisionCode, systemName, options });

  logger.info(`[CrawlService] Screenshot task created: ${taskId} (${divisionCode}/${systemName})`);
  return { taskId };
}

async function runScreenshotInBackground(params: {
  jobId:        string;
  taskId:       string;
  divisionCode: DivisionCode;
  systemName:   string;
  options:      ScreenshotOptions;
}): Promise<void> {
  const { jobId, taskId, divisionCode, systemName, options } = params;

  // crawl_tasks → RUNNING
  await query(
    `UPDATE crawl_tasks SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`,
    [taskId]
  ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

  try {
    const result = await CrawlerFactory.screenshot(
      divisionCode,
      systemName,
      jobId,
      options,
      (event) => {
        if (event.percent !== undefined) {
          jobEventBus.emit(jobId, {
            type:       "progress",
            systemName,
            percent:    event.percent,
          });
        }
      }
    );

    // crawl_tasks → COMPLETED
    await query(
      `UPDATE crawl_tasks
       SET status = 'COMPLETED', result_path = $1, updated_at = NOW()
       WHERE id = $2`,
      [result.path, taskId]
    ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

    // SSE: screenshot_done
    jobEventBus.emit(jobId, {
      type:              "screenshot_done",
      systemName,
      screenshotPath:    result.path,
      screenshotWidth:   result.width,
      screenshotHeight:  result.height,
      capturedAt:        result.capturedAt,
    });

    logger.info(`[CrawlService] Screenshot done: ${result.path}`);

  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error(`[CrawlService] Screenshot failed: ${systemName} — ${errMsg}`);

    await query(
      `UPDATE crawl_tasks SET status = 'FAILED', error = $1, updated_at = NOW() WHERE id = $2`,
      [errMsg, taskId]
    ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

    // SSE: screenshot_error
    jobEventBus.emit(jobId, {
      type:       "screenshot_error",
      systemName,
      error:      errMsg,
    });
  }

  jobEventBus.scheduleCleanup(jobId);
}

// ── DEV GCP Activity 리포트 Export 잡 ────────────────────────────────────────────
// LHOUSE 시스템 조회와 동일하게, GCP Quality System 의 Activity (Task) Count 리포트를
// Excel 로 export 해 uploads/Activity_GCP.xlsx 로 저장 + uploaded_files 자동 등록.

const GCP_ACTIVITY_SYSTEM = "GCP_ACTIVITY";
const GCP_ACTIVITY_DIV    = "DEV" as const;

export async function startGcpActivityExport(params: {
  jobId:  string;
  userId: string;
}): Promise<{ taskId: string }> {
  const { jobId, userId } = params;

  const divRows = await query<{ id: string }>(
    "SELECT id FROM divisions WHERE code = $1",
    [GCP_ACTIVITY_DIV]
  );
  if (!divRows.length) throw new AppError(400, "DEV 사업부를 찾을 수 없습니다.");
  const divisionId = divRows[0].id;

  await query(
    `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
     VALUES ($1, $2, 'RUNNING', NOW(), $3)
     ON DUPLICATE KEY UPDATE status = 'RUNNING', updated_at = NOW()`,
    [jobId, divisionId, userId]
  );

  const crawlTaskResult = await query<{ id: string }>(
    `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
     VALUES ($1, $2, 'DOWNLOAD', 'PENDING')
     ON DUPLICATE KEY UPDATE task_type = 'DOWNLOAD', status = 'PENDING', updated_at = NOW()
     RETURNING id`,
    [jobId, GCP_ACTIVITY_SYSTEM]
  );
  const taskId = crawlTaskResult[0].id;

  void runGcpActivityInBackground(jobId, taskId);

  logger.info(`[CrawlService] GCP Activity export started: job=${jobId}, task=${taskId}`);
  return { taskId };
}

async function runGcpActivityInBackground(jobId: string, taskId: string): Promise<boolean> {
  let succeeded = false;
  jobEventBus.emit(jobId, { type: "task_start", systemName: GCP_ACTIVITY_SYSTEM, total: 1 });

  await query(
    `UPDATE crawl_tasks SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`,
    [taskId]
  ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

  try {
    const result = await CrawlerFactory.runSingle(
      GCP_ACTIVITY_SYSTEM,
      jobId,
      (event) => {
        if (event.percent !== undefined || event.message) {
          jobEventBus.emit(jobId, {
            type:       "progress",
            systemName: GCP_ACTIVITY_SYSTEM,
            percent:    event.percent,
            message:    event.message,
          });
        }
      }
    );

    // 크롤러가 이미 uploads/Activity_GCP.xlsx 로 저장함. 화면/보고서가 참조하는
    // uploaded_files 에 등록해 "Activity (Task) Count - GCP Quality System" 슬롯에 반영.
    const resultPath = result.files[0] ?? null;
    if (resultPath && fs.existsSync(resultPath)) {
      try {
        const fileSize = fs.statSync(resultPath).size;
        const mime     = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        const existing = await query<{ id: string }>(
          `SELECT id FROM uploaded_files
           WHERE report_job_id = $1 AND original_name = 'Activity_GCP.xlsx'
           ORDER BY created_at DESC LIMIT 1`,
          [jobId]
        );
        if (existing.length) {
          await query(
            `UPDATE uploaded_files
             SET stored_path = $1, file_type = $2, file_size = $3,
                 analysis_result = '{}', created_at = NOW()
             WHERE id = $4`,
            [resultPath, mime, fileSize, existing[0].id]
          );
          logger.info(`[CrawlService] GCP Activity replaced: ${resultPath}`);
        } else {
          await query(
            `INSERT INTO uploaded_files
               (report_job_id, original_name, stored_path, file_type, file_size)
             VALUES ($1, 'Activity_GCP.xlsx', $2, $3, $4)`,
            [jobId, resultPath, mime, fileSize]
          );
          logger.info(`[CrawlService] GCP Activity saved: ${resultPath}`);
        }
      } catch (saveErr) {
        logger.warn(`[CrawlService] GCP Activity 파일 등록 실패 (무시): ${(saveErr as Error).message}`);
      }
    }

    await query(
      `UPDATE crawl_tasks SET status = 'COMPLETED', result_path = $1, updated_at = NOW() WHERE id = $2`,
      [resultPath, taskId]
    ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

    jobEventBus.emit(jobId, { type: "task_done", systemName: GCP_ACTIVITY_SYSTEM, filePaths: result.files });
    logger.info(`[CrawlService] GCP Activity export done: ${resultPath}`);
    succeeded = true;

  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error(`[CrawlService] GCP Activity export failed: ${errMsg}`);
    await query(
      `UPDATE crawl_tasks SET status = 'FAILED', error = $1, updated_at = NOW() WHERE id = $2`,
      [errMsg, taskId]
    ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_error", systemName: GCP_ACTIVITY_SYSTEM, error: errMsg });
  }

  jobEventBus.scheduleCleanup(jobId);
  return succeeded;
}

// ── DEV GCP 데이터 수집 잡 (3개 리포트 Excel export → uploads/ + uploaded_files) ──

const GCP_DATA_SYSTEM = "GCP_DATA";
const GCP_DATA_DIV    = "DEV" as const;
const GCP_XLSX_MIME   = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const GCP_REPORTS: { key: string; file: string; label: string }[] = [
  { key: "GCP_PERFSTATS", file: "GCP_PerfStats.xlsx", label: "Performance Statistics" },
  { key: "GCP_QUALITY",   file: "GCP_Quality.xlsx",   label: "Quality Events" },
  { key: "GCP_TRAINING",  file: "GCP_Training.xlsx",   label: "Training" },
];

export async function startGcpDataCollection(params: {
  jobId:  string;
  userId: string;
}): Promise<{ taskId: string }> {
  const { jobId, userId } = params;

  const divRows = await query<{ id: string }>(
    "SELECT id FROM divisions WHERE code = $1", [GCP_DATA_DIV]
  );
  if (!divRows.length) throw new AppError(400, "DEV 사업부를 찾을 수 없습니다.");

  await query(
    `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
     VALUES ($1, $2, 'RUNNING', NOW(), $3)
     ON DUPLICATE KEY UPDATE status = 'RUNNING', updated_at = NOW()`,
    [jobId, divRows[0].id, userId]
  );

  const taskRows = await query<{ id: string }>(
    `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
     VALUES ($1, $2, 'DOWNLOAD', 'PENDING')
     ON DUPLICATE KEY UPDATE task_type = 'DOWNLOAD', status = 'PENDING', updated_at = NOW()
     RETURNING id`,
    [jobId, GCP_DATA_SYSTEM]
  );
  const taskId = taskRows[0].id;

  void runGcpDataInBackground(jobId, taskId);

  logger.info(`[CrawlService] GCP 데이터 수집 시작: job=${jobId}, task=${taskId}`);
  return { taskId };
}

async function registerGcpNamedFile(jobId: string, file: string): Promise<void> {
  const uploadDir = process.env.UPLOAD_DIR ?? "uploads";
  const filePath  = path.resolve(uploadDir, jobId, "uploads", file);
  if (!fs.existsSync(filePath)) return;
  const fileSize = fs.statSync(filePath).size;
  const existing = await query<{ id: string }>(
    `SELECT id FROM uploaded_files WHERE report_job_id = $1 AND original_name = $2
     ORDER BY created_at DESC LIMIT 1`,
    [jobId, file]
  );
  if (existing.length) {
    await query(
      `UPDATE uploaded_files
       SET stored_path = $1, file_type = $2, file_size = $3, analysis_result = '{}', created_at = NOW()
       WHERE id = $4`,
      [filePath, GCP_XLSX_MIME, fileSize, existing[0].id]
    );
  } else {
    await query(
      `INSERT INTO uploaded_files (report_job_id, original_name, stored_path, file_type, file_size)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, file, filePath, GCP_XLSX_MIME, fileSize]
    );
  }
  logger.info(`[CrawlService] GCP 데이터 등록: ${file} (${fileSize.toLocaleString()} bytes)`);
}

async function runGcpDataInBackground(jobId: string, taskId: string): Promise<boolean> {
  jobEventBus.emit(jobId, { type: "task_start", systemName: GCP_DATA_SYSTEM, total: 1 });
  await query(`UPDATE crawl_tasks SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [taskId])
    .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

  let okCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < GCP_REPORTS.length; i++) {
    const rep = GCP_REPORTS[i];
    jobEventBus.emit(jobId, {
      type:       "progress",
      systemName: GCP_DATA_SYSTEM,
      percent:    Math.round((i / GCP_REPORTS.length) * 100),
      message:    `${rep.label} 수집 중… (${i + 1}/${GCP_REPORTS.length})`,
    });
    try {
      await CrawlerFactory.runSingle(rep.key, jobId, (event) => {
        if (event.percent !== undefined || event.message) {
          jobEventBus.emit(jobId, {
            type:       "progress",
            systemName: GCP_DATA_SYSTEM,
            message:    `[${rep.label}] ${event.message ?? ""}`,
          });
        }
      });
      await registerGcpNamedFile(jobId, rep.file);
      okCount++;
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`${rep.label}: ${msg}`);
      logger.error(`[CrawlService] GCP ${rep.label} 실패: ${msg}`);
    }
  }

  if (okCount > 0) {
    await query(`UPDATE crawl_tasks SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`, [taskId])
      .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_done", systemName: GCP_DATA_SYSTEM, filePaths: [] });
    logger.info(`[CrawlService] GCP 데이터 수집 완료: ${okCount}/${GCP_REPORTS.length}` +
      (errors.length ? ` (실패: ${errors.join("; ")})` : ""));
  } else {
    const msg = errors.join("; ") || "수집 실패";
    await query(`UPDATE crawl_tasks SET status = 'FAILED', error = $1, updated_at = NOW() WHERE id = $2`, [msg, taskId])
      .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_error", systemName: GCP_DATA_SYSTEM, error: msg });
  }

  jobEventBus.scheduleCleanup(jobId);
  return okCount > 0;
}

// ── L HOUSE Veeva 데이터 수집 잡 (PerfStats/Quality xlsx + Training json → uploads/ + uploaded_files) ──

const LHOUSE_DATA_SYSTEM = "LHOUSE_DATA";
const LHOUSE_DATA_DIV    = "LHOUSE" as const;
const LHOUSE_JSON_MIME   = "application/json";

const LHOUSE_REPORTS: { key: string; file: string; label: string }[] = [
  { key: "LHOUSE_PERFSTATS", file: "LHOUSE_PerfStats.xlsx", label: "Performance Statistics" },
  { key: "LHOUSE_QUALITY",   file: "LHOUSE_Quality.xlsx",   label: "Quality Events" },
  { key: "LHOUSE_TRAINING",  file: "LHOUSE_Training.json",  label: "Training" },
];

export async function startLhouseDataCollection(params: {
  jobId:  string;
  userId: string;
}): Promise<{ taskId: string }> {
  const { jobId, userId } = params;

  const divRows = await query<{ id: string }>(
    "SELECT id FROM divisions WHERE code = $1", [LHOUSE_DATA_DIV]
  );
  if (!divRows.length) throw new AppError(400, "LHOUSE 사업부를 찾을 수 없습니다.");

  await query(
    `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
     VALUES ($1, $2, 'RUNNING', NOW(), $3)
     ON DUPLICATE KEY UPDATE status = 'RUNNING', updated_at = NOW()`,
    [jobId, divRows[0].id, userId]
  );

  const taskRows = await query<{ id: string }>(
    `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
     VALUES ($1, $2, 'DOWNLOAD', 'PENDING')
     ON DUPLICATE KEY UPDATE task_type = 'DOWNLOAD', status = 'PENDING', updated_at = NOW()
     RETURNING id`,
    [jobId, LHOUSE_DATA_SYSTEM]
  );
  const taskId = taskRows[0].id;

  void runLhouseDataInBackground(jobId, taskId);

  logger.info(`[CrawlService] LHOUSE 데이터 수집 시작: job=${jobId}, task=${taskId}`);
  return { taskId };
}

async function registerLhouseNamedFile(jobId: string, file: string): Promise<void> {
  const uploadDir = process.env.UPLOAD_DIR ?? "uploads";
  const filePath  = path.resolve(uploadDir, jobId, "uploads", file);
  if (!fs.existsSync(filePath)) return;
  const fileSize = fs.statSync(filePath).size;
  const mime     = file.endsWith(".json") ? LHOUSE_JSON_MIME : GCP_XLSX_MIME;
  const existing = await query<{ id: string }>(
    `SELECT id FROM uploaded_files WHERE report_job_id = $1 AND original_name = $2
     ORDER BY created_at DESC LIMIT 1`,
    [jobId, file]
  );
  if (existing.length) {
    await query(
      `UPDATE uploaded_files
       SET stored_path = $1, file_type = $2, file_size = $3, analysis_result = '{}', created_at = NOW()
       WHERE id = $4`,
      [filePath, mime, fileSize, existing[0].id]
    );
  } else {
    await query(
      `INSERT INTO uploaded_files (report_job_id, original_name, stored_path, file_type, file_size)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, file, filePath, mime, fileSize]
    );
  }
  logger.info(`[CrawlService] LHOUSE 데이터 등록: ${file} (${fileSize.toLocaleString()} bytes)`);
}

async function runLhouseDataInBackground(jobId: string, taskId: string): Promise<boolean> {
  jobEventBus.emit(jobId, { type: "task_start", systemName: LHOUSE_DATA_SYSTEM, total: 1 });
  await query(`UPDATE crawl_tasks SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [taskId])
    .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

  let okCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < LHOUSE_REPORTS.length; i++) {
    const rep = LHOUSE_REPORTS[i];
    jobEventBus.emit(jobId, {
      type:       "progress",
      systemName: LHOUSE_DATA_SYSTEM,
      percent:    Math.round((i / LHOUSE_REPORTS.length) * 100),
      message:    `${rep.label} 수집 중… (${i + 1}/${LHOUSE_REPORTS.length})`,
    });
    try {
      await CrawlerFactory.runSingle(rep.key, jobId, (event) => {
        if (event.percent !== undefined || event.message) {
          jobEventBus.emit(jobId, {
            type:       "progress",
            systemName: LHOUSE_DATA_SYSTEM,
            message:    `[${rep.label}] ${event.message ?? ""}`,
          });
        }
      });
      await registerLhouseNamedFile(jobId, rep.file);
      okCount++;
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`${rep.label}: ${msg}`);
      logger.error(`[CrawlService] LHOUSE ${rep.label} 실패: ${msg}`);
    }
  }

  if (okCount > 0) {
    await query(`UPDATE crawl_tasks SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`, [taskId])
      .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_done", systemName: LHOUSE_DATA_SYSTEM, filePaths: [] });
    logger.info(`[CrawlService] LHOUSE 데이터 수집 완료: ${okCount}/${LHOUSE_REPORTS.length}` +
      (errors.length ? ` (실패: ${errors.join("; ")})` : ""));
  } else {
    const msg = errors.join("; ") || "수집 실패";
    await query(`UPDATE crawl_tasks SET status = 'FAILED', error = $1, updated_at = NOW() WHERE id = $2`, [msg, taskId])
      .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_error", systemName: LHOUSE_DATA_SYSTEM, error: msg });
  }

  jobEventBus.scheduleCleanup(jobId);
  return okCount > 0;
}

// ── BIO 연구본부 Veeva 데이터 수집 잡 (Activity/PerfStats/DocType 화면 스크래핑 → json) ──

const BIO_DATA_SYSTEM = "BIO_DATA";
const BIO_DATA_DIV    = "BIO" as const;
const BIO_JSON_MIME   = "application/json";

const BIO_REPORTS: { key: string; file: string; label: string }[] = [
  { key: "BIO_ACTIVITY",  file: "BIO_Activity.json",  label: "업무 활용(Activity)" },
  { key: "BIO_PERFSTATS", file: "BIO_PerfStats.xlsx", label: "Performance Statistics" },
  { key: "BIO_DOCTYPE",   file: "BIO_DocType.json",   label: "생성 문서 구분" },
];

export async function startBioDataCollection(params: {
  jobId:  string;
  userId: string;
}): Promise<{ taskId: string }> {
  const { jobId, userId } = params;

  const divRows = await query<{ id: string }>(
    "SELECT id FROM divisions WHERE code = $1", [BIO_DATA_DIV]
  );
  if (!divRows.length) throw new AppError(400, "BIO 사업부를 찾을 수 없습니다.");

  // 재시도 대비: 이전 실행의 이벤트 히스토리를 비운다.
  jobEventBus.resetHistory(jobId);

  await query(
    `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
     VALUES ($1, $2, 'RUNNING', NOW(), $3)
     ON DUPLICATE KEY UPDATE status = 'RUNNING', updated_at = NOW()`,
    [jobId, divRows[0].id, userId]
  );

  const taskRows = await query<{ id: string }>(
    `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
     VALUES ($1, $2, 'DOWNLOAD', 'PENDING')
     ON DUPLICATE KEY UPDATE task_type = 'DOWNLOAD', status = 'PENDING', updated_at = NOW()
     RETURNING id`,
    [jobId, BIO_DATA_SYSTEM]
  );
  const taskId = taskRows[0].id;

  void runBioDataInBackground(jobId, taskId);

  logger.info(`[CrawlService] BIO 데이터 수집 시작: job=${jobId}, task=${taskId}`);
  return { taskId };
}

async function registerBioNamedFile(jobId: string, file: string): Promise<void> {
  const uploadDir = process.env.UPLOAD_DIR ?? "uploads";
  const filePath  = path.resolve(uploadDir, jobId, "uploads", file);
  if (!fs.existsSync(filePath)) return;
  const fileSize = fs.statSync(filePath).size;
  const mime     = file.endsWith(".xlsx") ? GCP_XLSX_MIME : BIO_JSON_MIME;
  const existing = await query<{ id: string }>(
    `SELECT id FROM uploaded_files WHERE report_job_id = $1 AND original_name = $2
     ORDER BY created_at DESC LIMIT 1`,
    [jobId, file]
  );
  if (existing.length) {
    await query(
      `UPDATE uploaded_files
       SET stored_path = $1, file_type = $2, file_size = $3, analysis_result = '{}', created_at = NOW()
       WHERE id = $4`,
      [filePath, mime, fileSize, existing[0].id]
    );
  } else {
    await query(
      `INSERT INTO uploaded_files (report_job_id, original_name, stored_path, file_type, file_size)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, file, filePath, mime, fileSize]
    );
  }
  logger.info(`[CrawlService] BIO 데이터 등록: ${file} (${fileSize.toLocaleString()} bytes)`);
}

async function runBioDataInBackground(jobId: string, taskId: string): Promise<boolean> {
  jobEventBus.emit(jobId, { type: "task_start", systemName: BIO_DATA_SYSTEM, total: 1 });
  await query(`UPDATE crawl_tasks SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [taskId])
    .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

  let okCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < BIO_REPORTS.length; i++) {
    const rep = BIO_REPORTS[i];
    jobEventBus.emit(jobId, {
      type:       "progress",
      systemName: BIO_DATA_SYSTEM,
      percent:    Math.round((i / BIO_REPORTS.length) * 100),
      message:    `${rep.label} 수집 중… (${i + 1}/${BIO_REPORTS.length})`,
    });
    try {
      await CrawlerFactory.runSingle(rep.key, jobId, (event) => {
        if (event.percent !== undefined || event.message) {
          jobEventBus.emit(jobId, {
            type:       "progress",
            systemName: BIO_DATA_SYSTEM,
            message:    `[${rep.label}] ${event.message ?? ""}`,
          });
        }
      });
      await registerBioNamedFile(jobId, rep.file);
      okCount++;
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`${rep.label}: ${msg}`);
      logger.error(`[CrawlService] BIO ${rep.label} 실패: ${msg}`);
    }
  }

  if (okCount > 0) {
    await query(`UPDATE crawl_tasks SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`, [taskId])
      .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_done", systemName: BIO_DATA_SYSTEM, filePaths: [] });
    logger.info(`[CrawlService] BIO 데이터 수집 완료: ${okCount}/${BIO_REPORTS.length}` +
      (errors.length ? ` (실패: ${errors.join("; ")})` : ""));
  } else {
    const msg = errors.join("; ") || "수집 실패";
    await query(`UPDATE crawl_tasks SET status = 'FAILED', error = $1, updated_at = NOW() WHERE id = $2`, [msg, taskId])
      .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_error", systemName: BIO_DATA_SYSTEM, error: msg });
  }

  jobEventBus.scheduleCleanup(jobId);
  return okCount > 0;
}

/** 무인(cron) 실행용 — BIO 수집 완료까지 기다린 뒤 결과 반환 */
export async function runBioCollectAwait(params: {
  jobId:  string;
  userId: string;
}): Promise<CollectAllResult> {
  const { jobId, userId } = params;

  const divRows = await query<{ id: string }>(
    "SELECT id FROM divisions WHERE code = $1", [BIO_DATA_DIV]
  );
  if (!divRows.length) throw new AppError(400, "BIO 사업부를 찾을 수 없습니다.");

  jobEventBus.resetHistory(jobId);

  await query(
    `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
     VALUES ($1, $2, 'RUNNING', NOW(), $3)
     ON DUPLICATE KEY UPDATE status = 'RUNNING', updated_at = NOW()`,
    [jobId, divRows[0].id, userId]
  );

  const taskRows = await query<{ id: string }>(
    `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
     VALUES ($1, $2, 'DOWNLOAD', 'PENDING')
     ON DUPLICATE KEY UPDATE task_type = 'DOWNLOAD', status = 'PENDING', updated_at = NOW()
     RETURNING id`,
    [jobId, BIO_DATA_SYSTEM]
  );

  logger.info(`[CrawlService] BIO 자동 수집 시작 (대기): job=${jobId}`);
  const ok = await runBioDataInBackground(jobId, taskRows[0].id);
  return { ok, results: { [BIO_DATA_SYSTEM]: ok }, failedAt: ok ? null : BIO_DATA_SYSTEM };
}

// ── DEV Medcomms 데이터 수집 잡 (4개 리포트 Excel export → uploads/ + uploaded_files) ──

const MEDCOMMS_DATA_SYSTEM = "MEDCOMMS_DATA";

const MEDCOMMS_REPORTS: { key: string; file: string; label: string }[] = [
  { key: "MEDCOMMS_DOCTYPE",   file: "Medcomms_DocType.xlsx",   label: "생성 문서 구분" },
  { key: "MEDCOMMS_PERFSTATS", file: "Medcomms_PerfStats.xlsx", label: "Performance Statistics" },
  { key: "MEDCOMMS_ACTIVITY",  file: "Medcomms_Activity.xlsx",  label: "업무 활용" },
  { key: "MEDCOMMS_REVIEW",    file: "Medcomms_Review.xlsx",    label: "문서 리뷰 시간" },
];

export async function startMedcommsDataCollection(params: {
  jobId:  string;
  userId: string;
}): Promise<{ taskId: string }> {
  const { jobId, userId } = params;

  const divRows = await query<{ id: string }>("SELECT id FROM divisions WHERE code = $1", ["DEV"]);
  if (!divRows.length) throw new AppError(400, "DEV 사업부를 찾을 수 없습니다.");

  await query(
    `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
     VALUES ($1, $2, 'RUNNING', NOW(), $3)
     ON DUPLICATE KEY UPDATE status = 'RUNNING', updated_at = NOW()`,
    [jobId, divRows[0].id, userId]
  );

  const taskRows = await query<{ id: string }>(
    `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
     VALUES ($1, $2, 'DOWNLOAD', 'PENDING')
     ON DUPLICATE KEY UPDATE task_type = 'DOWNLOAD', status = 'PENDING', updated_at = NOW()
     RETURNING id`,
    [jobId, MEDCOMMS_DATA_SYSTEM]
  );
  const taskId = taskRows[0].id;

  void runMedcommsDataInBackground(jobId, taskId);

  logger.info(`[CrawlService] Medcomms 데이터 수집 시작: job=${jobId}, task=${taskId}`);
  return { taskId };
}

async function runMedcommsDataInBackground(jobId: string, taskId: string): Promise<boolean> {
  jobEventBus.emit(jobId, { type: "task_start", systemName: MEDCOMMS_DATA_SYSTEM, total: 1 });
  await query(`UPDATE crawl_tasks SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [taskId])
    .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

  let okCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < MEDCOMMS_REPORTS.length; i++) {
    const rep = MEDCOMMS_REPORTS[i];
    jobEventBus.emit(jobId, {
      type:       "progress",
      systemName: MEDCOMMS_DATA_SYSTEM,
      percent:    Math.round((i / MEDCOMMS_REPORTS.length) * 100),
      message:    `${rep.label} 수집 중… (${i + 1}/${MEDCOMMS_REPORTS.length})`,
    });
    try {
      await CrawlerFactory.runSingle(rep.key, jobId, (event) => {
        if (event.percent !== undefined || event.message) {
          jobEventBus.emit(jobId, {
            type:       "progress",
            systemName: MEDCOMMS_DATA_SYSTEM,
            message:    `[${rep.label}] ${event.message ?? ""}`,
          });
        }
      });
      await registerGcpNamedFile(jobId, rep.file);   // 파일명 기반 등록(범용)
      okCount++;
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`${rep.label}: ${msg}`);
      logger.error(`[CrawlService] Medcomms ${rep.label} 실패: ${msg}`);
    }
  }

  if (okCount > 0) {
    await query(`UPDATE crawl_tasks SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`, [taskId])
      .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_done", systemName: MEDCOMMS_DATA_SYSTEM, filePaths: [] });
    logger.info(`[CrawlService] Medcomms 데이터 수집 완료: ${okCount}/${MEDCOMMS_REPORTS.length}` +
      (errors.length ? ` (실패: ${errors.join("; ")})` : ""));
  } else {
    const msg = errors.join("; ") || "수집 실패";
    await query(`UPDATE crawl_tasks SET status = 'FAILED', error = $1, updated_at = NOW() WHERE id = $2`, [msg, taskId])
      .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_error", systemName: MEDCOMMS_DATA_SYSTEM, error: msg });
  }

  jobEventBus.scheduleCleanup(jobId);
  return okCount > 0;
}

// ── DEV CTMS/eTMF 데이터 수집 잡 (2개 리포트 Excel export) ──────────────────────

const CTMS_DATA_SYSTEM = "CTMS_DATA";

const CTMS_REPORTS: { key: string; file: string; label: string }[] = [
  { key: "CTMS_PERFSTATS", file: "Clinical_PerfStats.xlsx", label: "Performance Statistics" },
  { key: "CTMS_STUDY",     file: "Clinical_Study.xlsx",     label: "Study별 사용자" },
];

export async function startCtmsDataCollection(params: {
  jobId:  string;
  userId: string;
}): Promise<{ taskId: string }> {
  const { jobId, userId } = params;

  const divRows = await query<{ id: string }>("SELECT id FROM divisions WHERE code = $1", ["DEV"]);
  if (!divRows.length) throw new AppError(400, "DEV 사업부를 찾을 수 없습니다.");

  await query(
    `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
     VALUES ($1, $2, 'RUNNING', NOW(), $3)
     ON DUPLICATE KEY UPDATE status = 'RUNNING', updated_at = NOW()`,
    [jobId, divRows[0].id, userId]
  );

  const taskRows = await query<{ id: string }>(
    `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
     VALUES ($1, $2, 'DOWNLOAD', 'PENDING')
     ON DUPLICATE KEY UPDATE task_type = 'DOWNLOAD', status = 'PENDING', updated_at = NOW()
     RETURNING id`,
    [jobId, CTMS_DATA_SYSTEM]
  );
  const taskId = taskRows[0].id;

  void runCtmsDataInBackground(jobId, taskId);

  logger.info(`[CrawlService] CTMS 데이터 수집 시작: job=${jobId}, task=${taskId}`);
  return { taskId };
}

async function runCtmsDataInBackground(jobId: string, taskId: string): Promise<boolean> {
  jobEventBus.emit(jobId, { type: "task_start", systemName: CTMS_DATA_SYSTEM, total: 1 });
  await query(`UPDATE crawl_tasks SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [taskId])
    .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

  let okCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < CTMS_REPORTS.length; i++) {
    const rep = CTMS_REPORTS[i];
    jobEventBus.emit(jobId, {
      type:       "progress",
      systemName: CTMS_DATA_SYSTEM,
      percent:    Math.round((i / CTMS_REPORTS.length) * 100),
      message:    `${rep.label} 수집 중… (${i + 1}/${CTMS_REPORTS.length})`,
    });
    try {
      await CrawlerFactory.runSingle(rep.key, jobId, (event) => {
        if (event.percent !== undefined || event.message) {
          jobEventBus.emit(jobId, {
            type:       "progress",
            systemName: CTMS_DATA_SYSTEM,
            message:    `[${rep.label}] ${event.message ?? ""}`,
          });
        }
      });
      await registerGcpNamedFile(jobId, rep.file);
      okCount++;
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`${rep.label}: ${msg}`);
      logger.error(`[CrawlService] CTMS ${rep.label} 실패: ${msg}`);
    }
  }

  if (okCount > 0) {
    await query(`UPDATE crawl_tasks SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`, [taskId])
      .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_done", systemName: CTMS_DATA_SYSTEM, filePaths: [] });
    logger.info(`[CrawlService] CTMS 데이터 수집 완료: ${okCount}/${CTMS_REPORTS.length}` +
      (errors.length ? ` (실패: ${errors.join("; ")})` : ""));
  } else {
    const msg = errors.join("; ") || "수집 실패";
    await query(`UPDATE crawl_tasks SET status = 'FAILED', error = $1, updated_at = NOW() WHERE id = $2`, [msg, taskId])
      .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_error", systemName: CTMS_DATA_SYSTEM, error: msg });
  }

  jobEventBus.scheduleCleanup(jobId);
  return okCount > 0;
}

// ── DEV 통합 원클릭 수집 (순차: GCP_DATA → MEDCOMMS_DATA → CTMS_DATA → GCP_ACTIVITY) ──
// 하나라도 실패하면 즉시 중단하고 all_done 을 발행한다.
// (프론트는 all_done 수신 후 4개 태스크가 모두 COMPLETED 인 경우에만 PDF 를 생성한다)

const DEV_ALL_SYSTEMS = ["GCP_DATA", "MEDCOMMS_DATA", "CTMS_DATA", "GCP_ACTIVITY"] as const;

/** report_jobs / crawl_tasks 준비 + 이전 실행 히스토리 초기화 (UI·cron 공용) */
async function prepareDevCollectAll(jobId: string, userId: string): Promise<Record<string, string>> {
  const divRows = await query<{ id: string }>("SELECT id FROM divisions WHERE code = $1", ["DEV"]);
  if (!divRows.length) throw new AppError(400, "DEV 사업부를 찾을 수 없습니다.");

  // 재시도 대비: 이전 실행의 이벤트 히스토리를 비워 replay 로 옛 실패가 되살아나지 않게 한다.
  jobEventBus.resetHistory(jobId);

  await query(
    `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
     VALUES ($1, $2, 'RUNNING', NOW(), $3)
     ON DUPLICATE KEY UPDATE status = 'RUNNING', updated_at = NOW()`,
    [jobId, divRows[0].id, userId]
  );

  const taskIds: Record<string, string> = {};
  for (const system of DEV_ALL_SYSTEMS) {
    const rows = await query<{ id: string }>(
      `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
       VALUES ($1, $2, 'DOWNLOAD', 'PENDING')
       ON DUPLICATE KEY UPDATE
         task_type = 'DOWNLOAD', status = 'PENDING', updated_at = NOW()
       RETURNING id`,
      [jobId, system]
    );
    taskIds[system] = rows[0].id;
  }
  return taskIds;
}

export async function startDevCollectAll(params: {
  jobId:  string;
  userId: string;
}): Promise<{ jobId: string }> {
  const { jobId, userId } = params;
  const taskIds = await prepareDevCollectAll(jobId, userId);

  void runDevCollectAllInBackground(jobId, taskIds);

  logger.info(`[CrawlService] DEV 통합 수집 시작 (순차): job=${jobId}`);
  return { jobId };
}

/** 수집 단계별 결과 (자동 수집 이력 기록용) */
export interface CollectAllResult {
  ok:       boolean;
  /** 시스템별 성공 여부 — 중단된 이후 단계는 키가 없다(미실행) */
  results:  Record<string, boolean>;
  failedAt: string | null;
}

/**
 * 무인(cron) 실행용 — 수집이 끝날 때까지 **기다린 뒤** 단계별 결과를 돌려준다.
 * UI 경로(startDevCollectAll)와 동일한 순차 로직·실패 시 중단 정책을 공유한다.
 */
export async function runDevCollectAllAwait(params: {
  jobId:  string;
  userId: string;
}): Promise<CollectAllResult> {
  const { jobId, userId } = params;
  const taskIds = await prepareDevCollectAll(jobId, userId);
  logger.info(`[CrawlService] DEV 자동 수집 시작 (순차, 대기): job=${jobId}`);
  return runDevCollectAllInBackground(jobId, taskIds);
}

async function runDevCollectAllInBackground(
  jobId:   string,
  taskIds: Record<string, string>,
): Promise<CollectAllResult> {
  const steps: Array<{ system: string; run: () => Promise<boolean> }> = [
    { system: "GCP_DATA",      run: () => runGcpDataInBackground(jobId, taskIds["GCP_DATA"]) },
    { system: "MEDCOMMS_DATA", run: () => runMedcommsDataInBackground(jobId, taskIds["MEDCOMMS_DATA"]) },
    { system: "CTMS_DATA",     run: () => runCtmsDataInBackground(jobId, taskIds["CTMS_DATA"]) },
    { system: "GCP_ACTIVITY",  run: () => runGcpActivityInBackground(jobId, taskIds["GCP_ACTIVITY"]) },
  ];

  // 완료 신호로 all_done 을 쓰지 않는다.
  //   all_done 은 SSE 스트림을 종료시키고 히스토리에 남아, 같은 jobId 재실행 시
  //   replay 로 스트림이 조기 종료된다(crawl.controller.streamCrawlHandler).
  //   프론트는 개별 수집과 동일하게 taskMap 상태(모두 COMPLETED / 하나라도 FAILED)로 완료를 감지한다.
  const results: Record<string, boolean> = {};

  for (const step of steps) {
    let ok = false;
    try {
      ok = await step.run();
    } catch (e) {
      logger.error(`[CrawlService] DEV 통합 수집 단계 오류 (${step.system}): ${(e as Error).message}`);
    }
    results[step.system] = ok;
    if (!ok) {
      // 실패 시 중단 — 실패한 태스크는 이미 FAILED(task_error)로 표시됨.
      //   나머지 단계는 실행하지 않으며 PENDING 으로 남는다(프론트가 실패로 판정).
      logger.warn(`[CrawlService] DEV 통합 수집 중단 — ${step.system} 실패`);
      jobEventBus.scheduleCleanup(jobId);
      return { ok: false, results, failedAt: step.system };
    }
  }

  logger.info(`[CrawlService] DEV 통합 수집 완료 (4/4)`);
  jobEventBus.scheduleCleanup(jobId);
  return { ok: true, results, failedAt: null };
}

// ── L HOUSE 원클릭 통합 수집 (순차: LHOUSE_DATA → VEEVA(Activity), 실패 시 중단) ──
//   개발본부와 동일 패턴 — all_done 미발행, 프론트가 taskMap 으로 완료 감지.

const LHOUSE_ACTIVITY_SYSTEM = "VEEVA";
const LHOUSE_ALL_SYSTEMS = ["LHOUSE_DATA", LHOUSE_ACTIVITY_SYSTEM] as const;

/** report_jobs / crawl_tasks 준비 + 히스토리 초기화 (UI·cron 공용) */
async function prepareLhouseCollectAll(jobId: string, userId: string): Promise<Record<string, string>> {
  const divRows = await query<{ id: string }>("SELECT id FROM divisions WHERE code = $1", [LHOUSE_DATA_DIV]);
  if (!divRows.length) throw new AppError(400, "LHOUSE 사업부를 찾을 수 없습니다.");

  // 재시도 대비: 이전 실행의 이벤트 히스토리를 비운다.
  jobEventBus.resetHistory(jobId);

  await query(
    `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
     VALUES ($1, $2, 'RUNNING', NOW(), $3)
     ON DUPLICATE KEY UPDATE status = 'RUNNING', updated_at = NOW()`,
    [jobId, divRows[0].id, userId]
  );

  const taskIds: Record<string, string> = {};
  for (const system of LHOUSE_ALL_SYSTEMS) {
    const rows = await query<{ id: string }>(
      `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
       VALUES ($1, $2, 'DOWNLOAD', 'PENDING')
       ON DUPLICATE KEY UPDATE
         task_type = 'DOWNLOAD', status = 'PENDING', updated_at = NOW()
       RETURNING id`,
      [jobId, system]
    );
    taskIds[system] = rows[0].id;
  }
  return taskIds;
}

export async function startLhouseCollectAll(params: {
  jobId:  string;
  userId: string;
}): Promise<{ jobId: string }> {
  const { jobId, userId } = params;
  const taskIds = await prepareLhouseCollectAll(jobId, userId);

  void runLhouseCollectAllInBackground(jobId, taskIds);

  logger.info(`[CrawlService] LHOUSE 통합 수집 시작 (순차): job=${jobId}`);
  return { jobId };
}

/** 무인(cron) 실행용 — 수집 완료까지 기다린 뒤 단계별 결과를 반환 */
export async function runLhouseCollectAllAwait(params: {
  jobId:  string;
  userId: string;
}): Promise<CollectAllResult> {
  const { jobId, userId } = params;
  const taskIds = await prepareLhouseCollectAll(jobId, userId);
  logger.info(`[CrawlService] LHOUSE 자동 수집 시작 (순차, 대기): job=${jobId}`);
  return runLhouseCollectAllInBackground(jobId, taskIds);
}

async function runLhouseCollectAllInBackground(
  jobId:   string,
  taskIds: Record<string, string>,
): Promise<CollectAllResult> {
  const steps: Array<{ system: string; run: () => Promise<boolean> }> = [
    { system: "LHOUSE_DATA",          run: () => runLhouseDataInBackground(jobId, taskIds["LHOUSE_DATA"]) },
    { system: LHOUSE_ACTIVITY_SYSTEM, run: () => runLhouseVeevaCrawl(jobId, taskIds[LHOUSE_ACTIVITY_SYSTEM]) },
  ];

  const results: Record<string, boolean> = {};

  for (const step of steps) {
    let ok = false;
    try {
      ok = await step.run();
    } catch (e) {
      logger.error(`[CrawlService] LHOUSE 통합 수집 단계 오류 (${step.system}): ${(e as Error).message}`);
    }
    results[step.system] = ok;
    if (!ok) {
      logger.warn(`[CrawlService] LHOUSE 통합 수집 중단 — ${step.system} 실패`);
      jobEventBus.scheduleCleanup(jobId);
      return { ok: false, results, failedAt: step.system };
    }
  }

  logger.info(`[CrawlService] LHOUSE 통합 수집 완료 (2/2)`);
  jobEventBus.scheduleCleanup(jobId);
  return { ok: true, results, failedAt: null };
}

// L HOUSE Veeva 시스템 조회(전체 크롤) → Activity_LHOUSE.xlsx 생성 + uploaded_files 등록.
//   (기존 /crawl/start 의 VEEVA named-slot 등록 로직과 동일 결과)
async function runLhouseVeevaCrawl(jobId: string, taskId: string): Promise<boolean> {
  let succeeded = false;
  jobEventBus.emit(jobId, { type: "task_start", systemName: LHOUSE_ACTIVITY_SYSTEM, total: 1 });
  await query(`UPDATE crawl_tasks SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [taskId])
    .catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

  try {
    const result = await CrawlerFactory.run("LHOUSE", "VEEVA", jobId, (event) => {
      if (event.percent !== undefined || event.message) {
        jobEventBus.emit(jobId, {
          type:       "progress",
          systemName: LHOUSE_ACTIVITY_SYSTEM,
          percent:    event.percent,
          message:    event.message,
        });
      }
    });

    const resultPath = result.files[0] ?? null;
    if (resultPath && fs.existsSync(resultPath)) {
      try {
        const fileSize = fs.statSync(resultPath).size;
        const existing = await query<{ id: string }>(
          `SELECT id FROM uploaded_files
           WHERE report_job_id = $1 AND original_name = 'Activity_LHOUSE.xlsx'
           ORDER BY created_at DESC LIMIT 1`,
          [jobId]
        );
        if (existing.length) {
          await query(
            `UPDATE uploaded_files
             SET stored_path = $1, file_type = $2, file_size = $3,
                 analysis_result = '{}', created_at = NOW()
             WHERE id = $4`,
            [resultPath, GCP_XLSX_MIME, fileSize, existing[0].id]
          );
        } else {
          await query(
            `INSERT INTO uploaded_files
               (report_job_id, original_name, stored_path, file_type, file_size)
             VALUES ($1, 'Activity_LHOUSE.xlsx', $2, $3, $4)`,
            [jobId, resultPath, GCP_XLSX_MIME, fileSize]
          );
        }
        logger.info(`[CrawlService] LHOUSE Activity 등록: ${resultPath}`);
      } catch (saveErr) {
        logger.warn(`[CrawlService] LHOUSE Activity 파일 등록 실패 (무시): ${(saveErr as Error).message}`);
      }
    }

    await query(
      `UPDATE crawl_tasks SET status = 'COMPLETED', result_path = $1, updated_at = NOW() WHERE id = $2`,
      [resultPath, taskId]
    ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_done", systemName: LHOUSE_ACTIVITY_SYSTEM, filePaths: result.files });
    logger.info(`[CrawlService] LHOUSE Veeva 시스템 조회 완료: ${resultPath}`);
    succeeded = true;

  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error(`[CrawlService] LHOUSE Veeva 시스템 조회 실패: ${errMsg}`);
    await query(
      `UPDATE crawl_tasks SET status = 'FAILED', error = $1, updated_at = NOW() WHERE id = $2`,
      [errMsg, taskId]
    ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
    jobEventBus.emit(jobId, { type: "task_error", systemName: LHOUSE_ACTIVITY_SYSTEM, error: errMsg });
  }

  jobEventBus.scheduleCleanup(jobId);
  return succeeded;
}

// ── 백그라운드 실행 ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5_000;

async function runInBackground(
  divisionCode: DivisionCode,
  jobId:        string,
  systems:      string[]
): Promise<void> {
  const total = systems.length;
  let failCount = 0;

  for (const [idx, systemName] of systems.entries()) {
    // ── task_start 이벤트 ─────────────────────────────────────────────────
    jobEventBus.emit(jobId, { type: "task_start", systemName, total });
    logger.info(`[CrawlService] [${idx + 1}/${total}] Starting ${systemName}`);

    // crawl_tasks → RUNNING
    await query(
      `UPDATE crawl_tasks
       SET status = 'RUNNING', updated_at = NOW()
       WHERE report_job_id = $1 AND system_name = $2`,
      [jobId, systemName]
    ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

    let lastErr: Error | null = null;
    let succeeded = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          const delayMs = RETRY_BASE_DELAY_MS * attempt;
          logger.info(
            `[CrawlService] ${systemName} retry ${attempt}/${MAX_RETRIES} in ${delayMs / 1000}s`
          );
          jobEventBus.emit(jobId, {
            type:       "task_retry",
            systemName,
            attempt,
            maxRetries: MAX_RETRIES,
          });
          await new Promise((r) => setTimeout(r, delayMs));
        }

        // ── 크롤러 실행 ───────────────────────────────────────────────────
        const result = await CrawlerFactory.run(
          divisionCode,
          systemName,
          jobId,
          (event) => {
            // BaseCrawler 진행률 → SSE progress 이벤트 (message 포함)
            if (event.percent !== undefined || event.message) {
              jobEventBus.emit(jobId, {
                type:       "progress",
                systemName,
                percent:    event.percent,
                message:    event.message,
              });
            }
          }
        );

        // crawl_tasks → COMPLETED
        const resultPath = result.files[0] ?? null;
        await query(
          `UPDATE crawl_tasks
           SET status = 'COMPLETED', result_path = $1, updated_at = NOW()
           WHERE report_job_id = $2 AND system_name = $3`,
          [resultPath, jobId, systemName]
        ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

        // ── 다운로드 결과를 named 업로드 슬롯(uploaded_files)에 자동 등록 ────────
        //   일반 크롤 플로우는 result_path 만 저장하므로, 화면의 업로드 슬롯과
        //   보고서가 참조하는 uploaded_files 에 직접 등록해야 "Activity (Task) Count"
        //   슬롯에 자동 반영된다. (크롤러가 이미 uploads/Activity_LHOUSE.xlsx 로 저장함)
        const NAMED_SLOT: Record<string, { div: DivisionCode; file: string; mime: string }> = {
          VEEVA: {
            div:  "LHOUSE",
            file: "Activity_LHOUSE.xlsx",
            mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        };
        const named = NAMED_SLOT[systemName];
        if (resultPath && named && named.div === divisionCode && fs.existsSync(resultPath)) {
          try {
            const fileSize = fs.statSync(resultPath).size;
            const existing = await query<{ id: string }>(
              `SELECT id FROM uploaded_files
               WHERE report_job_id = $1 AND original_name = $2
               ORDER BY created_at DESC LIMIT 1`,
              [jobId, named.file]
            );
            if (existing.length) {
              await query(
                `UPDATE uploaded_files
                 SET stored_path = $1, file_type = $2, file_size = $3,
                     analysis_result = '{}', created_at = NOW()
                 WHERE id = $4`,
                [resultPath, named.mime, fileSize, existing[0].id]
              );
              logger.info(`[CrawlService] named 슬롯 갱신: ${named.file} ← ${resultPath}`);
            } else {
              await query(
                `INSERT INTO uploaded_files
                   (report_job_id, original_name, stored_path, file_type, file_size)
                 VALUES ($1, $2, $3, $4, $5)`,
                [jobId, named.file, resultPath, named.mime, fileSize]
              );
              logger.info(`[CrawlService] named 슬롯 등록: ${named.file} ← ${resultPath}`);
            }
          } catch (e) {
            logger.warn(`[CrawlService] named 슬롯 등록 실패 (무시): ${(e as Error).message}`);
          }
        }

        // ── task_done 이벤트 ─────────────────────────────────────────────
        jobEventBus.emit(jobId, {
          type:       "task_done",
          systemName,
          filePaths:  result.files,
        });
        logger.info(`[CrawlService] ${systemName} completed (${result.files.length} files)`);

        succeeded = true;
        break; // 성공 → 재시도 루프 종료

      } catch (err) {
        lastErr = err as Error;
        logger.warn(
          `[CrawlService] ${systemName} attempt ${attempt}/${MAX_RETRIES} failed: ${lastErr.message}`
        );
      }
    }

    if (!succeeded) {
      failCount++;
      const errMsg = lastErr?.message ?? "알 수 없는 오류";
      logger.error(`[CrawlService] ${systemName} failed after ${MAX_RETRIES} retries: ${errMsg}`);

      // crawl_tasks → FAILED
      await query(
        `UPDATE crawl_tasks
         SET status = 'FAILED', error = $1, updated_at = NOW()
         WHERE report_job_id = $2 AND system_name = $3`,
        [errMsg, jobId, systemName]
      ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

      // ── task_error 이벤트 ────────────────────────────────────────────
      jobEventBus.emit(jobId, {
        type:       "task_error",
        systemName,
        error:      errMsg,
      });
    }
  }

  // ── 전체 완료 ─────────────────────────────────────────────────────────────
  const finalStatus = failCount === total ? "FAILED" : "COMPLETED";
  logger.info(`[CrawlService] Job ${jobId} done — status: ${finalStatus} (${failCount} failures)`);

  // report_jobs 상태 업데이트 (COMPLETED는 pdf_path 제약으로 생략, FAILED만 처리)
  if (finalStatus === "FAILED") {
    await query(
      `UPDATE report_jobs
       SET status = 'FAILED', completed_at = NOW(),
           error_message = '전체 크롤 태스크 실패', updated_at = NOW()
       WHERE id = $1`,
      [jobId]
    ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));
  }
  // COMPLETED는 pdf_path 가 필요한 제약 때문에 PDF 생성 단계에서 처리

  // ── all_done 이벤트 ────────────────────────────────────────────────────────
  jobEventBus.emit(jobId, { type: "all_done", jobId });
  jobEventBus.scheduleCleanup(jobId);
}
