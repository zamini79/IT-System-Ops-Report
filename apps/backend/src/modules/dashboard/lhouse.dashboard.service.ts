/**
 * L HOUSE 공장 대시보드 스냅샷 빌더
 *
 * PDF 리포트(lhouse.report.service)와 **동일한 파싱·계산 함수**를 재사용해
 * 차트용 숫자 데이터(JSON)를 만든다 → 두 경로의 수치가 항상 일치한다.
 */

import fs   from "fs";
import path from "path";

import type {
  DashboardCategoryItem,
  DashboardGroupedSeries,
  DashboardKpi,
  DashboardSeries,
  DashboardSourceStatus,
  LhouseDashboardData,
} from "./dashboard.types";
import { DASHBOARD_JOB_IDS } from "./dashboard.types";

import { logger } from "../../utils/logger";
import { parseGcpMonthGroups }    from "../report/dev.report.service";
import {
  readExportBColumn,
  parseLhouseQualityByType,
  parseTrainingMonth,
  buildLhouseInsightLines,
} from "../report/lhouse.report.service";
import {
  SourceDef, buildTimesheetSection, seriesOrNull, ym2label, categoryItems,
  kpiFromSeries, buildSourceStatus, TIMESHEET_FILE, dailyFromFile,
} from "./snapshot.shared";

/** L HOUSE 대시보드가 사용하는 소스 파일 */
export const LHOUSE_SOURCES: SourceDef[] = [
  { file: "LHOUSE_PerfStats.xlsx",  label: "Veeva Performance Statistics", kind: "collected" },
  { file: "LHOUSE_Quality.xlsx",    label: "Veeva Quality Events",         kind: "collected" },
  { file: "LHOUSE_Training.json",   label: "Veeva Training",               kind: "collected" },
  { file: "Activity_LHOUSE.xlsx",   label: "Activity (Task) Count",        kind: "collected" },
];

export function lhouseWorkspacePath(): string {
  const uploadDir = process.env.UPLOAD_DIR ?? "uploads";
  return path.resolve(uploadDir, DASHBOARD_JOB_IDS.LHOUSE, "uploads");
}

// ── Veeva Quality System ──────────────────────────────────────────────────────

function buildVeevaData(ws: string): LhouseDashboardData["veeva"] {
  const perf      = path.join(ws, "LHOUSE_PerfStats.xlsx");
  const qual      = path.join(ws, "LHOUSE_Quality.xlsx");
  const trainJson = path.join(ws, "LHOUSE_Training.json");
  const act       = path.join(ws, "Activity_LHOUSE.xlsx");

  if (![perf, qual, trainJson, act].some((f) => fs.existsSync(f))) return null;

  // 컬럼 인덱스는 lhouse.report.service.buildLhouseVeevaCharts 와 동일
  const doc   = fs.existsSync(perf) ? parseGcpMonthGroups(perf, 4) : {};
  const user  = fs.existsSync(perf) ? parseGcpMonthGroups(perf, 1) : {};
  const login = fs.existsSync(perf) ? parseGcpMonthGroups(perf, 3) : {};

  const monthsSet = new Set<string>([
    ...Object.keys(doc), ...Object.keys(user), ...Object.keys(login),
  ]);
  const months = [...monthsSet].sort().slice(-3);
  const labels = months.map(ym2label);
  const toVals = (m: Record<string, number>) => months.map((ym) => Math.round(m[ym] ?? 0));

  const docV = toVals(doc), userV = toVals(user), loginV = toVals(login);

  // 품질 이벤트 — 월 × 유형
  const qt = fs.existsSync(qual)
    ? parseLhouseQualityByType(qual)
    : { types: [] as string[], byMonth: {} as Record<string, Record<string, number>> };
  const qMonths = Object.keys(qt.byMonth).length
    ? Object.keys(qt.byMonth).sort().slice(-3)
    : months;
  const qLabels = qMonths.map((ym) => (/^\d{4}-\d{2}$/.test(ym) ? ym2label(ym) : ym));

  let quality: DashboardGroupedSeries | null = null;
  if (qt.types.length) {
    const qSeries = qt.types.map((t) => ({
      name:   t,
      values: qMonths.map((ym) => Math.round(qt.byMonth[ym]?.[t] ?? 0)),
    }));
    if (qSeries.some((s) => s.values.some((v) => v > 0))) {
      quality = { labels: qLabels, series: qSeries };
    }
  }

  // 교육 — 화면 스크래핑 JSON (rows:[{name, count}])
  let training: DashboardSeries | null = null;
  let trnLabels: string[] = [];
  let trainingTotal = 0;
  if (fs.existsSync(trainJson)) {
    try {
      const raw  = JSON.parse(fs.readFileSync(trainJson, "utf-8")) as { rows?: { name: string; count: number }[] };
      const rows = (raw.rows ?? []).map((r) => ({ ...parseTrainingMonth(r.name), count: Number(r.count) || 0 }));
      if (rows.every((r) => r.ym)) rows.sort((a, b) => (a.ym ?? "").localeCompare(b.ym ?? ""));
      const last3   = rows.slice(-3);
      trnLabels     = last3.map((r) => r.label);
      const trnVals = last3.map((r) => r.count);
      trainingTotal = trnVals.reduce((a, b) => a + b, 0);
      training      = seriesOrNull(trnLabels, trnVals);
    } catch (e) {
      logger.warn(`[LHOUSE Dashboard] 교육 JSON 파싱 실패: ${(e as Error).message}`);
    }
  }

  // 업무 활용 (Activity_LHOUSE.xlsx) — 구성비
  let activity: DashboardCategoryItem[] = [];
  if (fs.existsSync(act)) {
    try {
      const cc = readExportBColumn(act);
      activity = cc.labels.map((l, i) => ({ category: l, value: cc.values[i] ?? 0 }));
    } catch (e) {
      logger.warn(`[LHOUSE Dashboard] Activity_LHOUSE 파싱 실패: ${(e as Error).message}`);
    }
  }

  const insight = buildLhouseInsightLines({
    labels, docV, userV, loginV, qLabels, qMonths, qt, trainingTotal, trnLabels,
  });

  return {
    labels,
    docCount:    seriesOrNull(labels, docV),
    activeUser:  seriesOrNull(labels, userV),
    uniqueLogin: seriesOrNull(labels, loginV),
    quality,
    training,
    activity,
    insight,
  };
}

// ── KPI ───────────────────────────────────────────────────────────────────────

function buildKpis(d: LhouseDashboardData): DashboardKpi[] {
  const kpis: DashboardKpi[] = [
    kpiFromSeries("lh_doc",   "문서 관리",      "건", d.veeva?.docCount    ?? null),
    kpiFromSeries("lh_user",  "등록 사용자",    "명", d.veeva?.activeUser  ?? null),
    kpiFromSeries("lh_login", "일평균 접속",    "명", d.veeva?.uniqueLogin ?? null),
  ];

  if (d.veeva?.quality) {
    const total = d.veeva.quality.series.flatMap((s) => s.values).reduce((a, b) => a + b, 0);
    kpis.push({ key: "lh_quality", label: "품질 이벤트(3개월)", value: total, unit: "건", delta: null });
  }
  if (d.veeva?.training) {
    const total = d.veeva.training.values.reduce((a, b) => a + b, 0);
    kpis.push({ key: "lh_training", label: "교육 실행(3개월)", value: total, unit: "건", delta: null });
  }
  if (d.veeva?.activity.length) {
    const total = d.veeva.activity.reduce((s, c) => s + c.value, 0);
    kpis.push({ key: "lh_activity", label: "업무 활용 합계", value: total, unit: "건", delta: null });
  }

  return kpis;
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

export interface LhouseSnapshotBuildResult {
  data:    LhouseDashboardData;
  kpis:    DashboardKpi[];
  sources: DashboardSourceStatus[];
  daily:   Record<string, DashboardSeries>;
}

export async function buildLhouseSnapshot(): Promise<LhouseSnapshotBuildResult> {
  const ws = lhouseWorkspacePath();
  fs.mkdirSync(ws, { recursive: true });

  logger.info(`[LHOUSE Dashboard] 스냅샷 생성 시작 — ${ws}`);

  const ts = await buildTimesheetSection("LHOUSE");

  const data: LhouseDashboardData = {
    veeva:     buildVeevaData(ws),
    timesheet: ts.data,
  };

  const kpis    = buildKpis(data);
  const sources = buildSourceStatus(ws, LHOUSE_SOURCES, ts.status);

  // 일별 추이 — LHOUSE_PerfStats: B=Active User, D=Unique Login, E=Doc Count
  const daily: Record<string, DashboardSeries> = {};
  const perfPath = path.join(ws, "LHOUSE_PerfStats.xlsx");
  const put = (key: string, s: DashboardSeries | null) => { if (s) daily[key] = s; };
  put("lh_doc",   dailyFromFile(perfPath, 4));
  put("lh_user",  dailyFromFile(perfPath, 1));
  put("lh_login", dailyFromFile(perfPath, 3));

  logger.info(
    `[LHOUSE Dashboard] 스냅샷 완료 — 소스 ${sources.filter((s) => s.present).length}/${sources.length}, ` +
    `veeva:${data.veeva ? "O" : "X"} timesheet:${data.timesheet ? "O" : "X"}`
  );

  return { data, kpis, sources, daily };
}

// 사용하지 않지만 타입 참조 유지 (categoryItems 는 다른 본부 빌더와 시그니처 공유)
void categoryItems;
void TIMESHEET_FILE;
