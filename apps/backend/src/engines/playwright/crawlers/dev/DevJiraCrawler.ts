import { BaseCrawler } from "../../BaseCrawler";
import type { CrawlerContext } from "../../types";

/**
 * DEV 개발본부 — Jira 크롤러
 *
 * 수집 대상:
 *   - 스프린트 번다운 차트 스크린샷
 *   - 미완료 스토리 목록 CSV
 *   - 릴리즈 진행 현황
 *
 * 특이사항: Jira Cloud — Basic Auth (email:API token), Server/DC — ID/PW
 * 환경변수: DEV_JIRA_URL / DEV_JIRA_USER / DEV_JIRA_PASS
 */
export class DevJiraCrawler extends BaseCrawler {
  constructor(ctx: CrawlerContext) { super(ctx); }

  protected async downloadReport(): Promise<string[]> {
    const files: string[] = [];
    const url  = process.env.DEV_JIRA_URL  ?? "";
    const user = process.env.DEV_JIRA_USER ?? "";
    const pass = process.env.DEV_JIRA_PASS ?? "";

    await this.retry(async () => {
      await this.login({ url, username: user, password: pass });
      this.emit("login", "로그인 완료", 25);

      // ── 스프린트 번다운 차트 스크린샷 ────────────────────────────────────────
      this.emit("navigating", "스프린트 번다운 차트 캡처", 50);
      // TODO: await this.page.goto(`${url}/jira/software/projects/DEV/boards/{boardId}/sprint`);
      // await this.page.click('button:has-text("Burndown Chart")');
      // await this.page.waitForSelector('[data-testid="burndown-chart"]');
      // const shot = path.join(this.downloadDir, `jira_burndown_${this.jobId}.png`);
      // await this.page.screenshot({ path: shot });
      // files.push(shot);

      // ── 미완료 스토리 CSV 내보내기 ───────────────────────────────────────────
      this.emit("navigating", "미완료 스토리 CSV 내보내기", 75);
      // TODO: Jira 이슈 검색 → 내보내기 버튼
      // const csv = await this.waitForDownload(
      //   () => this.page.click('[data-testid="export-button"]'),
      //   `jira_stories_${this.jobId}.csv`
      // );
      // files.push(csv);
    });

    return files;
  }
}
