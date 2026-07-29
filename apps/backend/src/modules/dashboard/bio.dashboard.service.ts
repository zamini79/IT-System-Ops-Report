/**
 * Bio연구본부 대시보드 스냅샷 빌더 (Veeva eDMS — 자동 수집분)
 *
 * PDF 리포트(bio.report.service)의 "1. Veeva System" 과 **동일한 파싱·계산 함수**를
 * 재사용해 차트용 숫자 데이터(JSON)를 만든다.
 *
 * ※ 임검분 LIMS · 전자연구노트(ELN) 는 자동 수집 대상이 아니고(수동 업로드 전용)
 *   별도 PDF 리포트이므로 이 스냅샷에는 포함하지 않는다.
 */

import fs   from "fs";
import path from "path";

import type {
  BioDashboardData,
  DashboardCategoryItem,
  DashboardKpi,
  DashboardSeries,
  DashboardSourceStatus,
} from "./dashboard.types";
import { DASHBOARD_JOB_IDS } from "./dashboard.types";

import { logger } from "../../utils/logger";
import { parseGcpMonthGroups } from "../report/dev.report.service";
import {
  readScrapedTable,
  parseBioGroupDistribution,
  buildBioInsightLines,
} from "../report/bio.report.service";
import {
  SourceDef, buildTimesheetSection, seriesOrNull, ym2label,
  kpiFromSeries, buildSourceStatus, dailyFromFile,
} from "./snapshot.shared";

/** BIO 대시보드가 사용하는 소스 파일 */
export const BIO_SOURCES: SourceDef[] = [
  { file: "BIO_Activity.json",  label: "Veeva 업무 활용(Activity)", kind: "collected" },
  { file: "BIO_PerfStats.xlsx", label: "Veeva Performance Statistics", kind: "collected" },
  { file: "BIO_DocType.json",   label: "Veeva 생성 문서 구분",       kind: "collected" },
];

export function bioWorkspacePath(): string {
  const uploadDir = process.env.UPLOAD_DIR ?? "uploads";
  return path.resolve(uploadDir, DASHBOARD_JOB_IDS.BIO, "uploads");
}

// ── Veeva (eDMS) ──────────────────────────────────────────────────────────────

function buildVeevaData(ws: string): BioDashboardData["veeva"] {
  const actT     = readScrapedTable(path.join(ws, "BIO_Activity.json"));
  const docT     = readScrapedTable(path.join(ws, "BIO_DocType.json"));
  const perfXlsx = path.join(ws, "BIO_PerfStats.xlsx");
  const hasPerf  = fs.existsSync(perfXlsx);

  if (!actT && !docT && !hasPerf) return null;

  // 정규식·컬럼 인덱스는 bio.report.service.buildBioVeevaCharts 와 동일하게 유지
  const actDist = actT
    ? parseBioGroupDistribution(actT, /Name:\s*(.+?)\s*(?:\(([\d,]+)\))?\s*$/i, /activity\s*count|count/i)
    : [];
  const docDist = docT
    ? parseBioGroupDistribution(docT, /Type:\s*(.+?)\s*\(([\d,]+)\)/i)
    : [];

  let labels: string[] = [];
  let docV: number[] = [], userV: number[] = [], loginV: number[] = [];
  if (hasPerf) {
    const docM   = parseGcpMonthGroups(perfXlsx, 4);  // E Doc Count
    const userM  = parseGcpMonthGroups(perfXlsx, 1);  // B Active User
    const loginM = parseGcpMonthGroups(perfXlsx, 3);  // D Unique Login
    const monthsSet = new Set<string>([
      ...Object.keys(docM), ...Object.keys(userM), ...Object.keys(loginM),
    ]);
    const months = [...monthsSet].sort().slice(-3);
    labels = months.map(ym2label);
    docV   = months.map((ym) => Math.round(docM[ym]   ?? 0));
    userV  = months.map((ym) => Math.round(userM[ym]  ?? 0));
    loginV = months.map((ym) => Math.round(loginM[ym] ?? 0));
  }

  const toItems = (d: { label: string; value: number }[]): DashboardCategoryItem[] =>
    d.map((x) => ({ category: x.label, value: x.value }));

  const insight = buildBioInsightLines({
    perfLabels: labels, docV, userV, loginV, actDist, docDist,
  });

  return {
    labels,
    docCount:    seriesOrNull(labels, docV),
    activeUser:  seriesOrNull(labels, userV),
    uniqueLogin: seriesOrNull(labels, loginV),
    activity:    toItems(actDist),
    docType:     toItems(docDist),
    insight,
  };
}

// ── KPI ───────────────────────────────────────────────────────────────────────

function buildKpis(d: BioDashboardData): DashboardKpi[] {
  const kpis: DashboardKpi[] = [
    kpiFromSeries("bio_doc",   "문서 관리",   "건", d.veeva?.docCount    ?? null),
    kpiFromSeries("bio_user",  "등록 사용자", "명", d.veeva?.activeUser  ?? null),
    kpiFromSeries("bio_login", "일평균 접속", "명", d.veeva?.uniqueLogin ?? null),
  ];

  if (d.veeva?.activity.length) {
    const total = d.veeva.activity.reduce((s, c) => s + c.value, 0);
    kpis.push({ key: "bio_activity", label: "업무 활동(3개월)", value: total, unit: "건", delta: null });
  }
  if (d.veeva?.docType.length) {
    const total = d.veeva.docType.reduce((s, c) => s + c.value, 0);
    kpis.push({ key: "bio_doctype", label: "생성 문서 합계", value: total, unit: "건", delta: null });
  }

  return kpis;
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

export interface BioSnapshotBuildResult {
  data:    BioDashboardData;
  kpis:    DashboardKpi[];
  sources: DashboardSourceStatus[];
  daily:   Record<string, DashboardSeries>;
}

export async function buildBioSnapshot(): Promise<BioSnapshotBuildResult> {
  const ws = bioWorkspacePath();
  fs.mkdirSync(ws, { recursive: true });

  logger.info(`[BIO Dashboard] 스냅샷 생성 시작 — ${ws}`);

  const ts = await buildTimesheetSection("BIO");

  const data: BioDashboardData = {
    veeva:     buildVeevaData(ws),
    timesheet: ts.data,
  };

  const kpis    = buildKpis(data);
  const sources = buildSourceStatus(ws, BIO_SOURCES, ts.status);

  // 일별 추이 — BIO_PerfStats: B=Active User, D=Unique Login, E=Doc Count
  const daily: Record<string, DashboardSeries> = {};
  const perfPath = path.join(ws, "BIO_PerfStats.xlsx");
  const put = (key: string, s: DashboardSeries | null) => { if (s) daily[key] = s; };
  put("bio_doc",   dailyFromFile(perfPath, 4));
  put("bio_user",  dailyFromFile(perfPath, 1));
  put("bio_login", dailyFromFile(perfPath, 3));

  logger.info(
    `[BIO Dashboard] 스냅샷 완료 — 소스 ${sources.filter((s) => s.present).length}/${sources.length}, ` +
    `veeva:${data.veeva ? "O" : "X"} timesheet:${data.timesheet ? "O" : "X"}`
  );

  return { data, kpis, sources, daily };
}
