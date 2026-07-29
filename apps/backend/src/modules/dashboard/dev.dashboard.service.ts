/**
 * 개발본부 대시보드 스냅샷 빌더
 *
 * PDF 리포트(dev.report.service)와 **동일한 파싱·계산 함수**를 재사용해
 * 차트용 숫자 데이터(JSON)를 만든다. PDF 는 이 데이터를 PNG 로 렌더링하지만,
 * 대시보드는 JSON 을 그대로 프론트에 넘겨 인터랙티브 차트로 그린다.
 * → 두 경로의 수치가 항상 일치한다.
 */

import fs   from "fs";
import path from "path";

import type {
  DashboardCategoryItem,
  DashboardGroupedSeries,
  DashboardKpi,
  DashboardSeries,
  DashboardSourceStatus,
  DevDashboardData,
} from "./dashboard.types";
import { DASHBOARD_JOB_IDS } from "./dashboard.types";

import { logger } from "../../utils/logger";
import { dailyFromFile } from "./snapshot.shared";
import { query }  from "../../config/db";
import {
  parseGcpMonthGroups,
  parseGcpQualityByType,
  parseGcpCategoryGroups,
  parseGcpStudyByOrg,
  readGcpCategorySheet,
  readDevMsTimesheetData,
  buildGcpInsightLines,
  buildMedcommsInsightLines,
  buildCtmsInsightLines,
} from "../report/dev.report.service";

// ── 소스 파일 정의 ────────────────────────────────────────────────────────────

interface SourceDef {
  file:  string;
  label: string;
  kind:  "collected" | "uploaded";
}

/** 개발본부 대시보드가 사용하는 소스 파일 목록 */
export const DEV_SOURCES: SourceDef[] = [
  { file: "GCP_PerfStats.xlsx",       label: "GCP Performance Statistics", kind: "collected" },
  { file: "GCP_Quality.xlsx",         label: "GCP Quality Events",         kind: "collected" },
  { file: "GCP_Training.xlsx",        label: "GCP Training",               kind: "collected" },
  { file: "Activity_GCP.xlsx",        label: "GCP Activity (Task) Count",  kind: "collected" },
  { file: "Medcomms_DocType.xlsx",    label: "Medcomms 생성 문서 구분",     kind: "collected" },
  { file: "Medcomms_PerfStats.xlsx",  label: "Medcomms Performance",       kind: "collected" },
  { file: "Medcomms_Activity.xlsx",   label: "Medcomms 업무 활용",          kind: "collected" },
  { file: "Medcomms_Review.xlsx",     label: "Medcomms 문서 리뷰 시간",     kind: "collected" },
  { file: "Clinical_PerfStats.xlsx",  label: "CTMS Performance",           kind: "collected" },
  { file: "Clinical_Study.xlsx",      label: "CTMS Study별 사용자",         kind: "collected" },
];

/** 세 본부 공유 업로드 파일 (DB 에서 파일명으로 전역 조회 — jobId 무관) */
const TIMESHEET_FILE = "SKB_Quallity_MS_Timesheet.xlsx";

// ── 경로 헬퍼 ─────────────────────────────────────────────────────────────────

/** 본부별 고정 작업공간 경로 (업로드 + 자동 수집 파일이 함께 모이는 곳) */
export function devWorkspacePath(): string {
  const uploadDir = process.env.UPLOAD_DIR ?? "uploads";
  return path.resolve(uploadDir, DASHBOARD_JOB_IDS.DEV, "uploads");
}

// ── 공용 유틸 ─────────────────────────────────────────────────────────────────

const ym2label = (ym: string) => `${parseInt(ym.slice(5, 7), 10)}월`;
const round1   = (n: number) => Math.round(n * 10) / 10;

/** 값이 모두 0 이면 null (차트 숨김) */
function series(labels: string[], values: number[]): DashboardSeries | null {
  if (!labels.length || values.every((v) => v === 0)) return null;
  return { labels, values };
}

function categoryItems(cs: { category: string; value: number }[]): DashboardCategoryItem[] {
  return cs.map((c) => ({ category: c.category, value: c.value }));
}

const sum  = (a: number[]) => a.reduce((s, v) => s + v, 0);
const last = (a: number[]) => a[a.length - 1] ?? 0;

// ── GCP Quality System ────────────────────────────────────────────────────────

function buildGcpData(ws: string): DevDashboardData["gcp"] {
  const perf  = path.join(ws, "GCP_PerfStats.xlsx");
  const qual  = path.join(ws, "GCP_Quality.xlsx");
  const train = path.join(ws, "GCP_Training.xlsx");
  const act   = path.join(ws, "Activity_GCP.xlsx");

  const anySource = [perf, qual, train, act].some((f) => fs.existsSync(f));
  if (!anySource) return null;

  // 컬럼 인덱스는 dev.report.service.buildGcpBarCharts 와 동일하게 유지
  const doc   = fs.existsSync(perf)  ? parseGcpMonthGroups(perf, 4)  : {};
  const user  = fs.existsSync(perf)  ? parseGcpMonthGroups(perf, 1)  : {};
  const login = fs.existsSync(perf)  ? parseGcpMonthGroups(perf, 3)  : {};
  const qty   = fs.existsSync(qual)  ? parseGcpMonthGroups(qual, 4)  : {};
  const trn   = fs.existsSync(train) ? parseGcpMonthGroups(train, 3) : {};

  const monthsSet = new Set<string>([
    ...Object.keys(doc), ...Object.keys(user), ...Object.keys(login),
    ...Object.keys(qty), ...Object.keys(trn),
  ]);
  const months = [...monthsSet].sort().slice(-3);
  const labels = months.map(ym2label);

  const toVals = (m: Record<string, number>) => months.map((ym) => Math.round(m[ym] ?? 0));
  const docV = toVals(doc), userV = toVals(user), loginV = toVals(login),
        qtyV = toVals(qty), trnV = toVals(trn);

  // 품질 이벤트: 월 × 유형 그룹 시리즈
  const qt = fs.existsSync(qual) ? parseGcpQualityByType(qual) : { types: [], byMonth: {} };
  let quality: DashboardGroupedSeries | null = null;
  if (qt.types.length > 0 && months.length > 0) {
    const qSeries = qt.types.map((t) => ({
      name:   t,
      values: months.map((ym) => Math.round(qt.byMonth[ym]?.[t] ?? 0)),
    }));
    if (qSeries.some((s) => s.values.some((v) => v > 0))) quality = { labels, series: qSeries };
  }

  // 업무 활용(Activity_GCP.xlsx) — 도넛용 카테고리
  let activity: DashboardCategoryItem[] = [];
  if (fs.existsSync(act)) {
    try {
      const cc = readGcpCategorySheet(act);
      activity = cc.labels.map((l, i) => ({ category: l, value: cc.values[i] ?? 0 }));
    } catch (e) {
      logger.warn(`[DEV Dashboard] Activity_GCP 파싱 실패: ${(e as Error).message}`);
    }
  }

  const insight = months.length
    ? buildGcpInsightLines({ labels, months, docV, userV, loginV, qtyV, trnV, qt })
    : [];

  return {
    labels,
    docCount:    series(labels, docV),
    activeUser:  series(labels, userV),
    uniqueLogin: series(labels, loginV),
    training:    series(labels, trnV),
    quality,
    activity,
    insight,
  };
}

// ── Medcomms ──────────────────────────────────────────────────────────────────

function buildMedcommsData(ws: string): DevDashboardData["medcomms"] {
  const docTypeF = path.join(ws, "Medcomms_DocType.xlsx");
  const perfF    = path.join(ws, "Medcomms_PerfStats.xlsx");
  const actF     = path.join(ws, "Medcomms_Activity.xlsx");
  const revF     = path.join(ws, "Medcomms_Review.xlsx");
  if (![docTypeF, perfF, actF, revF].some((f) => fs.existsSync(f))) return null;

  const docMonth = fs.existsSync(perfF) ? parseGcpMonthGroups(perfF, 3) : {};
  const usrMonth = fs.existsSync(perfF) ? parseGcpMonthGroups(perfF, 1) : {};
  const logMonth = fs.existsSync(perfF) ? parseGcpMonthGroups(perfF, 2) : {};
  const perfMonths = Object.keys(docMonth).sort().slice(-3);
  const perfLabels = perfMonths.map(ym2label);

  const revIm = fs.existsSync(revF) ? parseGcpMonthGroups(revF, 8) : {};
  const revFm = fs.existsSync(revF) ? parseGcpMonthGroups(revF, 5) : {};
  const revMonths = Object.keys(revIm).sort().slice(-3);
  const revLabels = revMonths.map(ym2label);

  const docCats = fs.existsSync(docTypeF) ? parseGcpCategoryGroups(docTypeF, "Type") : [];
  const actCats = fs.existsSync(actF)     ? parseGcpCategoryGroups(actF, "Name")     : [];

  const docV = perfMonths.map((ym) => Math.round(docMonth[ym] ?? 0));
  const usrV = perfMonths.map((ym) => Math.round(usrMonth[ym] ?? 0));
  const logV = perfMonths.map((ym) => Math.round(logMonth[ym] ?? 0));

  // 문서 리뷰: Document Count + Time in Review(일) 이중 시리즈
  let review: DashboardGroupedSeries | null = null;
  if (revMonths.length) {
    const iVals = revMonths.map((ym) => Math.round(revIm[ym] ?? 0));
    const fVals = revMonths.map((ym) => round1(revFm[ym] ?? 0));
    if (iVals.some((v) => v > 0) || fVals.some((v) => v > 0)) {
      review = {
        labels: revLabels,
        series: [
          { name: "Document Count",   values: iVals },
          { name: "Time in Review(일)", values: fVals },
        ],
      };
    }
  }

  const insight = buildMedcommsInsightLines({
    perfLabels, perfMonths, docMonth, usrMonth, logMonth,
    revLabels, revMonths, revIm, revFm, docCats, actCats,
  });

  return {
    labels:   perfLabels,
    docMgmt:  series(perfLabels, docV),
    user:     series(perfLabels, usrV),
    login:    series(perfLabels, logV),
    review,
    docType:  categoryItems(docCats),
    activity: categoryItems(actCats),
    insight,
  };
}

// ── CTMS / eTMF ───────────────────────────────────────────────────────────────

function buildCtmsData(ws: string): DevDashboardData["ctms"] {
  const perfF  = path.join(ws, "Clinical_PerfStats.xlsx");
  const studyF = path.join(ws, "Clinical_Study.xlsx");
  if (!fs.existsSync(perfF) && !fs.existsSync(studyF)) return null;

  const usrMonth = fs.existsSync(perfF) ? parseGcpMonthGroups(perfF, 1) : {};
  const logMonth = fs.existsSync(perfF) ? parseGcpMonthGroups(perfF, 3) : {};
  const perfMonths = Object.keys(usrMonth).sort().slice(-3);
  const perfLabels = perfMonths.map(ym2label);

  const usrV = perfMonths.map((ym) => Math.round(usrMonth[ym] ?? 0));
  const logV = perfMonths.map((ym) => Math.round(logMonth[ym] ?? 0));

  // Study × 조직 — 상위 7개 조직 + 기타 (PDF 와 동일 기준)
  let study: DashboardGroupedSeries | null = null;
  let studies: { name: string; total: number; orgs: Record<string, number> }[] = [];
  if (fs.existsSync(studyF)) {
    studies = [...parseGcpStudyByOrg(studyF).studies].sort((a, b) => b.total - a.total);
    if (studies.length) {
      const orgTotals: Record<string, number> = {};
      studies.forEach((s) => Object.entries(s.orgs).forEach(([o, v]) => {
        orgTotals[o] = (orgTotals[o] ?? 0) + v;
      }));
      const topOrgs = Object.entries(orgTotals)
        .sort((a, b) => b[1] - a[1]).slice(0, 7).map(([o]) => o);
      const sSeries = topOrgs.map((o) => ({
        name:   o,
        values: studies.map((s) => s.orgs[o] ?? 0),
      }));
      const etc = studies.map((s) =>
        Object.entries(s.orgs).filter(([o]) => !topOrgs.includes(o))
          .reduce((acc, [, v]) => acc + v, 0));
      if (etc.some((v) => v > 0)) sSeries.push({ name: "기타", values: etc });
      study = { labels: studies.map((s) => s.name), series: sSeries };
    }
  }

  const insight = buildCtmsInsightLines({ perfLabels, perfMonths, usrMonth, logMonth, studies });

  return {
    labels: perfLabels,
    user:   series(perfLabels, usrV),
    login:  series(perfLabels, logV),
    study,
    insight,
  };
}

// ── MS Timesheet (공유 업로드) ─────────────────────────────────────────────────

async function buildTimesheetData(): Promise<{
  data: DevDashboardData["timesheet"];
  status: { present: boolean; updatedAt: string | null; sizeBytes: number | null };
}> {
  try {
    const rows = await query<{ stored_path: string; created_at: string; file_size: string }>(
      `SELECT stored_path, created_at, file_size FROM uploaded_files
       WHERE original_name = $1
       ORDER BY created_at DESC LIMIT 1`,
      [TIMESHEET_FILE]
    );
    if (!rows.length || !fs.existsSync(rows[0].stored_path)) {
      return { data: null, status: { present: false, updatedAt: null, sizeBytes: null } };
    }

    const ts = readDevMsTimesheetData(rows[0].stored_path);
    const groups = ts.groups.map((g) => ({
      groupName: g.groupName,
      chart: {
        labels: g.chartRows.map((r) => ym2label(r.month)),
        values: g.chartRows.map((r) => Math.round(r.used)),
      } as DashboardSeries,
    })).filter((g) => g.chart.labels.length > 0);

    return {
      data:   groups.length ? { groups } : null,
      status: {
        present:   true,
        updatedAt: rows[0].created_at,
        sizeBytes: Number(rows[0].file_size ?? 0),
      },
    };
  } catch (e) {
    logger.warn(`[DEV Dashboard] Timesheet 파싱 실패: ${(e as Error).message}`);
    return { data: null, status: { present: false, updatedAt: null, sizeBytes: null } };
  }
}

// ── KPI ───────────────────────────────────────────────────────────────────────

/** 마지막 달 값과 직전 달 대비 증감으로 KPI 구성 */
function buildKpis(d: DevDashboardData): DashboardKpi[] {
  const kpi = (
    key: string, label: string, unit: string, s: DashboardSeries | null
  ): DashboardKpi => {
    if (!s || !s.values.length) return { key, label, value: null, unit, delta: null };
    const v    = last(s.values);
    const prev = s.values.length >= 2 ? s.values[s.values.length - 2] : null;
    return { key, label, value: v, unit, delta: prev === null ? null : v - prev };
  };

  const kpis: DashboardKpi[] = [
    kpi("gcp_doc",      "GCP 문서 관리",      "건", d.gcp?.docCount    ?? null),
    kpi("gcp_user",     "GCP 등록 사용자",    "명", d.gcp?.activeUser  ?? null),
    kpi("gcp_login",    "GCP 일평균 접속",    "명", d.gcp?.uniqueLogin ?? null),
    kpi("mc_doc",       "Medcomms 문서 관리", "건", d.medcomms?.docMgmt ?? null),
    kpi("mc_user",      "Medcomms 사용자",    "명", d.medcomms?.user    ?? null),
    kpi("ctms_user",    "CTMS 사용자",        "명", d.ctms?.user        ?? null),
    kpi("ctms_login",   "CTMS 일평균 접속",   "명", d.ctms?.login       ?? null),
  ];

  // 최근 3개월 누적 품질 이벤트
  if (d.gcp?.quality) {
    const total = sum(d.gcp.quality.series.flatMap((s) => s.values));
    kpis.push({ key: "gcp_quality", label: "GCP 품질 이벤트(3개월)", value: total, unit: "건", delta: null });
  }

  return kpis;
}

// ── 소스 상태 ─────────────────────────────────────────────────────────────────

function buildSources(
  ws: string,
  timesheet: { present: boolean; updatedAt: string | null; sizeBytes: number | null },
): DashboardSourceStatus[] {
  const list: DashboardSourceStatus[] = DEV_SOURCES.map((s) => {
    const p = path.join(ws, s.file);
    if (!fs.existsSync(p)) {
      return { ...s, present: false, updatedAt: null, sizeBytes: null };
    }
    const st = fs.statSync(p);
    return {
      ...s,
      present:   true,
      updatedAt: st.mtime.toISOString(),
      sizeBytes: st.size,
    };
  });

  list.push({
    file:      TIMESHEET_FILE,
    label:     "Veeva MS Timesheet (업로드)",
    kind:      "uploaded",
    present:   timesheet.present,
    updatedAt: timesheet.updatedAt,
    sizeBytes: timesheet.sizeBytes,
  });

  return list;
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

export interface DevSnapshotBuildResult {
  data:    DevDashboardData;
  kpis:    DashboardKpi[];
  sources: DashboardSourceStatus[];
  /** KPI key → 일별 시리즈 (추이 차트용) */
  daily:   Record<string, DashboardSeries>;
}

/**
 * 현재 작업공간의 파일들을 읽어 개발본부 대시보드 스냅샷을 만든다.
 * 파일이 없는 섹션은 null 로 남기고(대시보드에서 "데이터 없음" 표시) 예외를 던지지 않는다.
 */
export async function buildDevSnapshot(): Promise<DevSnapshotBuildResult> {
  const ws = devWorkspacePath();
  fs.mkdirSync(ws, { recursive: true });

  logger.info(`[DEV Dashboard] 스냅샷 생성 시작 — ${ws}`);

  const ts = await buildTimesheetData();

  const data: DevDashboardData = {
    gcp:       buildGcpData(ws),
    medcomms:  buildMedcommsData(ws),
    ctms:      buildCtmsData(ws),
    timesheet: ts.data,
  };

  const kpis    = buildKpis(data);
  const sources = buildSources(ws, ts.status);

  // 일별 추이 — PerfStats 엑셀의 일별 행에서 추출 (컬럼 순서는 리포트별로 다름)
  //   GCP/Clinical: B=Active User, C=Attachment, D=Unique Login, E=Doc Count
  //   Medcomms    : B=Active User, C=Unique Login, D=Doc Count
  const daily: Record<string, DashboardSeries> = {};
  const put = (key: string, s: DashboardSeries | null) => { if (s) daily[key] = s; };
  const gcpPerf = path.join(ws, "GCP_PerfStats.xlsx");
  const mcPerf  = path.join(ws, "Medcomms_PerfStats.xlsx");
  const ctPerf  = path.join(ws, "Clinical_PerfStats.xlsx");
  put("gcp_doc",    dailyFromFile(gcpPerf, 4));
  put("gcp_user",   dailyFromFile(gcpPerf, 1));
  put("gcp_login",  dailyFromFile(gcpPerf, 3));
  put("mc_doc",     dailyFromFile(mcPerf,  3));
  put("mc_user",    dailyFromFile(mcPerf,  1));
  put("ctms_user",  dailyFromFile(ctPerf,  1));
  put("ctms_login", dailyFromFile(ctPerf,  3));

  const present = sources.filter((s) => s.present).length;
  logger.info(
    `[DEV Dashboard] 스냅샷 완료 — 소스 ${present}/${sources.length}, ` +
    `gcp:${data.gcp ? "O" : "X"} medcomms:${data.medcomms ? "O" : "X"} ` +
    `ctms:${data.ctms ? "O" : "X"} timesheet:${data.timesheet ? "O" : "X"}`
  );

  return { data, kpis, sources, daily };
}
