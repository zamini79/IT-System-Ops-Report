import { VeevaTableScrapeCrawler }  from "../veeva/VeevaTableScrapeCrawler";
import { VeevaReportExportCrawler } from "../veeva/VeevaReportExportCrawler";

/**
 * Bio연구본부(R&D) Veeva 시스템 사용 현황 보고서용 수집 크롤러.
 * GCP Quality System 과 동일한 컨셉이나, 각 리포트는 Excel export 없이
 * 화면의 표를 직접 스크래핑하여 { headers, rows } JSON 으로 저장한다.
 *
 *  - 공용 베이스(VeevaTableScrapeCrawler): 로그인 → Vault 선택 → 리포트 URL 접속 → 표 덤프
 *  - URL 의 BETWEEN 날짜는 실행 시 직전 3개월(−3월 1일 ~ −1월 말일)로 자동 치환
 *  - 표 해석(컬럼/그룹 행 파싱)은 bio.report.service 에서 수행
 */

const BIO_VAULTS = ["SKY BIO R&D Production", "BIO R&D Production", "BIO R&D", "RD Production", "R&D", "sk-rd"];

/** Activity (Task) Count — 업무 활용 현황 (Name: 카테고리 × Activity count) */
export class BioRdActivityCrawler extends VeevaTableScrapeCrawler {
  protected reportUrlTemplate =
    "https://sk-rd.veevavault.com/ui/#reporting/viewer/0RP00000000P003?Activity.OSF000000001362%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31";
  protected vaultNames    = BIO_VAULTS;
  protected titleText     = "";
  protected savedFilename = "BIO_Activity.json";
  protected injectDateRange = true;
  protected credEnv = "BIO_RD";
}

/**
 * Performance Statistics — 문서 관리 / 사용자 / 일일 사용.
 * Excel Export(Formatted)로 다운로드하여 GCP 와 동일한 컬럼 파싱(B/D/E, 월별 평균)을 적용한다.
 *   B(1)=Active User Count, D(3)=Unique Login Count, E(4)=Doc Count
 */
export class BioRdPerfStatsCrawler extends VeevaReportExportCrawler {
  protected reportUrlTemplate =
    "https://sk-rd.veevavault.com/ui/#reporting/viewer/0RP00000000T001?PerformanceStatistics.OSF000000000K40%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31";
  protected vaultNames    = BIO_VAULTS;
  protected titleText     = "";
  protected savedFilename = "BIO_PerfStats.xlsx";
  protected exportFormat: "Template" | "Formatted" = "Formatted";
  protected injectDateRange = true;
  protected credEnv = "BIO_RD";
}

/** Document creation — 생성 문서 구분 (Document Name "Type:" × (count)) */
export class BioRdDocTypeCrawler extends VeevaTableScrapeCrawler {
  protected reportUrlTemplate =
    "https://sk-rd.veevavault.com/ui/#reporting/viewer/0RP00000001O001?document_creation_date__v%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31";
  protected vaultNames    = BIO_VAULTS;
  protected titleText     = "";
  protected savedFilename = "BIO_DocType.json";
  protected injectDateRange = true;
  protected credEnv = "BIO_RD";
}
