/**
 * Report Engine 내부 타입 정의
 */

import type { DivisionCode } from "../playwright/types";
import type {
  SpreadsheetAnalysisResult,
  StoredAnalysisResult,
} from "../analyzer/types";

// ── 본부별 시스템 순서 ────────────────────────────────────────────────────────

export const SYSTEM_ORDER: Record<DivisionCode, string[]> = {
  BIO:    ["EDMS", "ELN", "GCLP_LIMS"],
  DEV:    ["EQMS", "EDMS", "ELMS", "CTMS", "ETMF", "MEDCOMMS"],
  LHOUSE: ["EQMS", "EDMS", "ELMS"],
};

/** 보고서·화면 표시용 시스템 레이블 */
export const SYSTEM_LABELS: Record<string, string> = {
  EDMS:      "eDMS",
  ELN:       "ELN",
  GCLP_LIMS: "GCLP LIMS",
  EQMS:      "eQMS",
  ELMS:      "eLMS",
  CTMS:      "CTMS",
  ETMF:      "eTMF",
  MEDCOMMS:  "Medcomms",
  ERP:       "ERP",
  MES:       "MES",
  GitLab:    "GitLab",
  Jira:      "Jira",
  PMS:       "PMS",
};

// ── 보고서 빌더 내부 데이터 모델 ──────────────────────────────────────────────

export interface ReportJobInfo {
  id:           string;
  divisionCode: DivisionCode;
  divisionName: string;
  status:       string;
  createdAt:    Date;
}

export interface SystemReportData {
  systemName:         string;
  label:              string;
  crawlStatus:        string;        // PENDING | RUNNING | COMPLETED | FAILED
  crawlError:         string | null;
  screenshotBase64:   string | null; // data:image/png;base64,…
  screenshotCapturedAt: string | null;
  downloadedAnalysis: SpreadsheetAnalysisResult | null;
}

export interface UploadedFileInfo {
  id:             string;
  originalName:   string;
  storedPath:     string;
  fileType:       string;
  fileSize:       number;
  analysisResult: StoredAnalysisResult | null;
  createdAt:      Date;
}

export interface ReportPeriod {
  from: Date;
  to:   Date;
}

export interface ReportData {
  job:           ReportJobInfo;
  systems:       SystemReportData[];
  uploadedFiles: UploadedFileInfo[];
  period:        ReportPeriod;
}
