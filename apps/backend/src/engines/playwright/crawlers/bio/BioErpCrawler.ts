import { BaseCrawler } from "../../BaseCrawler";
import type { CrawlerContext } from "../../types";

/**
 * BIO 사업부 — ERP (전사자원관리시스템) 크롤러
 *
 * 수집 대상:
 *   - 월간 생산 실적 보고서
 *   - 자재 재고 현황
 *   - 구매 발주 현황
 *
 * 환경변수: BIO_ERP_URL / BIO_ERP_USER / BIO_ERP_PASS
 */
export class BioErpCrawler extends BaseCrawler {
  constructor(ctx: CrawlerContext) { super(ctx); }

  protected async downloadReport(): Promise<string[]> {
    const files: string[] = [];
    const url  = process.env.BIO_ERP_URL  ?? "";
    const user = process.env.BIO_ERP_USER ?? "";
    const pass = process.env.BIO_ERP_PASS ?? "";

    await this.retry(async () => {
      await this.login({ url, username: user, password: pass });
      this.emit("login", "로그인 완료", 25);

      // ── 월간 생산 실적 다운로드 ─────────────────────────────────────────────
      this.emit("navigating", "생산 실적 보고서 이동", 40);
      // TODO: await this.page.goto(`${url}/production/monthly-report`);
      // const f1 = await this.waitForDownload(
      //   () => this.page.click('#download-production'),
      //   `erp_production_${this.jobId}.xlsx`
      // );
      // files.push(f1);

      // ── 자재 재고 현황 다운로드 ─────────────────────────────────────────────
      this.emit("navigating", "자재 재고 현황 이동", 60);
      // TODO: await this.page.goto(`${url}/inventory/status`);
      // const f2 = await this.waitForDownload(
      //   () => this.page.click('#download-inventory'),
      //   `erp_inventory_${this.jobId}.xlsx`
      // );
      // files.push(f2);

      // ── 구매 발주 현황 다운로드 ─────────────────────────────────────────────
      this.emit("navigating", "구매 발주 현황 이동", 75);
      // TODO: await this.page.goto(`${url}/purchase/orders`);
      // const f3 = await this.waitForDownload(
      //   () => this.page.click('#download-orders'),
      //   `erp_orders_${this.jobId}.xlsx`
      // );
      // files.push(f3);
    });

    return files;
  }
}
