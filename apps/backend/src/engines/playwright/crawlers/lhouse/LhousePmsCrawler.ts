import { BaseCrawler } from "../../BaseCrawler";
import type { CrawlerContext } from "../../types";

/**
 * LHOUSE — PMS (프로젝트관리시스템) 크롤러
 *
 * 수집 대상:
 *   - 진행 중 프로젝트 현황 목록 (Excel)
 *   - 일정 준수율 리포트 (Excel)
 *   - 리소스 투입 현황 스크린샷
 *
 * 환경변수: LHOUSE_PMS_URL / LHOUSE_PMS_USER / LHOUSE_PMS_PASS
 */
export class LhousePmsCrawler extends BaseCrawler {
  constructor(ctx: CrawlerContext) { super(ctx); }

  protected async downloadReport(): Promise<string[]> {
    const files: string[] = [];
    const url  = process.env.LHOUSE_PMS_URL  ?? "";
    const user = process.env.LHOUSE_PMS_USER ?? "";
    const pass = process.env.LHOUSE_PMS_PASS ?? "";

    await this.retry(async () => {
      await this.login({ url, username: user, password: pass });
      this.emit("login", "로그인 완료", 25);

      // ── 프로젝트 현황 목록 Excel 다운로드 ────────────────────────────────────
      this.emit("navigating", "프로젝트 현황 목록 이동", 40);
      // TODO: await this.page.goto(`${url}/projects/status`);
      // const f1 = await this.waitForDownload(
      //   () => this.page.click('#btn-excel-download'),
      //   `pms_projects_${this.jobId}.xlsx`
      // );
      // files.push(f1);

      // ── 일정 준수율 리포트 ───────────────────────────────────────────────────
      this.emit("navigating", "일정 준수율 리포트 이동", 60);
      // TODO: await this.page.goto(`${url}/reports/schedule-compliance`);
      // await this.page.selectOption('#period-select', 'monthly');
      // const f2 = await this.waitForDownload(
      //   () => this.page.click('#download-report'),
      //   `pms_schedule_${this.jobId}.xlsx`
      // );
      // files.push(f2);

      // ── 리소스 투입 현황 스크린샷 ────────────────────────────────────────────
      this.emit("navigating", "리소스 투입 현황 캡처", 75);
      // TODO: await this.page.goto(`${url}/resources/allocation`);
      // const shot = path.join(this.downloadDir, `pms_resources_${this.jobId}.png`);
      // await this.page.screenshot({ path: shot, fullPage: true });
      // files.push(shot);
    });

    return files;
  }
}
