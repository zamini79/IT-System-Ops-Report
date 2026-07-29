import { VeevaReportExportCrawler } from "../veeva/VeevaReportExportCrawler";

/**
 * 개발본부 CTMS/eTMF(Clinical Trial Management System) 보고서용 Excel Export 크롤러.
 * 공용 베이스(VeevaReportExportCrawler)를 Clinical Vault/리포트 설정으로 구성한다.
 *
 * - Excel Export Options 에서 "Formatted" 선택 후 Export.
 * - 리포트 제목 미상 → titleText="" (헤더의 "« Back to reports" 기준 "…" 탐색).
 */

const CLINICAL_VAULTS = [
  "SKY Clinical Production", "Clinical Production",
  "CTMS Production", "CTMS", "Clinical", "sk-clinical",
];

abstract class CtmsReportCrawler extends VeevaReportExportCrawler {
  protected vaultNames    = CLINICAL_VAULTS;
  protected titleText     = "";
  protected credEnv       = "DEV_CLINICAL";
  protected exportFormat: "Template" | "Formatted" = "Formatted";
}

/** Performance Statistics — B=Active User / C=Unique Login (사용자·일일 사용자) */
export class DevCtmsPerfStatsCrawler extends CtmsReportCrawler {
  protected reportUrlTemplate =
    "https://sk-clinical.veevavault.com/ui/#reporting/viewer/0RP00000001F002?PerformanceStatistics.OSF000000000V40%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31";
  protected savedFilename   = "Clinical_PerfStats.xlsx";
  protected injectDateRange = true;   // BETWEEN 날짜 직전 3개월로 치환
}

/** Study별 사용자 현황 — A열 "Study: <product> (N)" 안의 "Organization: <org> (M)" */
export class DevCtmsStudyCrawler extends CtmsReportCrawler {
  protected reportUrlTemplate =
    "https://sk-clinical.veevavault.com/ui/#reporting/viewer/0RP00000001F001";
  protected savedFilename   = "Clinical_Study.xlsx";
  protected injectDateRange = false;  // 이 리포트는 날짜 필터 파라미터 없음
}
