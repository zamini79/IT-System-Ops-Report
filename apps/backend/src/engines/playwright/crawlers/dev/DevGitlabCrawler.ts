import { BaseCrawler } from "../../BaseCrawler";
import type { CrawlerContext } from "../../types";

/**
 * DEV 개발본부 — GitLab 크롤러
 *
 * 수집 대상:
 *   - 주간 커밋 통계 (프로젝트별)
 *   - 미해결 이슈 현황
 *   - MR(Merge Request) 리뷰 대기 목록
 *
 * 특이사항: Personal Access Token 인증 (PRIVATE-TOKEN 헤더)
 * 환경변수: DEV_GITLAB_URL / DEV_GITLAB_TOKEN
 */
export class DevGitlabCrawler extends BaseCrawler {
  constructor(ctx: CrawlerContext) { super(ctx); }

  protected async downloadReport(): Promise<string[]> {
    const files: string[] = [];
    const url   = process.env.DEV_GITLAB_URL   ?? "";
    const token = process.env.DEV_GITLAB_TOKEN ?? "";

    await this.retry(async () => {
      // GitLab은 PAT 헤더 방식 인증
      this.emit("login", "GitLab Personal Access Token 설정", 10);
      await this.context.setExtraHTTPHeaders({ "PRIVATE-TOKEN": token });
      this.emit("login", "GitLab 인증 완료", 25);

      // ── 주간 커밋 통계 페이지 스크린샷 ───────────────────────────────────────
      this.emit("navigating", "GitLab 대시보드 이동", 50);
      // TODO: await this.page.goto(`${url}/dashboard/groups`);
      // const shot = path.join(this.downloadDir, `gitlab_commits_${this.jobId}.png`);
      // await this.page.screenshot({ path: shot, fullPage: true });
      // files.push(shot);

      // ── 미해결 이슈 현황 (API → JSON 저장) ──────────────────────────────────
      this.emit("navigating", "미해결 이슈 수집", 75);
      // TODO: const resp = await this.page.request.get(`${url}/api/v4/issues?state=opened`);
      // const issues = await resp.json();
      // const jsonPath = path.join(this.downloadDir, `gitlab_issues_${this.jobId}.json`);
      // fs.writeFileSync(jsonPath, JSON.stringify(issues, null, 2));
      // files.push(jsonPath);
    });

    return files;
  }
}
