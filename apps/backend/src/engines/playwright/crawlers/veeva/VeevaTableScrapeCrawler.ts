import fs   from "fs";
import path from "path";
import { VeevaReportExportCrawler } from "./VeevaReportExportCrawler";

/**
 * Veeva Vault 리포트 화면의 표를 직접 스크래핑하는 공용 베이스 크롤러.
 *
 *  - 로그인 → Vault 선택 → 리포트 URL 접속(공용 loginVaultAndOpenReport 재사용)
 *  - 화면에 렌더링된 표(<table> 또는 role=grid)를 찾아 헤더 + 전체 행을 그대로 덤프
 *  - uploads/<savedFilename>(.json) 으로 { headers, rows } 저장
 *
 * 표의 의미 해석(컬럼 매핑/그룹 행 파싱)은 각 보고서 서비스에서 수행한다.
 * (서브클래스는 reportUrlTemplate / vaultNames / savedFilename / credEnv 만 설정)
 */
export abstract class VeevaTableScrapeCrawler extends VeevaReportExportCrawler {
  protected async downloadReport(): Promise<string[]> {
    await this.loginVaultAndOpenReport();

    this.emit("navigating", "리포트 표 스크래핑 중…", 70);
    await this.page.waitForTimeout(2_000);   // 표 렌더 안정화

    const scraped = await this.page.evaluate(() => {
      const txt = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      type Grid = { headers: string[]; rows: string[][] };
      const grids: Grid[] = [];

      // (a) 표준 <table>
      document.querySelectorAll("table").forEach((tbl) => {
        const trs = Array.from(tbl.querySelectorAll("tr"));
        if (trs.length < 2) return;
        const cells = (tr: Element) => Array.from(tr.querySelectorAll("th,td")).map((c) => txt(c));
        const headers = cells(trs[0]);
        const rows = trs.slice(1).map(cells).filter((r) => r.some((c) => c !== ""));
        if (rows.length) grids.push({ headers, rows });
      });

      // (b) role=grid / role=table
      document.querySelectorAll("[role='grid'],[role='table']").forEach((g) => {
        const rowEls = Array.from(g.querySelectorAll("[role='row']"));
        if (rowEls.length < 2) return;
        const cellsOf = (r: Element) =>
          Array.from(r.querySelectorAll("[role='gridcell'],[role='cell'],[role='columnheader']")).map((c) => txt(c));
        const headers = cellsOf(rowEls[0]);
        const rows = rowEls.slice(1).map(cellsOf).filter((r) => r.some((c) => c !== ""));
        if (rows.length) grids.push({ headers, rows });
      });

      if (!grids.length) return { headers: [] as string[], rows: [] as string[][], debug: "표(table/grid) 미발견" };

      grids.sort((a, b) => b.rows.length - a.rows.length);
      const grid = grids[0];
      return { headers: grid.headers, rows: grid.rows, debug: `grid rows=${grid.rows.length} cols=${grid.headers.length}` };
    }).catch((e) => ({ headers: [] as string[], rows: [] as string[][], debug: `evaluate 실패: ${(e as Error).message}` }));

    this.emit("navigating", `표 스크래핑 완료 — ${scraped.rows.length}행 (${scraped.debug})`, 88);

    if (!scraped.rows.length) {
      const debugPath = `${this.downloadDir}/debug_scrape_${Date.now()}.png`;
      await this.page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
      throw new Error(`리포트 표에서 데이터를 찾지 못했습니다 (${scraped.debug}). 스크린샷: ${debugPath}`);
    }

    const uploadsDir = path.join(this.downloadDir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const savedPath = path.join(uploadsDir, this.savedFilename);
    fs.writeFileSync(savedPath, JSON.stringify({ headers: scraped.headers, rows: scraped.rows }, null, 2), "utf-8");

    this.emit("downloading", `데이터 저장 완료 → uploads/${this.savedFilename}`, 95);
    return [savedPath];
  }
}
