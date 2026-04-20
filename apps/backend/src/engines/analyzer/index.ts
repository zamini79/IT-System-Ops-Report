/**
 * Analyzer Dispatcher
 *
 * MIME 타입에 따라 적절한 분석기를 선택하여 실행합니다.
 *
 * 사용 예)
 *   import { analyze } from "../../engines/analyzer";
 *   const result = await analyze(storedPath, mimeType);
 */

import { analyzeExcel } from "./ExcelAnalyzer";
import { analyzeCsv }   from "./CsvAnalyzer";
import { analyzePdf }   from "./PdfAnalyzer";
import { analyzeImage } from "./ImageAnalyzer";
import type { AnalysisResult } from "./types";

export type { AnalysisResult, StoredAnalysisResult } from "./types";

// ── MIME → 분석기 매핑 ────────────────────────────────────────────────────────

const EXCEL_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.ms-excel",                                           // xls
]);

const CSV_MIMES = new Set([
  "text/csv",
  "application/csv",
]);

const PDF_MIMES = new Set([
  "application/pdf",
]);

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

// ── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * 파일 경로와 MIME 타입을 받아 분석 결과를 반환합니다.
 *
 * @throws Error  지원하지 않는 MIME 타입인 경우
 */
export async function analyze(
  filePath: string,
  mimeType: string
): Promise<AnalysisResult> {
  const mime = mimeType.toLowerCase();

  if (EXCEL_MIMES.has(mime)) return analyzeExcel(filePath);
  if (CSV_MIMES.has(mime))   return analyzeCsv(filePath);
  if (PDF_MIMES.has(mime))   return analyzePdf(filePath);
  if (IMAGE_MIMES.has(mime)) return analyzeImage(filePath);

  throw new Error(`지원하지 않는 파일 형식입니다: ${mimeType}`);
}

export { analyzeExcel, analyzeCsv, analyzePdf, analyzeImage };
