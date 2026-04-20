/**
 * ExcelAnalyzer (SheetJS 기반)
 *
 * - 모든 시트 파싱
 * - 헤더 자동 감지 (첫 번째 행)
 * - 숫자 컬럼 집계 (합계·평균·최대·최소)
 * - 날짜 컬럼 감지 + 최근 3개월 필터링
 */

import * as XLSX from "xlsx";
import type { SpreadsheetAnalysisResult, SheetResult, NumericSummary } from "./types";

/** rows 는 최대 이 수만큼 반환 (집계는 전체 행 대상) */
const MAX_ROWS = 1_000;

/** 최근 N개월 필터 기준 */
const RECENT_MONTHS = 3;

// ── 날짜 감지 ──────────────────────────────────────────────────────────────────

const DATE_STRING_RE = /^\d{4}[./-]\d{1,2}[./-]\d{1,2}/;

function isDateValue(v: unknown): boolean {
  if (v instanceof Date) return !isNaN(v.getTime());
  if (typeof v === "string") return DATE_STRING_RE.test(v.trim());
  return false;
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    const d = new Date(v.trim());
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function threeMonthsAgo(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - RECENT_MONTHS);
  return d;
}

// ── 시트 분석 ─────────────────────────────────────────────────────────────────

export function analyzeSheet(
  ws: XLSX.WorkSheet,
  sheetName: string
): SheetResult {
  // header: true → 첫 번째 행이 헤더, cellDates는 readFile 옵션에서 지정
  const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, {
    defval: null,
    raw:    false, // 날짜를 문자열로 변환 (cellDates:true 와 함께 사용)
  });

  const totalRows = raw.length;
  const rows      = raw.slice(0, MAX_ROWS);

  if (!rows.length) {
    return {
      name: sheetName, headers: [], rows: [], totalRows: 0,
      summary: {}, dateColumns: [], recentRows: [],
    };
  }

  // 헤더: 첫 번째 행의 키
  const headers = Object.keys(rows[0]);

  // ── 컬럼 분류 ─────────────────────────────────────────────────────────────

  const numericCols: Set<string> = new Set();
  const dateCols:    Set<string> = new Set();

  // 모든 행에서 각 컬럼의 값 타입을 샘플링
  for (const col of headers) {
    let numCount  = 0;
    let dateCount = 0;
    let nonNull   = 0;

    for (const row of raw) {
      const v = row[col];
      if (v === null || v === undefined || v === "") continue;
      nonNull++;
      if (typeof v === "number" || (typeof v === "string" && v !== "" && !isNaN(Number(v)))) {
        numCount++;
      }
      if (isDateValue(v)) dateCount++;
    }

    if (nonNull === 0) continue;
    if (dateCount / nonNull >= 0.7) dateCols.add(col);
    else if (numCount / nonNull >= 0.7) numericCols.add(col);
  }

  // ── 숫자 집계 (전체 행 대상) ──────────────────────────────────────────────

  const summary: Record<string, NumericSummary> = {};

  for (const col of numericCols) {
    let sum = 0, max = -Infinity, min = Infinity, count = 0;

    for (const row of raw) {
      const v = row[col];
      if (v === null || v === undefined || v === "") continue;
      const n = Number(v);
      if (isNaN(n)) continue;
      sum += n;
      if (n > max) max = n;
      if (n < min) min = n;
      count++;
    }

    if (count > 0) {
      summary[col] = { sum, avg: sum / count, max, min, count };
    }
  }

  // ── 최근 3개월 필터링 ─────────────────────────────────────────────────────

  const cutoff   = threeMonthsAgo();
  const dateColArr = [...dateCols];
  let recentRows: Record<string, unknown>[] = [];

  if (dateColArr.length > 0) {
    recentRows = rows.filter((row) =>
      dateColArr.some((col) => {
        const d = toDate(row[col]);
        return d !== null && d >= cutoff;
      })
    );
  }

  return {
    name:        sheetName,
    headers,
    rows,
    totalRows,
    summary,
    dateColumns: dateColArr,
    recentRows,
  };
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

export async function analyzeExcel(filePath: string): Promise<SpreadsheetAnalysisResult> {
  const workbook = XLSX.readFile(filePath, {
    cellDates: true,   // 날짜 셀을 JS Date 객체로 변환
    dense:     false,
  });

  const sheets: SheetResult[] = workbook.SheetNames.map((name) =>
    analyzeSheet(workbook.Sheets[name], name)
  );

  return {
    type:       "excel",
    sheets,
    sheetCount: sheets.length,
  };
}
