/**
 * Analyzer 공통 타입 정의
 */

// ── 스프레드시트 (Excel / CSV) ────────────────────────────────────────────────

/** 숫자 컬럼 집계 결과 */
export interface NumericSummary {
  sum:   number;
  avg:   number;
  max:   number;
  min:   number;
  count: number; // null 이 아닌 값의 개수
}

/** 단일 시트 분석 결과 */
export interface SheetResult {
  name:        string;
  headers:     string[];
  rows:        Record<string, unknown>[];  // 최대 MAX_ROWS 행
  totalRows:   number;                    // 실제 전체 행 수
  summary:     Record<string, NumericSummary>; // 숫자 컬럼만 포함
  dateColumns: string[];                  // 날짜로 감지된 컬럼명
  recentRows:  Record<string, unknown>[]; // 최근 3개월 날짜 조건 매칭 행
}

export interface SpreadsheetAnalysisResult {
  type:       "excel" | "csv";
  sheets:     SheetResult[];
  sheetCount: number;
}

// ── PDF ───────────────────────────────────────────────────────────────────────

export interface PdfPage {
  pageNum: number;
  text:    string;
}

export interface PdfAnalysisResult {
  type:      "pdf";
  pageCount: number;
  pages:     PdfPage[];
  fullText:  string;
}

// ── 이미지 ────────────────────────────────────────────────────────────────────

export interface ImageAnalysisResult {
  type:      "image";
  width:     number;
  height:    number;
  format:    string;  // png | jpeg | webp | gif | …
  size:      number;  // bytes
  channels:  number;  // 3=RGB, 4=RGBA
  hasAlpha:  boolean;
}

// ── 공용 래퍼 ─────────────────────────────────────────────────────────────────

export type AnalysisResult =
  | SpreadsheetAnalysisResult
  | PdfAnalysisResult
  | ImageAnalysisResult;

/** DB에 저장되는 최상위 구조 */
export interface StoredAnalysisResult {
  status:      "completed" | "failed" | "pending";
  analyzedAt?: string;       // ISO string
  error?:      string;
  result?:     AnalysisResult;
}
