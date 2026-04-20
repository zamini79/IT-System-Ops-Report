import { BaseCrawler }          from "../../BaseCrawler";
import type { CrawlerContext }  from "../../types";
import { SELECTORS, loadCreds } from "../../config/selectors";

/**
 * BIO 사업부 — eDMS (전자문서관리시스템) 크롤러
 * 환경변수: BIO_EDMS_URL / BIO_EDMS_USER / BIO_EDMS_PASS
 */
export class BioEdmsCrawler extends BaseCrawler {
  constructor(ctx: CrawlerContext) { super(ctx); }

  protected async downloadReport(): Promise<string[]> {
    const sel   = SELECTORS["BIO/EDMS"];
    const creds = loadCreds("BIO_EDMS");
    let files: string[] = [];

    // retry() 가 login · navigate · download 전체를 최대 3회 재시도합니다.
    await this.retry(async () => {
      await this.login({
        url:              creds.url,
        username:         creds.user,
        password:         creds.pass,
        usernameSelector: sel.login.usernameInput,
        passwordSelector: sel.login.passwordInput,
        submitSelector:   sel.login.submitButton,
        successSelector:  sel.login.successIndicator,
      });
      this.emit("login", "로그인 완료", 25);

      await this.navigateToReport(creds.url, sel.report);
      await this.setDateFilter(sel.report);
      this.emit("navigating", "보고서 필터 설정 완료", 75);

      const file = await this.waitForDownload(
        () => this.page.click(sel.report.downloadButton),
        `bio_edms_${this.jobId}.${sel.report.fileExt}`
      );
      files = [file];
    });

    return files;
  }
}
