import { BaseCrawler }          from "../../BaseCrawler";
import type { CrawlerContext }  from "../../types";
import { SELECTORS, loadCreds } from "../../config/selectors";

/**
 * DEV 개발본부 — MedComms (의학정보 커뮤니케이션) 크롤러
 * 다운로드 형식: CSV
 * 환경변수: DEV_MEDCOMMS_URL / DEV_MEDCOMMS_USER / DEV_MEDCOMMS_PASS
 */
export class DevMedcommsCrawler extends BaseCrawler {
  constructor(ctx: CrawlerContext) { super(ctx); }

  protected async downloadReport(): Promise<string[]> {
    const sel   = SELECTORS["DEV/MEDCOMMS"];
    const creds = loadCreds("DEV_MEDCOMMS");
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

      // MedComms는 CSV 형식
      const file = await this.waitForDownload(
        () => this.page.click(sel.report.downloadButton),
        `dev_medcomms_${this.jobId}.${sel.report.fileExt}`
      );
      files = [file];
    });

    return files;
  }
}
