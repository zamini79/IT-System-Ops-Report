import { VeevaReportExportCrawler } from "../veeva/VeevaReportExportCrawler";

/**
 * 개발본부 GCP Quality System 보고서용 Excel Export 크롤러 3종.
 * 공용 베이스(VeevaReportExportCrawler)를 GCP Vault/리포트 설정으로 구성한다.
 *
 * - URL 의 BETWEEN 날짜는 실행 시 직전 3개월(−3월 1일 ~ −1월 말일)로 자동 치환.
 * - Excel Export Options 에서 "Formatted" 선택 후 Export.
 * - 리포트 제목은 미상이므로 titleText="" → "« Back to reports" 기준으로 "…" 탐색.
 */

const GCP_VAULTS = ["SKY GCP Production", "GCP Production", "GCP", "sk-gcp"];

/** Performance Statistics — Doc Count / Active User / Unique Login (문서/사용자/일일 사용) */
export class DevGcpPerfStatsCrawler extends VeevaReportExportCrawler {
  protected reportUrlTemplate =
    "https://sk-gcp.veevavault.com/ui/#reporting/viewer/0RP000000017001?PerformanceStatistics.OSF000000000K40%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31";
  protected vaultNames    = GCP_VAULTS;
  protected titleText     = "";
  protected savedFilename = "GCP_PerfStats.xlsx";
  protected exportFormat: "Template" | "Formatted" = "Formatted";
  protected injectDateRange = true;
}

/** Quality Events — Quality Event Type (품질 관리 현황) */
export class DevGcpQualityCrawler extends VeevaReportExportCrawler {
  protected reportUrlTemplate =
    "https://sk-gcp.veevavault.com/ui/#reporting/viewer/0RP000000021001?OSY000000000R13.OSF000000000X71%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31&OSY000000000R13.OSF000000000X71%2C%2C%2CBETWEEN%2C%2C%2C1=2026-03-01%3B%3B2026-05-31";
  protected vaultNames    = GCP_VAULTS;
  protected titleText     = "";
  protected savedFilename = "GCP_Quality.xlsx";
  protected exportFormat: "Template" | "Formatted" = "Formatted";
  protected injectDateRange = true;
}

/** Training — Name 분포 (교육 관리 현황) */
export class DevGcpTrainingCrawler extends VeevaReportExportCrawler {
  protected reportUrlTemplate =
    "https://sk-gcp.veevavault.com/ui/#reporting/viewer/0RP000000019001?Activity.OSF000000001362%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31";
  protected vaultNames    = GCP_VAULTS;
  protected titleText     = "";
  protected savedFilename = "GCP_Training.xlsx";
  protected exportFormat: "Template" | "Formatted" = "Formatted";
  protected injectDateRange = true;
}
