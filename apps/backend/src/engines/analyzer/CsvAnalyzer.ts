/**
 * CsvAnalyzer
 *
 * ExcelAnalyzer 와 동일한 인터페이스를 유지하면서
 * CSV 파일을 단일 시트로 파싱합니다.
 *
 * SheetJS 의 CSV 지원을 사용하므로 BOM, 다양한 구분자(쉼표/탭)를 자동 처리합니다.
 */

import * as XLSX from "xlsx";
import { analyzeSheet } from "./ExcelAnalyzer";
import type { SpreadsheetAnalysisResult } from "./types";

export async function analyzeCsv(filePath: string): Promise<SpreadsheetAnalysisResult> {
  // SheetJS 는 확장자가 .csv 이면 CSV 파서를 자동 선택합니다.
  const workbook = XLSX.readFile(filePath, {
    cellDates: true,
    raw:       false, // 셀 값을 문자열로 정규화
  });

  // CSV 는 항상 시트가 1개
  const sheetName = workbook.SheetNames[0] ?? "Sheet1";
  const ws        = workbook.Sheets[sheetName];

  const sheet = analyzeSheet(ws, sheetName);

  return {
    type:       "csv",
    sheets:     [sheet],
    sheetCount: 1,
  };
}
