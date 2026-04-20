import { BaseCrawler }          from "../../BaseCrawler";
import type { CrawlerContext }  from "../../types";
import { SELECTORS, loadCreds } from "../../config/selectors";

/**
 * BIO 사업부 — GCLP LIMS (실험실정보관리시스템) 크롤러
 * 날짜 포맷: YYYYMMDD
 * 환경변수: BIO_GCLP_LIMS_URL / BIO_GCLP_LIMS_USER / BIO_GCLP_LIMS_PASS
 */
export class BioGclpLimsCrawler extends BaseCrawler {
  constructor(ctx: CrawlerContext) { super(ctx); }

  protected async downloadReport(): Promise<string[]> {
    const sel   = SELECTORS["BIO/GCLP_LIMS"];
    const creds = loadCreds("BIO_GCLP_LIMS");
    let files: string[] = [];

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
        `bio_gclp_lims_${this.jobId}.${sel.report.fileExt}`
      );
      files = [file];
    });

    return files;
  }
}
