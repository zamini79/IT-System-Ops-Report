import fs   from "fs";
import path from "path";
import { VeevaReportExportCrawler } from "../veeva/VeevaReportExportCrawler";

/**
 * 안동공장(L HOUSE) Veeva Quality System 보고서용 수집 크롤러.
 * GCP Quality System 과 동일한 리포트 구조를 sk-qms.veevavault.com 인스턴스에서 수집한다.
 *
 *  - 공용 베이스(VeevaReportExportCrawler): 로그인 → Vault 선택 → 리포트 URL 접속.
 *  - URL 의 BETWEEN 날짜는 실행 시 직전 3개월(−3월 1일 ~ −1월 말일)로 자동 치환.
 *  - PerfStats / Quality 는 "Export to Excel → Formatted → Export" 로 xlsx 다운로드.
 *  - Training 은 (요청에 따라) Excel export 없이 화면의 표를 직접 스크래핑하여 JSON 저장.
 */

const LHOUSE_VAULTS = ["SKY QMS Production", "QMS Production", "QMS", "sk-qms"];

/** Performance Statistics — Doc Count(E) / Active User(B) / Unique Login(D) → 문서·사용자·일일 사용 */
export class LhouseVeevaPerfStatsCrawler extends VeevaReportExportCrawler {
  protected reportUrlTemplate =
    "https://sk-qms.veevavault.com/ui/#reporting/viewer/0RP00000002O001?PerformanceStatistics.OSF000000000K40%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31";
  protected vaultNames    = LHOUSE_VAULTS;
  protected titleText     = "";
  protected savedFilename = "LHOUSE_PerfStats.xlsx";
  protected exportFormat: "Template" | "Formatted" = "Formatted";
  protected injectDateRange = true;
  protected credEnv = "LHOUSE";
}

/** Quality Events — Quality Event Type (품질 관리 현황) */
export class LhouseVeevaQualityCrawler extends VeevaReportExportCrawler {
  protected reportUrlTemplate =
    "https://sk-qms.veevavault.com/ui/#reporting/viewer/0RP00000006X001?OSY000000000R13.OSF000000000X71%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31&OSY000000000R13.OSF000000000X71%2C%2C%2CBETWEEN%2C%2C%2C1=2026-03-01%3B%3B2026-05-31";
  protected vaultNames    = LHOUSE_VAULTS;
  protected titleText     = "";
  protected savedFilename = "LHOUSE_Quality.xlsx";
  protected exportFormat: "Template" | "Formatted" = "Formatted";
  protected injectDateRange = true;
  protected credEnv = "LHOUSE";
}

/**
 * Training — 교육 관리 현황.
 * 요청 사양: Export to Excel 없이, 리포트 화면의 표에서 직접 수집한다.
 *   - Name 컬럼 = Created Date 월
 *   - Activity count 값 = 막대 값
 * 수집 결과는 uploads/LHOUSE_Training.json 으로 저장한다.
 */
export class LhouseVeevaTrainingCrawler extends VeevaReportExportCrawler {
  protected reportUrlTemplate =
    "https://sk-qms.veevavault.com/ui/#reporting/viewer/0RP00000007Y004?Activity.OSF000000001362%2C%2C%2CBETWEEN=2026-03-01%3B%3B2026-05-31&Activity.OSF000000001362%2C%2C%2CBETWEEN%2C%2C%2C1=2026-03-01%3B%3B2026-05-31";
  protected vaultNames    = LHOUSE_VAULTS;
  protected titleText     = "";
  protected savedFilename = "LHOUSE_Training.json";
  protected injectDateRange = true;
  protected credEnv = "LHOUSE";

  /** Excel export 대신 화면 표를 스크래핑한다. */
  protected async downloadReport(): Promise<string[]> {
    await this.loginVaultAndOpenReport();

    this.emit("navigating", "교육 리포트 표 스크래핑 중…", 70);
    // 표가 완전히 렌더링되도록 약간 더 대기
    await this.page.waitForTimeout(2_000);

    const scraped = await this.page.evaluate(() => {
      const txt = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      const toCount = (s: string): number | null => {
        const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
        return m ? Math.round(Number(m[0])) : null;
      };

      type Row = { name: string; count: number };
      type Grid = { headers: string[]; rows: string[][] };

      // 1) 후보 그리드 수집 — <table> 및 role 기반 그리드(Veeva 뷰어는 div 그리드 사용 가능)
      const grids: Grid[] = [];

      // (a) 표준 <table>
      document.querySelectorAll("table").forEach((tbl) => {
        const trs = Array.from(tbl.querySelectorAll("tr"));
        if (trs.length < 2) return;
        const cells = (tr: Element) =>
          Array.from(tr.querySelectorAll("th,td")).map((c) => txt(c));
        const headers = cells(trs[0]);
        const rows = trs.slice(1).map(cells).filter((r) => r.some((c) => c !== ""));
        if (rows.length) grids.push({ headers, rows });
      });

      // (b) role=grid / role=row 기반
      document.querySelectorAll("[role='grid'],[role='table']").forEach((g) => {
        const rowEls = Array.from(g.querySelectorAll("[role='row']"));
        if (rowEls.length < 2) return;
        const cellsOf = (r: Element) =>
          Array.from(r.querySelectorAll("[role='gridcell'],[role='cell'],[role='columnheader']"))
            .map((c) => txt(c));
        const headers = cellsOf(rowEls[0]);
        const rows = rowEls.slice(1).map(cellsOf).filter((r) => r.some((c) => c !== ""));
        if (rows.length) grids.push({ headers, rows });
      });

      if (!grids.length) {
        return { rows: [] as Row[], debug: "표(table/grid) 미발견", headers: [] as string[] };
      }

      // 2) 데이터 행이 가장 많은 그리드 선택
      grids.sort((a, b) => b.rows.length - a.rows.length);
      const grid = grids[0];

      // 3) 컬럼 인덱스 결정 — Name / Count
      const findCol = (re: RegExp) => grid.headers.findIndex((h) => re.test(h));
      let nameIdx  = findCol(/name|created\s*date|month|날짜|월/i);
      let countIdx = findCol(/count|activity|건수|수량|total/i);
      if (nameIdx < 0)  nameIdx = 0;
      if (countIdx < 0) {
        // 헤더로 못 찾으면, 첫 데이터 행에서 숫자형인 마지막 컬럼을 count 로 추정
        const sample = grid.rows[0] ?? [];
        for (let i = sample.length - 1; i >= 0; i--) {
          if (i !== nameIdx && toCount(sample[i]) !== null) { countIdx = i; break; }
        }
      }
      if (countIdx < 0) countIdx = grid.headers.length - 1;

      const rows: Row[] = [];
      for (const r of grid.rows) {
        const name = r[nameIdx] ?? "";
        const cnt  = toCount(r[countIdx] ?? "");
        if (!name || cnt === null) continue;
        rows.push({ name, count: cnt });
      }
      return { rows, debug: `grid rows=${grid.rows.length} nameIdx=${nameIdx} countIdx=${countIdx}`, headers: grid.headers };
    }).catch((e) => ({ rows: [] as { name: string; count: number }[], debug: `evaluate 실패: ${(e as Error).message}`, headers: [] as string[] }));

    this.emit("navigating", `표 스크래핑 완료 — ${scraped.rows.length}행 (${scraped.debug})`, 88);

    if (!scraped.rows.length) {
      const debugPath = `${this.downloadDir}/debug_training_${Date.now()}.png`;
      await this.page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
      throw new Error(
        `교육 리포트 표에서 데이터를 찾지 못했습니다 (${scraped.debug}). ` +
        `헤더: [${scraped.headers.join(", ")}] 스크린샷: ${debugPath}`
      );
    }

    const uploadsDir = path.join(this.downloadDir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const savedPath = path.join(uploadsDir, this.savedFilename);
    fs.writeFileSync(savedPath, JSON.stringify({ rows: scraped.rows, headers: scraped.headers }, null, 2), "utf-8");

    this.emit("downloading", `교육 데이터 저장 완료 → uploads/${this.savedFilename}`, 95);
    return [savedPath];
  }
}
