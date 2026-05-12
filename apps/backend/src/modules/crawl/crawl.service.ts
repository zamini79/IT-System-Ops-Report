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
       ON CONFLICT (id) DO UPDATE
         SET status = 'RUNNING', updated_at = NOW()`,
      [jobId, divisionId, userId]
    );

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
       VALUES ($1, $2, 'SCREENSHOT', 'PENDING')
       ON CONFLICT (report_job_id, system_name) DO UPDATE
         SET task_type = 'SCREENSHOT', status = 'PENDING', updated_at = NOW()
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

// ── Veeva 대시보드 캡처 잡 ──────────────────────────────────────────────────────

const VEEVA_DASHBOARD_SYSTEM = "VEEVA_DASHBOARD";
const VEEVA_DASHBOARD_DIV    = "LHOUSE" as const;

/**
 * Veeva 대시보드 스크린샷 캡처를 시작합니다 (임시 기능).
 *
 * 1. divisions 에서 LHOUSE division_id 조회
 * 2. report_jobs upsert
 * 3. crawl_tasks 레코드 생성 (PENDING)
 * 4. runDashboardInBackground() 로 비동기 실행
 */
export async function startDashboardCapture(params: {
  jobId:  string;
  userId: string;
}): Promise<{ taskId: string }> {
  const { jobId, userId } = params;

  const divRows = await query<{ id: string }>(
    "SELECT id FROM divisions WHERE code = $1",
    [VEEVA_DASHBOARD_DIV]
  );
  if (!divRows.length) throw new AppError(400, "LHOUSE 사업부를 찾을 수 없습니다.");
  const divisionId = divRows[0].id;

  await query(
    `INSERT INTO report_jobs (id, division_id, status, started_at, created_by)
     VALUES ($1, $2, 'RUNNING', NOW(), $3)
     ON CONFLICT (id) DO UPDATE SET status = 'RUNNING', updated_at = NOW()`,
    [jobId, divisionId, userId]
  );

  const crawlTaskResult = await query<{ id: string }>(
    `INSERT INTO crawl_tasks (report_job_id, system_name, task_type, status)
     VALUES ($1, $2, 'DOWNLOAD', 'PENDING')
     ON CONFLICT (report_job_id, system_name) DO UPDATE
       SET task_type = 'DOWNLOAD', status = 'PENDING', updated_at = NOW()
     RETURNING id`,
    [jobId, VEEVA_DASHBOARD_SYSTEM]
  );
  const taskId = crawlTaskResult[0].id;

  void runDashboardInBackground(jobId, taskId);

  logger.info(`[CrawlService] Dashboard capture started: job=${jobId}, task=${taskId}`);
  return { taskId };
}

async function runDashboardInBackground(jobId: string, taskId: string): Promise<void> {
  jobEventBus.emit(jobId, {
    type:       "task_start",
    systemName: VEEVA_DASHBOARD_SYSTEM,
    total:      1,
  });

  await query(
    `UPDATE crawl_tasks SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`,
    [taskId]
  ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

  try {
    const result = await CrawlerFactory.runSingle(
      VEEVA_DASHBOARD_SYSTEM,
      jobId,
      (event) => {
        if (event.percent !== undefined || event.message) {
          jobEventBus.emit(jobId, {
            type:       "progress",
            systemName: VEEVA_DASHBOARD_SYSTEM,
            percent:    event.percent,
            message:    event.message,
          });
        }
      }
    );

    const resultPath = result.files[0] ?? null;

    // ── System Usage (DX) 슬롯에 자동 등록 ──────────────────────────────────
    if (resultPath) {
      try {
        const uploadDir  = process.env.UPLOAD_DIR ?? "uploads";
        const uploadsDir = path.resolve(uploadDir, jobId, "uploads");
        fs.mkdirSync(uploadsDir, { recursive: true });

        const savedFilename = "Systemusage_LHOUSE.png";
        const destPath      = path.join(uploadsDir, savedFilename);
        fs.copyFileSync(resultPath, destPath);

        const fileSize = fs.statSync(destPath).size;

        const existing = await query<{ id: string }>(
          "SELECT id FROM uploaded_files WHERE report_job_id = $1 AND original_name = $2",
          [jobId, savedFilename]
        );
        if (existing.length) {
          await query(
            `UPDATE uploaded_files
             SET stored_path = $1, file_type = 'image/png', file_size = $2,
                 analysis_result = '{}'::jsonb, created_at = NOW()
             WHERE id = $3`,
            [destPath, fileSize, existing[0].id]
          );
          logger.info(`[CrawlService] System Usage updated: ${destPath}`);
        } else {
          await query(
            `INSERT INTO uploaded_files
               (report_job_id, original_name, stored_path, file_type, file_size)
             VALUES ($1, $2, $3, 'image/png', $4)`,
            [jobId, savedFilename, destPath, fileSize]
          );
          logger.info(`[CrawlService] System Usage saved: ${destPath}`);
        }
      } catch (saveErr) {
        logger.warn(
          `[CrawlService] System Usage 파일 등록 실패 (무시): ${(saveErr as Error).message}`
        );
      }
    }

    await query(
      `UPDATE crawl_tasks SET status = 'COMPLETED', result_path = $1, updated_at = NOW() WHERE id = $2`,
      [resultPath, taskId]
    ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

    jobEventBus.emit(jobId, {
      type:       "task_done",
      systemName: VEEVA_DASHBOARD_SYSTEM,
      filePaths:  result.files,
    });

    logger.info(`[CrawlService] Dashboard capture done: ${resultPath}`);

  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error(`[CrawlService] Dashboard capture failed: ${errMsg}`);

    await query(
      `UPDATE crawl_tasks SET status = 'FAILED', error = $1, updated_at = NOW() WHERE id = $2`,
      [errMsg, taskId]
    ).catch((e: Error) => logger.warn(`[CrawlService] DB update failed: ${e.message}`));

    jobEventBus.emit(jobId, {
      type:       "task_error",
      systemName: VEEVA_DASHBOARD_SYSTEM,
      error:      errMsg,
    });
  }

  jobEventBus.emit(jobId, { type: "all_done", jobId });
  jobEventBus.scheduleCleanup(jobId);
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
