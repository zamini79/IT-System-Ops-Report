import { BaseCrawler } from "../../BaseCrawler";
import type { CrawlerContext } from "../../types";

/**
 * BIO 사업부 — MES (제조실행시스템) 크롤러
 *
 * 수집 대상:
 *   - 공정별 생산 현황 스크린샷
 *   - 불량률 통계 CSV
 *   - 설비 가동률 리포트
 *
 * 특이사항: 세션 기반 로그인
 * 환경변수: BIO_MES_URL / BIO_MES_USER / BIO_MES_PASS
 */
export class BioMesCrawler extends BaseCrawler {
  constructor(ctx: CrawlerContext) { super(ctx); }

  protected async downloadReport(): Promise<string[]> {
    const files: string[] = [];
    const url  = process.env.BIO_MES_URL  ?? "";
    const user = process.env.BIO_MES_USER ?? "";
    const pass = process.env.BIO_MES_PASS ?? "";

    await this.retry(async () => {
      await this.login({ url, username: user, password: pass });
      this.emit("login", "로그인 완료", 25);

      // ── 공정 현황 스크린샷 ───────────────────────────────────────────────────
      this.emit("navigating", "공정 현황 대시보드 이동", 50);
      // TODO: await this.page.goto(`${url}/process/dashboard`);
      // const shot = path.join(this.downloadDir, `mes_process_${this.jobId}.png`);
      // await this.page.screenshot({ path: shot, fullPage: true });
      // files.push(shot);

      // ── 불량률 CSV 다운로드 ─────────────────────────────────────────────────
      this.emit("navigating", "불량률 통계 다운로드", 75);
      // TODO: await this.page.goto(`${url}/quality/defect-rate`);
      // const csv = await this.waitForDownload(
      //   () => this.page.click('#export-csv'),
      //   `mes_defect_${this.jobId}.csv`
      // );
      // files.push(csv);
    });

    return files;
  }
}
