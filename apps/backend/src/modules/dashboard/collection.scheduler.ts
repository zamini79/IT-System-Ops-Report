/**
 * 대시보드 자동 수집 스케줄러
 *
 * 매일 새벽 1회 본부별 데이터를 자동 수집하고 대시보드 스냅샷을 갱신한다.
 * 담당자는 버튼을 누르지 않고, 필요할 때 대시보드에 접속해 확인만 하면 된다.
 *
 * ─ 정책 ──────────────────────────────────────────────────────────────────────
 *  • 본부별로 **순차** 실행 (같은 Veeva Vault 동시 로그인 충돌 회피)
 *  • 수집이 일부/전부 실패해도 **스냅샷은 항상 갱신**한다.
 *    → 성공한 소스는 새 값으로, 실패한 소스는 마지막으로 수집된 파일 값이 그대로 반영되고,
 *      실패 내역은 collection_runs 에 남아 대시보드에 표시된다.
 *  • 서버가 중복 기동되어도 한 프로세스에서만 돌도록 in-process 중복 실행 가드를 둔다.
 *
 * ─ 환경변수 ──────────────────────────────────────────────────────────────────
 *  DASHBOARD_CRON            크론식 (기본 "0 3 * * *" = 매일 03:00)
 *  DASHBOARD_CRON_TZ         타임존 (기본 "Asia/Seoul")
 *  DASHBOARD_CRON_ENABLED    "false" 면 스케줄러 비활성 (기본 활성)
 *  DASHBOARD_CRON_DIVISIONS  대상 본부 CSV (기본 "DEV")
 */

import cron, { type ScheduledTask } from "node-cron";

import { logger }  from "../../utils/logger";
import { query }   from "../../config/db";
import {
  runDevCollectAllAwait,
  runLhouseCollectAllAwait,
  runBioCollectAwait,
} from "../crawl/crawl.service";
import {
  DASHBOARD_JOB_IDS,
  type DashboardDivisionCode,
} from "./dashboard.types";
import {
  refreshSnapshot,
  startCollectionRun,
  finishCollectionRun,
  type CollectionStatus,
  type CollectionTrigger,
} from "./dashboard.service";

// ── 설정 ──────────────────────────────────────────────────────────────────────

const DEFAULT_CRON = "0 3 * * *";   // 매일 03:00
const DEFAULT_TZ   = "Asia/Seoul";

function targetDivisions(): DashboardDivisionCode[] {
  const raw = (process.env.DASHBOARD_CRON_DIVISIONS ?? "DEV,LHOUSE,BIO")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const valid: DashboardDivisionCode[] = [];
  for (const code of raw) {
    if (code === "DEV" || code === "LHOUSE" || code === "BIO") valid.push(code);
    else logger.warn(`[Scheduler] 알 수 없는 본부 코드 무시: ${code}`);
  }
  return valid;
}

// ── 시스템 계정 (report_jobs.created_by 는 NOT NULL + users FK) ────────────────

let cachedSystemUserId: string | null = null;

async function systemUserId(): Promise<string> {
  if (cachedSystemUserId) return cachedSystemUserId;
  const rows = await query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`
  );
  if (!rows.length) {
    throw new Error("자동 수집에 사용할 관리자 계정이 없습니다 (users.role='admin').");
  }
  cachedSystemUserId = rows[0].id;
  return cachedSystemUserId;
}

// ── 본부별 수집 실행 ──────────────────────────────────────────────────────────

/** 중복 실행 가드 — 같은 본부의 수집이 이미 돌고 있으면 건너뛴다 */
const running = new Set<DashboardDivisionCode>();

export interface CollectOutcome {
  divisionCode: DashboardDivisionCode;
  status:       CollectionStatus;
  detail:       unknown;
}

/**
 * 한 본부의 수집 + 스냅샷 갱신을 수행한다.
 * 수집이 실패해도 스냅샷 갱신은 시도하고(마지막 성공 파일 기준), 실행 이력에 사유를 남긴다.
 */
export async function collectDivision(
  divisionCode: DashboardDivisionCode,
  trigger:      CollectionTrigger,
): Promise<CollectOutcome> {
  if (running.has(divisionCode)) {
    logger.warn(`[Scheduler] ${divisionCode} 수집이 이미 진행 중 — 이번 실행 건너뜀`);
    return { divisionCode, status: "FAILED", detail: { skipped: "already running" } };
  }
  running.add(divisionCode);

  const runId = await startCollectionRun(divisionCode, trigger);
  const detail: Record<string, unknown> = { trigger };

  try {
    const jobId  = DASHBOARD_JOB_IDS[divisionCode];
    const userId = await systemUserId();

    logger.info(`[Scheduler] ${divisionCode} 자동 수집 시작 (trigger=${trigger})`);
    const collect =
      divisionCode === "DEV"    ? await runDevCollectAllAwait({ jobId, userId })    :
      divisionCode === "LHOUSE" ? await runLhouseCollectAllAwait({ jobId, userId }) :
                                  await runBioCollectAwait({ jobId, userId });
    detail.collect = collect;

    // 수집 성공 여부와 무관하게 스냅샷은 갱신한다(실패한 소스는 이전 파일 값 유지).
    const snap = await refreshSnapshot(divisionCode);
    detail.snapshot = {
      capturedDate: snap.capturedDate,
      presentSources: snap.sources.filter((s) => s.present).length,
      totalSources:   snap.sources.length,
      missing:        snap.sources.filter((s) => !s.present).map((s) => s.file),
    };

    const status: CollectionStatus = collect.ok ? "SUCCESS" : "PARTIAL";
    await finishCollectionRun(runId, status, detail);
    logger.info(
      `[Scheduler] ${divisionCode} 완료 — status=${status}` +
      (collect.failedAt ? ` (중단: ${collect.failedAt})` : "")
    );
    return { divisionCode, status, detail };

  } catch (err) {
    const msg = (err as Error).message;
    detail.error = msg;
    logger.error(`[Scheduler] ${divisionCode} 자동 수집 실패: ${msg}`);

    // 수집 자체가 실패했더라도 스냅샷 갱신을 한 번 시도한다(기존 파일 기준 최신 상태 유지).
    try {
      const snap = await refreshSnapshot(divisionCode);
      detail.snapshot = { capturedDate: snap.capturedDate, recoveredFromExistingFiles: true };
    } catch (e2) {
      detail.snapshotError = (e2 as Error).message;
    }

    await finishCollectionRun(runId, "FAILED", detail);
    return { divisionCode, status: "FAILED", detail };

  } finally {
    running.delete(divisionCode);
  }
}

/** 대상 본부를 순차로 수집 (동시 로그인 충돌 회피) */
export async function collectAllDivisions(trigger: CollectionTrigger): Promise<CollectOutcome[]> {
  const out: CollectOutcome[] = [];
  for (const code of targetDivisions()) {
    out.push(await collectDivision(code, trigger));
  }
  return out;
}

// ── 스케줄러 등록 ─────────────────────────────────────────────────────────────

let task: ScheduledTask | null = null;

/** 서버 기동 시 1회 호출 — 크론 등록 (이미 등록돼 있으면 무시) */
export function startCollectionScheduler(): void {
  if (process.env.DASHBOARD_CRON_ENABLED === "false") {
    logger.info("[Scheduler] DASHBOARD_CRON_ENABLED=false — 자동 수집 비활성");
    return;
  }
  if (task) {
    logger.warn("[Scheduler] 이미 등록됨 — 중복 등록 무시");
    return;
  }

  const expr = process.env.DASHBOARD_CRON    ?? DEFAULT_CRON;
  const tz   = process.env.DASHBOARD_CRON_TZ ?? DEFAULT_TZ;

  if (!cron.validate(expr)) {
    logger.error(`[Scheduler] 잘못된 크론식(${expr}) — 자동 수집을 등록하지 않습니다.`);
    return;
  }

  task = cron.schedule(expr, () => {
    void collectAllDivisions("cron").catch((e: Error) =>
      logger.error(`[Scheduler] 크론 실행 오류: ${e.message}`)
    );
  }, { timezone: tz });

  logger.info(
    `[Scheduler] 자동 수집 등록 — "${expr}" (${tz}), 대상: ${targetDivisions().join(", ") || "(없음)"}`
  );
}

/** 테스트·종료 시 크론 해제 */
export function stopCollectionScheduler(): void {
  task?.stop();
  task = null;
}
