import { BaseCrawler }          from "../../BaseCrawler";
import type { CrawlerContext }  from "../../types";
import { SELECTORS, loadCreds } from "../../config/selectors";

/**
 * DEV 개발본부 — eTMF (전자 Trial Master File) 크롤러
 * 날짜 포맷: MM/DD/YYYY (영문 시스템)
 * 환경변수: DEV_ETMF_URL / DEV_ETMF_USER / DEV_ETMF_PASS
 */
export class DevEtmfCrawler extends BaseCrawler {
  constructor(ctx: CrawlerContext) { super(ctx); }

  protected async downloadReport(): Promise<string[]> {
    const sel   = SELECTORS["DEV/ETMF"];
    const creds = loadCreds("DEV_ETMF");
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

      // eTMF는 MM/DD/YYYY 포맷 — sel.report.dateFormat 에 정의됨
      await this.navigateToReport(creds.url, sel.report);
      await this.setDateFilter(sel.report);
      this.emit("navigating", "보고서 필터 설정 완료", 75);

      const file = await this.waitForDownload(
        () => this.page.click(sel.report.downloadButton),
        `dev_etmf_${this.jobId}.${sel.report.fileExt}`
      );
      files = [file];
    });

    return files;
  }
}
