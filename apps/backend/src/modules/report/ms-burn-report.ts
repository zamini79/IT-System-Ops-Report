/**
 * Veeva MS Burn Report (세 본부 공유 Timesheet) — 파서 + 공통 HTML
 *
 * 2026-08 부터 양식이 바뀌었다. (예: "SKB MS Burn Report 2026-08 (Flex).xlsx")
 *   - 그룹(SKB GCP / SKB GMP / SKB R&D / SKB Clinical)이 시트로 나뉜다.
 *     예전에는 YYYY-MM 월별 시트 안에서 A열 Name 으로 그룹을 구분했다.
 *   - 파일 하나가 한 달치다. A1 = "YYYY-MM MS Burn Report".
 *   - 1~2행: 요약 (라벨 행 + 값 행). GCP·GMP·R&D 는 통합(Flex) 풀을 공유한다
 *     (Total / GCP Burned / GMP Burned / R&D Burned / Remaining),
 *     Clinical 은 별도 풀이다 (Total / Burned / Remaining).
 *   - 4행: 헤더 Date | Week | Category | MSR ID/Subject | Detail | Requestor | Owner | Hours | Comment
 *   - Date 는 병합 셀이라 같은 날의 두 번째 행부터 비어 있다 → 위 행 날짜를 이어 쓴다.
 *
 * 세 본부 보고서의 Managed Service 표는 모두 같은 형식으로 출력한다:
 *   카테고리 | Subject | Detail | Date | Hours
 */

import fs from "fs";
import * as XLSX from "xlsx";
import { AppError } from "../../utils/errors";
import { logger }   from "../../utils/logger";
import { query }    from "../../config/db";

/** 업로드 시 저장되는 고정 파일명 (파일 라우터 timesheet 슬롯) */
export const TIMESHEET_FILE = "SKB_Quallity_MS_Timesheet.xlsx";

/** 본부별로 보고서에 싣는 그룹(시트) */
export const MS_GROUPS_BY_DIVISION = {
  DEV:    ["SKB Clinical", "SKB GCP", "Medcomms"],
  LHOUSE: ["SKB GMP"],
  BIO:    ["SKB R&D"],
} as const;

export interface MsWorkRow {
  category: string;
  subject:  string;
  detail:   string;
  date:     string;   // YYYY-MM-DD
  hours:    number;
}

export interface MsSummaryItem {
  label: string;      // 엑셀 원래 라벨 (예: "GCP Burned")
  value: number;
}

export interface MsGroup {
  groupName: string;
  rows:      MsWorkRow[];
  /** Hours 합계 */
  burned:    number;
  /** 시트 1~2행 요약 */
  summary:   MsSummaryItem[];
}

export interface MsBurnReport {
  /** YYYY-MM */
  month:  string;
  /** 시트 이름 → 그룹 */
  groups: Map<string, MsGroup>;
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

function excelDateToStr(serial: unknown): string {
  if (typeof serial !== "number" || serial < 1) return String(serial ?? "").trim();
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const cellStr = (v: unknown) => String(v ?? "").replace(/\r\n?/g, "\n").trim();

const round1 = (n: number) => Math.round(n * 10) / 10;

function escHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 헤더 행에서 이름으로 열 위치를 찾는다 (없으면 기본 위치) */
function colIndex(header: unknown[], names: string[], fallback: number): number {
  const norm = header.map((h) => cellStr(h).toLowerCase());
  for (const n of names) {
    const i = norm.indexOf(n.toLowerCase());
    if (i >= 0) return i;
  }
  return fallback;
}

// ── 파서 ──────────────────────────────────────────────────────────────────────

function readSheet(ws: XLSX.WorkSheet, groupName: string): { group: MsGroup; title: string; firstDate: string } {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
  const title = cellStr(rows[0]?.[0]);

  // 요약: 1행 라벨, 2행 값 (A~D 는 제목 병합 영역)
  const summary: MsSummaryItem[] = [];
  const labelRow = rows[0] ?? [];
  const valueRow = rows[1] ?? [];
  for (let c = 1; c < labelRow.length; c++) {
    const label = cellStr(labelRow[c]);
    if (!label) continue;
    const v = Number(valueRow[c]);
    if (Number.isFinite(v)) summary.push({ label, value: round1(v) });
  }

  const headerIdx = rows.findIndex((r) => cellStr(r[0]).toLowerCase() === "date");
  if (headerIdx < 0) {
    throw new AppError(400, `MS Timesheet "${groupName}" 시트에서 헤더(Date 열)를 찾지 못했습니다.`);
  }
  const header = rows[headerIdx];
  const cDate  = colIndex(header, ["Date"], 0);
  const cCat   = colIndex(header, ["Category"], 2);
  const cSubj  = colIndex(header, ["MSR ID/Subject", "Subject"], 3);
  const cDet   = colIndex(header, ["Detail"], 4);
  const cHours = colIndex(header, ["Hours"], 7);

  const out: MsWorkRow[] = [];
  let curDate   = "";
  let firstDate = "";
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const rawDate = r[cDate];
    if (rawDate !== "" && rawDate != null) {
      curDate = excelDateToStr(rawDate);
      if (!firstDate) firstDate = curDate;
    }
    const category = cellStr(r[cCat]);
    const subject  = cellStr(r[cSubj]);
    const detail   = cellStr(r[cDet]);
    const hoursRaw = r[cHours];
    // 작업 내용이 없는 날(주말 등 날짜만 있는 행)은 건너뛴다
    if (!category && !subject && !detail && (hoursRaw === "" || hoursRaw == null)) continue;
    out.push({ category, subject, detail, date: curDate, hours: round1(Number(hoursRaw) || 0) });
  }

  const burned = round1(out.reduce((s, r) => s + r.hours, 0));
  return { group: { groupName, rows: out, burned, summary }, title, firstDate };
}

/**
 * MS Burn Report 엑셀을 읽는다.
 * 예전 양식(YYYY-MM 월별 시트)이면 새 양식으로 다시 올리라는 오류를 던진다.
 */
export function readMsBurnReport(xlsxPath: string): MsBurnReport {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.readFile(xlsxPath);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/ecma-376|encrypt|password/i.test(msg)) {
      throw new AppError(400,
        "MS Timesheet 파일이 암호화(비밀번호 보호)되어 있습니다. Excel에서 비밀번호를 제거한 후 다시 업로드해 주세요.");
    }
    throw e;
  }

  if (wb.SheetNames.some((n) => /^\d{4}-\d{2}$/.test(n))) {
    throw new AppError(400,
      "업로드된 MS Timesheet 가 이전 양식(월별 시트)입니다. " +
      "새 양식(SKB MS Burn Report YYYY-MM, 그룹별 시트) 파일로 다시 업로드해 주세요.");
  }

  const groups = new Map<string, MsGroup>();
  let month = "";
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const groupName = name.trim();
    const { group, title, firstDate } = readSheet(ws, groupName);
    groups.set(groupName, group);
    if (!month) {
      month = title.match(/(\d{4})-(\d{2})/)?.[0] ?? firstDate.slice(0, 7);
    }
    logger.info(`[MS Burn] ${groupName}: ${group.rows.length}행, ${group.burned}h` +
      (group.summary.length ? ` (요약 ${group.summary.map((s) => `${s.label}=${s.value}`).join(", ")})` : ""));
  }

  if (!month) throw new AppError(400, "MS Timesheet 에서 대상 월(YYYY-MM)을 찾지 못했습니다.");
  return { month, groups };
}

/** 가장 최근에 업로드된 Timesheet (없으면 null) */
export async function findLatestTimesheet(): Promise<
  { path: string; createdAt: string; sizeBytes: number } | null
> {
  const rows = await query<{ stored_path: string; created_at: string; file_size: string }>(
    `SELECT stored_path, created_at, file_size FROM uploaded_files
     WHERE original_name = $1
     ORDER BY created_at DESC LIMIT 1`,
    [TIMESHEET_FILE]
  );
  if (!rows.length || !fs.existsSync(rows[0].stored_path)) return null;
  return {
    path:      rows[0].stored_path,
    createdAt: rows[0].created_at,
    sizeBytes: Number(rows[0].file_size ?? 0),
  };
}

// ── 공통 HTML ─────────────────────────────────────────────────────────────────

export function formatMonthKorean(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  return `${y}년 ${m}월`;
}

/** 요약 라벨을 한글로 ("GCP Burned" → "GCP 사용") */
function summaryLabelKo(label: string): string {
  return label
    .replace(/^Total$/i, "총 MS")
    .replace(/\bBurned\b/i, "사용")
    .replace(/^Remaining$/i, "잔여")
    .trim();
}

/** 그룹 요약 표 (시트 1~2행) */
function summaryTableHtml(g: MsGroup): string {
  if (!g.summary.length) return "";
  return `
      <div class="ms-summary-wrap">
        <table class="ms-summary-table">
          <thead><tr>${g.summary.map((s) => `<th>${escHtml(summaryLabelKo(s.label))}</th>`).join("")}</tr></thead>
          <tbody><tr>${g.summary.map((s) => `<td>${s.value}</td>`).join("")}</tr></tbody>
        </table>
      </div>`;
}

/** 작업 표: 카테고리 | Subject | Detail | Date | Hours */
export function msWorkTableHtml(rows: MsWorkRow[], emptyText: string): string {
  if (!rows.length) return `<div class="ms-no-data">${escHtml(emptyText)}</div>`;
  const body = rows.map((r) => `<tr>
        <td class="td-center">${escHtml(r.category)}</td>
        <td>${escHtml(r.subject)}</td>
        <td class="td-detail">${escHtml(r.detail).replace(/\n/g, "<br>")}</td>
        <td class="td-nowrap">${escHtml(r.date)}</td>
        <td class="td-nowrap td-num">${r.hours}</td>
      </tr>`).join("");
  return `<table class="ms-table">
      <thead><tr>
        <th style="width:18%">카테고리</th>
        <th style="width:24%">Subject</th>
        <th>Detail</th>
        <th style="width:10%">Date</th>
        <th style="width:7%">Hours</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/**
 * Managed Service 페이지 본문 — 1) MS 사용 현황(요약) + 2) 그룹별 주요 현황(작업 표).
 * 시트가 없는 그룹은 "데이터 없음"으로 표시한다.
 */
export function msSectionsHtml(report: MsBurnReport, groupNames: readonly string[]): string {
  const monthLabel = formatMonthKorean(report.month);
  const present = groupNames.map((n) => ({ name: n, g: report.groups.get(n) }));

  const summaryHtml = present.map(({ name, g }) => `
      <div class="ms-chart-subtitle" style="margin-top:6px"><strong>${escHtml(name)}</strong>
        ${g ? ` — ${g.rows.length}건 · ${g.burned}시간` : " — 이번 달 시트 없음"}</div>
      ${g ? summaryTableHtml(g) : ""}`).join("");

  const tablesHtml = present.map(({ name, g }) => `
    <div class="ms-section">
      <div class="ms-table-title">${escHtml(monthLabel)} ${escHtml(name)} Managed Service 주요 현황</div>
      ${msWorkTableHtml(g?.rows ?? [], `해당 월 ${name} 세부 데이터가 없습니다.`)}
    </div>`).join("");

  return `
    <div class="ms-section">
      <div class="ms-section-title">1) ${escHtml(monthLabel)} MS 사용 현황</div>
      ${summaryHtml}
      <div class="ms-chart-subtitle" style="margin-top:6px">※ SKB GCP · GMP · R&amp;D 는 전사 통합(Flex) MS 를 함께 사용합니다.</div>
    </div>
    ${tablesHtml}`;
}

/** 대시보드용: 그룹별 이번 달 사용 시간 (단일 월 시리즈) */
export function msDashboardGroups(
  report: MsBurnReport,
  groups: { sheet: string; label: string }[],
  ym2label: (ym: string) => string,
): { groupName: string; chart: { labels: string[]; values: number[] } }[] {
  return groups
    .map(({ sheet, label }) => ({ label, g: report.groups.get(sheet) }))
    .filter((x): x is { label: string; g: MsGroup } => !!x.g)
    .map(({ label, g }) => ({
      groupName: label,
      chart: { labels: [ym2label(report.month)], values: [g.burned] },
    }));
}
