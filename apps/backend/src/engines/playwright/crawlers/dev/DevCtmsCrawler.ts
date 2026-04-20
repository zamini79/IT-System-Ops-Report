import { BaseCrawler }          from "../../BaseCrawler";
import type { CrawlerContext }  from "../../types";
import { SELECTORS, loadCreds } from "../../config/selectors";

/**
 * DEV 개발본부 — CTMS (임상시험관리시스템) 크롤러
 * 환경변수: DEV_CTMS_URL / DEV_CTMS_USER / DEV_CTMS_PASS
 */
export class DevCtmsCrawler extends BaseCrawler {
  constructor(ctx: CrawlerContext) { super(ctx); }

  protected async downloadReport(): Promise<string[]> {
    const sel   = SELECTORS["DEV/CTMS"];
    const creds = loadCreds("DEV_CTMS");
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
        `dev_ctms_${this.jobId}.${sel.report.fileExt}`
      );

      if (sel.report.confirmButton) {
        await this.page.click(sel.report.confirmButton).catch(() => {});
      }

      files = [file];
    });

    return files;
  }
}
