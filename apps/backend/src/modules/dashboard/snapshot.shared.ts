/**
 * 대시보드 스냅샷 공용 헬퍼
 *
 * 본부별 빌더(dev / lhouse / bio)가 함께 쓰는 변환·집계 도구.
 * 수치 계산은 각 PDF 리포트 서비스의 파싱 함수를 그대로 재사용하고,
 * 여기서는 "차트가 먹는 형태"로 바꾸는 일만 한다.
 */

import fs   from "fs";
import path from "path";
import * as XLSX from "xlsx";

import type {
  DashboardCategoryItem,
  DashboardKpi,
  DashboardSeries,
  DashboardSourceStatus,
} from "./dashboard.types";

import { logger } from "../../utils/logger";
import { query }  from "../../config/db";
import { readDevMsTimesheetData }    from "../report/dev.report.service";
import { readMsTimesheetData as readLhouseTimesheet } from "../report/lhouse.report.service";
import { readMsTimesheetData as readBioTimesheet }    from "../report/bio.report.service";

// ── 소스 정의 ─────────────────────────────────────────────────────────────────

export interface SourceDef {
  file:  string;
  label: string;
  kind:  "collected" | "uploaded";
}

/** 세 본부 공유 업로드 파일 — DB 에서 파일명으로 전역 조회(jobId 무관) */
export const TIMESHEET_FILE = "SKB_Quallity_MS_Timesheet.xlsx";

// ── 변환 유틸 ─────────────────────────────────────────────────────────────────

/** "2026-04" → "4월" */
export const ym2label = (ym: string) => `${parseInt(ym.slice(5, 7), 10)}월`;

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** 값이 모두 0 이거나 라벨이 없으면 null (차트를 그리지 않음) */
export function seriesOrNull(labels: string[], values: number[]): DashboardSeries | null {
  if (!labels.length || values.every((v) => v === 0)) return null;
  return { labels, values };
}

export function categoryItems(cs: { category?: string; label?: string; value: number }[]): DashboardCategoryItem[] {
  return cs.map((c) => ({ category: c.category ?? c.label ?? "", value: c.value }));
}

/** 마지막 값 + 직전 값 대비 증감으로 KPI 한 칸 구성 */
export function kpiFromSeries(
  key: string, label: string, unit: string, s: DashboardSeries | null
): DashboardKpi {
  if (!s || !s.values.length) return { key, label, value: null, unit, delta: null };
  const v    = s.values[s.values.length - 1] ?? 0;
  const prev = s.values.length >= 2 ? s.values[s.values.length - 2] : null;
  return { key, label, value: v, unit, delta: prev === null ? null : v - prev };
}

// ── 일별 시리즈 (추이용) ───────────────────────────────────────────────────────

/**
 * Veeva Performance Statistics 엑셀에서 **일별 값**을 뽑는다.
 *
 * 이 리포트는 A열에 두 종류의 행이 섞여 있다:
 *   "Created Date (Month): 2026 Apr (30)"  ← 월 그룹 헤더 (값 = 월평균)
 *   "2026-04-01"                            ← 일별 행 (값 = 그날 값)
 * 기존 PDF 경로는 월 헤더만 읽어 월평균 차트를 만든다(그대로 유지).
 * 대시보드 추이는 일별 행을 읽어 최근 약 3개월(91일)의 실제 일별 추이를 만든다.
 *
 * @param valueColIndex 값 컬럼 인덱스. 리포트별로 컬럼 순서가 다르므로 호출부에서 지정한다.
 */
export function parseDailySeries(xlsxPath: string, valueColIndex: number): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const wb   = XLSX.readFile(xlsxPath);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" }
    ) as unknown[][];
    for (const r of rows) {
      const a = String(r[0] ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) continue;   // 월 헤더·합계 행 제외
      const v = Number(r[valueColIndex]);
      if (Number.isFinite(v)) out[a] = v;
    }
  } catch (e) {
    logger.warn(`[Dashboard] 일별 파싱 실패 (${path.basename(xlsxPath)}): ${(e as Error).message}`);
  }
  return out;
}

/** 날짜 → 값 맵을 날짜 오름차순 시리즈로 (labels = YYYY-MM-DD) */
export function toDailySeries(map: Record<string, number>): DashboardSeries | null {
  const dates = Object.keys(map).sort();
  if (!dates.length) return null;
  return { labels: dates, values: dates.map((d) => Math.round(map[d])) };
}

/** 파일이 있으면 해당 컬럼의 일별 시리즈를, 없으면 null */
export function dailyFromFile(filePath: string, valueColIndex: number): DashboardSeries | null {
  if (!fs.existsSync(filePath)) return null;
  return toDailySeries(parseDailySeries(filePath, valueColIndex));
}

// ── 소스 상태 ─────────────────────────────────────────────────────────────────

export interface TimesheetStatus {
  present:   boolean;
  updatedAt: string | null;
  sizeBytes: number | null;
}

/** 작업공간의 파일 존재/수정시각 + 공유 타임시트 상태를 합쳐 반환 */
export function buildSourceStatus(
  ws: string,
  defs: SourceDef[],
  timesheet: TimesheetStatus,
): DashboardSourceStatus[] {
  const list: DashboardSourceStatus[] = defs.map((s) => {
    const p = path.join(ws, s.file);
    if (!fs.existsSync(p)) return { ...s, present: false, updatedAt: null, sizeBytes: null };
    const st = fs.statSync(p);
    return { ...s, present: true, updatedAt: st.mtime.toISOString(), sizeBytes: st.size };
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

// ── 공유 MS Timesheet ─────────────────────────────────────────────────────────

export interface TimesheetSection {
  data:   { groups: { groupName: string; chart: DashboardSeries }[] } | null;
  status: TimesheetStatus;
}

/**
 * 공유 Timesheet 파일을 읽어 "그룹별 월간 사용 MS" 시리즈로 만든다.
 *
 * 본부별로 리포트 서비스의 파서가 다르다(개발본부는 3개 그룹, L HOUSE·BIO 는 단일 집계).
 * 각 PDF 와 같은 값이 나오도록 본부별 파서를 그대로 사용한다.
 */
export async function buildTimesheetSection(
  division: "DEV" | "LHOUSE" | "BIO"
): Promise<TimesheetSection> {
  const empty: TimesheetSection = {
    data: null, status: { present: false, updatedAt: null, sizeBytes: null },
  };

  try {
    const rows = await query<{ stored_path: string; created_at: string; file_size: string }>(
      `SELECT stored_path, created_at, file_size FROM uploaded_files
       WHERE original_name = $1
       ORDER BY created_at DESC LIMIT 1`,
      [TIMESHEET_FILE]
    );
    if (!rows.length || !fs.existsSync(rows[0].stored_path)) return empty;

    const p = rows[0].stored_path;
    const status: TimesheetStatus = {
      present:   true,
      updatedAt: rows[0].created_at,
      sizeBytes: Number(rows[0].file_size ?? 0),
    };

    let groups: { groupName: string; chart: DashboardSeries }[] = [];

    if (division === "DEV") {
      // 개발본부: SKB Clinical / SKB GCP / Medcomms 3개 그룹
      const ts = readDevMsTimesheetData(p);
      groups = ts.groups.map((g) => ({
        groupName: g.groupName,
        chart: {
          labels: g.chartRows.map((r) => ym2label(r.month)),
          values: g.chartRows.map((r) => Math.round(r.used)),
        },
      }));
    } else {
      // L HOUSE · BIO: 단일 집계 (본부 이름을 그룹명으로)
      const read = division === "LHOUSE" ? readLhouseTimesheet : readBioTimesheet;
      const name = division === "LHOUSE" ? "L HOUSE 공장" : "Bio연구본부";
      const ts   = read(p);
      groups = [{
        groupName: name,
        chart: {
          labels: ts.chartRows.map((r) => ym2label(r.month)),
          values: ts.chartRows.map((r) => Math.round(r.used)),
        },
      }];
    }

    groups = groups.filter((g) => g.chart.labels.length > 0);
    return { data: groups.length ? { groups } : null, status };

  } catch (e) {
    logger.warn(`[Dashboard] Timesheet 파싱 실패(${division}): ${(e as Error).message}`);
    return empty;
  }
}
