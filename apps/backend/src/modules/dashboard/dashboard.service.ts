/**
 * 대시보드 스냅샷 저장·조회 서비스
 *
 * - 스냅샷은 (본부 × 날짜) 로 1건만 유지한다(당일 재수집 시 덮어쓰기).
 * - 일별 스냅샷이 쌓이면서 KPI 추이를 조회할 수 있다.
 * - 수집이 실패해도 이전 스냅샷은 그대로 남고, collection_runs 에 실패가 기록된다.
 */

import type {
  DashboardDivisionCode,
  DashboardKpi,
  DashboardResponse,
  DashboardSourceStatus,
  DashboardTrendResponse,
  AnyDashboardData,
  DashboardSeries,
} from "./dashboard.types";

import { logger }   from "../../utils/logger";
import { query }    from "../../config/db";
import { AppError } from "../../utils/errors";
import { buildDevSnapshot }    from "./dev.dashboard.service";
import { buildLhouseSnapshot } from "./lhouse.dashboard.service";
import { buildBioSnapshot }    from "./bio.dashboard.service";

// ── 스냅샷 payload 형태 (dashboard_snapshots.data 컬럼) ────────────────────────

interface SnapshotPayload {
  /** 본부별 데이터 (DevDashboardData | LhouseDashboardData | BioDashboardData) */
  payload: AnyDashboardData | null;
  kpis:    DashboardKpi[];
  /**
   * KPI key → 일별 시리즈 (추이 차트용).
   * Veeva PerfStats 리포트에 최근 약 3개월치 **일별 행**이 들어 있어, 스냅샷을 하루씩
   * 모으기 전에도 곧바로 일별 추이를 볼 수 있다.
   */
  daily?:  Record<string, DashboardSeries>;
}

// ── 날짜 헬퍼 ─────────────────────────────────────────────────────────────────

/** 한국 시간 기준 YYYY-MM-DD (서버 TZ 가 UTC 여도 KST 날짜로 묶이도록) */
export function kstDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

// ── 스냅샷 생성/갱신 ──────────────────────────────────────────────────────────

/**
 * 현재 작업공간 파일을 읽어 스냅샷을 만들고 당일 레코드로 upsert 한다.
 * (자동 수집 직후, 그리고 사용자가 파일을 업로드한 직후에 호출)
 */
export async function refreshSnapshot(
  divisionCode: DashboardDivisionCode
): Promise<{ capturedDate: string; sources: DashboardSourceStatus[] }> {
  const built =
    divisionCode === "DEV"    ? await buildDevSnapshot()    :
    divisionCode === "LHOUSE" ? await buildLhouseSnapshot() :
    divisionCode === "BIO"    ? await buildBioSnapshot()    :
    null;

  if (!built) throw new AppError(400, `알 수 없는 본부 코드: ${divisionCode}`);

  const capturedDate = kstDateString();

  const payload: SnapshotPayload = { payload: built.data, kpis: built.kpis, daily: built.daily };

  await query(
    `INSERT INTO dashboard_snapshots (division_code, captured_date, data, sources)
     VALUES ($1, $2, $3, $4)
     ON DUPLICATE KEY UPDATE
       data = VALUES(data), sources = VALUES(sources), updated_at = NOW()`,
    [divisionCode, capturedDate, JSON.stringify(payload), JSON.stringify(built.sources)]
  );

  logger.info(`[Dashboard] 스냅샷 저장 완료 — ${divisionCode} ${capturedDate}`);
  return { capturedDate, sources: built.sources };
}

// ── 조회 ──────────────────────────────────────────────────────────────────────

interface SnapshotRow {
  captured_date: string;
  updated_at:    string;
  data:          SnapshotPayload;
  sources:       DashboardSourceStatus[];
}

interface RunRow {
  trigger:     string;
  status:      string;
  started_at:  string;
  finished_at: string | null;
  detail:      unknown;
}

/**
 * 최신 스냅샷 + 마지막 수집 실행 정보를 반환한다.
 * 스냅샷이 없으면 빈 응답(capturedDate=null)을 돌려주고, 프론트는 "수집 전" 상태를 표시한다.
 */
export async function getDashboard(
  divisionCode: DashboardDivisionCode
): Promise<DashboardResponse<AnyDashboardData>> {
  const snapRows = await query<SnapshotRow>(
    `SELECT captured_date, updated_at, data, sources
     FROM dashboard_snapshots
     WHERE division_code = $1
     ORDER BY captured_date DESC
     LIMIT 1`,
    [divisionCode]
  );

  const runRows = await query<RunRow>(
    `SELECT \`trigger\`, status, started_at, finished_at, detail
     FROM collection_runs
     WHERE division_code = $1
     ORDER BY started_at DESC
     LIMIT 1`,
    [divisionCode]
  );

  const snap = snapRows[0];
  const run  = runRows[0];

  return {
    divisionCode,
    capturedDate: snap ? toDateOnly(snap.captured_date) : null,
    updatedAt:    snap ? new Date(snap.updated_at).toISOString() : null,
    kpis:         snap?.data?.kpis    ?? [],
    data:         snap?.data?.payload ?? null,
    sources:      snap?.sources       ?? [],
    lastRun: run
      ? {
          trigger:    run.trigger,
          status:     run.status,
          startedAt:  new Date(run.started_at).toISOString(),
          finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null,
          detail:     run.detail,
        }
      : null,
  };
}

/** pg 가 DATE 를 Date 객체로 주는 경우가 있어 YYYY-MM-DD 로 정규화 */
function toDateOnly(v: string | Date): string {
  if (v instanceof Date) return kstDateString(v);
  return String(v).slice(0, 10);
}

/**
 * KPI 일별 추이 — 지정 기간의 스냅샷에서 해당 KPI 값을 뽑아 시계열로 반환.
 */
export async function getTrend(
  divisionCode: DashboardDivisionCode,
  metric:       string,
  days:         number
): Promise<DashboardTrendResponse> {
  // 1순위: 최신 스냅샷에 담긴 **일별 시리즈** (소스 리포트의 일별 행에서 추출).
  //   스냅샷이 하루치뿐이어도 최근 약 3개월 추이를 바로 보여줄 수 있다.
  const latest = await query<{ data: SnapshotPayload }>(
    `SELECT data FROM dashboard_snapshots
     WHERE division_code = $1
     ORDER BY captured_date DESC LIMIT 1`,
    [divisionCode]
  );

  const daily = latest[0]?.data?.daily?.[metric];
  if (daily && daily.labels.length) {
    const sliced = daily.labels.length > days ? -days : 0;
    const labels = sliced ? daily.labels.slice(sliced) : daily.labels;
    const values = sliced ? daily.values.slice(sliced) : daily.values;
    return {
      divisionCode, metric,
      points: labels.map((date, i) => ({ date, value: values[i] ?? null })),
    };
  }

  // 2순위: 일별 데이터가 없는 지표(월 단위 집계 등) — 스냅샷을 날짜별로 이어 붙인다.
  const rows = await query<{ captured_date: string; data: SnapshotPayload }>(
    `SELECT captured_date, data
     FROM dashboard_snapshots
     WHERE division_code = $1
       AND captured_date >= DATE_SUB(CURRENT_DATE, INTERVAL $2 DAY)
     ORDER BY captured_date ASC`,
    [divisionCode, days]
  );

  const points = rows.map((r) => {
    const kpi = (r.data?.kpis ?? []).find((k) => k.key === metric);
    return { date: toDateOnly(r.captured_date), value: kpi?.value ?? null };
  });

  return { divisionCode, metric, points };
}

// ── 수집 실행 이력 ────────────────────────────────────────────────────────────

export type CollectionTrigger = "cron" | "manual" | "upload";
export type CollectionStatus  = "RUNNING" | "SUCCESS" | "PARTIAL" | "FAILED";

/** 수집 실행 시작 기록 → runId 반환 */
export async function startCollectionRun(
  divisionCode: DashboardDivisionCode,
  trigger:      CollectionTrigger
): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO collection_runs (division_code, \`trigger\`, status)
     VALUES ($1, $2, 'RUNNING')
     RETURNING id`,
    [divisionCode, trigger]
  );
  return rows[0].id;
}

/** 수집 실행 종료 기록 */
export async function finishCollectionRun(
  runId:  string,
  status: CollectionStatus,
  detail: unknown
): Promise<void> {
  await query(
    `UPDATE collection_runs
     SET status = $1, finished_at = NOW(), detail = $2
     WHERE id = $3`,
    [status, JSON.stringify(detail ?? {}), runId]
  ).catch((e: Error) =>
    logger.warn(`[Dashboard] collection_runs 갱신 실패: ${e.message}`)
  );
}
