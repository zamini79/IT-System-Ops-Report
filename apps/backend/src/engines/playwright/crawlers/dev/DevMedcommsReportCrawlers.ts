import { VeevaReportExportCrawler } from "../veeva/VeevaReportExportCrawler";

/**
 * 개발본부 Medcomms(Medical Contents Management System) 보고서용 Excel Export 크롤러.
 * 공용 베이스(VeevaReportExportCrawler)를 Medical Vault/리포트 설정으로 구성한다.
 *
 * - URL 의 BETWEEN 날짜는 실행 시 직전 3개월(−3월 1일 ~ −1월 말일)로 자동 치환.
 * - Excel Export Options 에서 "Formatted" 선택 후 Export.
 * - 리포트 제목 미상 → titleText="" (헤더의 "« Back to reports" 기준 "…" 탐색).
 */

const MEDCOMMS_VAULTS = [
  "SKY Medical Production", "Medical Production",
  "Medcomms Production", "Medcomms", "Medical", "sk-medical",
];

abstract class MedcommsReportCrawler extends VeevaReportExportCrawler {
  protected vaultNames    = MEDCOMMS_VAULTS;
  protected titleText     = "";
  protected credEnv       = "DEV_MEDCOMMS";
  protected exportFormat: "Template" | "Formatted" = "Formatted";
  protected injectDateRange = true;
}

/** 생성 문서 구분 — A열 "Type: <category> (N)" 분포 */
export class DevMedcommsDocTypeCrawler extends MedcommsReportCrawler {
  protected reportUrlTemplate =
    "https://sk-medical.veevavault.com/ui/#reporting/viewer/0RP00000000P001?document_creation_date__v%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31";
  protected savedFilename = "Medcomms_DocType.xlsx";
}

/** Performance Statistics — D=Doc Count / B=Active User / C=Unique Login (문서관리·사용자·일일) */
export class DevMedcommsPerfStatsCrawler extends MedcommsReportCrawler {
  protected reportUrlTemplate =
    "https://sk-medical.veevavault.com/ui/#reporting/viewer/0RP00000000I005?PerformanceStatistics.OSF000000000L40%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31";
  protected savedFilename = "Medcomms_PerfStats.xlsx";
}

/** 업무 활용 현황 — A열 "Name: <category> (N)" 분포 */
export class DevMedcommsActivityCrawler extends MedcommsReportCrawler {
  protected reportUrlTemplate =
    "https://sk-medical.veevavault.com/ui/#reporting/viewer/0RP00000000P002?Activity.OSF000000000R62%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31";
  protected savedFilename = "Medcomms_Activity.xlsx";
}

/** 월별 문서 리뷰 시간 — I=Document Count / F=Time in Review */
export class DevMedcommsReviewCrawler extends MedcommsReportCrawler {
  protected reportUrlTemplate =
    "https://sk-medical.veevavault.com/ui/#reporting/viewer/0RP00000000P004?document_creation_date__v%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31";
  protected savedFilename = "Medcomms_Review.xlsx";
}
