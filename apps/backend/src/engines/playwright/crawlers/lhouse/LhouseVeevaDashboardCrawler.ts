/**
 * L HOUSE — Veeva Vault 대시보드 스크린샷 크롤러 (임시)
 *
 * 로그인 흐름은 LhouseVeevaCrawler 와 동일하며,
 * 로그인 완료 후 아래 URL로 이동하여 6개 차트를 캡처합니다.
 *   https://sk-qms.veevavault.com/ui/#dashboards/viewer/0DB000000001050
 */

import path                   from "path";
import fs                     from "fs";
import sharp                  from "sharp";
import { BaseCrawler }         from "../../BaseCrawler";
import type { CrawlerContext } from "../../types";

export class LhouseVeevaDashboardCrawler extends BaseCrawler {
  private static readonly LOGIN_URL     = "https://login.veevavault.com";
  private static readonly DASHBOARD_URL =
    "https://sk-qms.veevavault.com/ui/#dashboards/viewer/0DB000000001050";

  private readonly veevaUser = process.env.LHOUSE_VEEVA_USER ?? "apiadmin@sk.com";
  private readonly veevaPass = process.env.LHOUSE_VEEVA_PASS ?? "12345QWert";

  constructor(ctx: CrawlerContext) {
    super(ctx);
  }

  // ── 헬퍼: CSS 후보 폴링 (LhouseVeevaCrawler 동일) ──────────────────────────

  private async waitForVisible(
    candidates: string[],
    timeoutMs  = 15_000,
    optional   = false,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const sel of candidates) {
        try {
          const el = await this.page.$(sel);
          if (el && await el.isVisible()) return sel;
        } catch { /* ignore */ }
      }
      await this.page.waitForTimeout(400);
    }
    if (optional) return null;
    throw new Error(`요소를 찾을 수 없습니다: ${candidates.join(", ")}`);
  }

  // ── 헬퍼: 로그인 제출 버튼 클릭 (LhouseVeevaCrawler 동일) ──────────────────

  private async clickSubmit(): Promise<boolean> {
    for (const text of ["Next", "Continue", "Sign In", "Log In"]) {
      const btn = this.page.getByRole("button", { name: text, exact: false });
      if (await btn.count() > 0 && await btn.first().isVisible().catch(() => false)) {
        await btn.first().click();
        return true;
      }
      const txt = this.page.getByText(text, { exact: true });
      if (await txt.count() > 0 && await txt.first().isVisible().catch(() => false)) {
        await txt.first().click();
        return true;
      }
    }
    for (const sel of ["button[type='submit']", "input[type='submit']"]) {
      const el = await this.page.$(sel);
      if (el && await el.isVisible().catch(() => false)) { await el.click(); return true; }
    }
    return false;
  }

  // ── 메인 ─────────────────────────────────────────────────────────────────────

  protected async downloadReport(): Promise<string[]> {

    // ── Step 1. 로그인 (LhouseVeevaCrawler Steps 1-2 동일) ─────────────────────
    this.emit("login", "Veeva Vault 로그인 페이지 접속 중…", 3);
    await this.page.goto(LhouseVeevaDashboardCrawler.LOGIN_URL, {
      waitUntil: "networkidle",
      timeout:   45_000,
    });

    this.emit("login", "로그인 폼 확인 중…", 5);

    const pwAlready = await this.waitForVisible(
      ["#password", "input[name='password']", "input[type='password']",
       "input[autocomplete='current-password']"],
      2_000, true,
    );

    if (!pwAlready) {
      const emailSel = await this.waitForVisible(
        ["#username", "input[name='username']", "input[type='email']",
         "input[autocomplete='username']", "input[autocomplete='email']"],
        15_000, true,
      );
      if (emailSel) {
        this.emit("login", "이메일 입력 중…", 8);
        await this.page.fill(emailSel, this.veevaUser);
      }

      this.emit("login", "다음 단계로 이동…", 10);
      if (!await this.clickSubmit()) {
        if (emailSel) await this.page.focus(emailSel);
        await this.page.keyboard.press("Enter");
      }

      await Promise.race([
        this.page.waitForNavigation({ waitUntil: "networkidle", timeout: 30_000 }),
        this.page.waitForTimeout(5_000),
      ]).catch(() => {});
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    this.emit("login", "비밀번호 입력 중…", 12);
    const pwSel = await this.waitForVisible(
      ["#password", "input[name='password']", "input[type='password']",
       "input[autocomplete='current-password']"],
      30_000, false,
    );
    await this.page.fill(pwSel!, this.veevaPass);

    this.emit("login", "로그인 버튼 클릭…", 15);
    await Promise.all([
      this.page.waitForNavigation({ waitUntil: "networkidle", timeout: 45_000 })
        .catch(() => this.page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => {})),
      this.clickSubmit().then((clicked) => {
        if (!clicked) return this.page.keyboard.press("Enter");
      }),
    ]);

    const errEl = await this.page.$(".login-error, [class*='error-msg']");
    if (errEl) {
      const msg = await errEl.innerText().catch(() => "");
      if (msg.trim()) throw new Error(`로그인 오류: ${msg.trim()}`);
    }
    this.emit("login", "로그인 완료", 20);

    // ── Step 2. Vault 선택 ──────────────────────────────────────────────────────
    this.emit("navigating", "Vault 드롭다운 탐색 중…", 22);
    await this.page.waitForTimeout(2_000);

    const vaultSel = await this.waitForVisible(
      [
        "[data-testid='vault-selector']",
        ".vault-selector",
        "[aria-label*='vault' i]",
        "[aria-label*='Select a vault' i]",
        "#vaultSelector",
        ".vv-vault-selector",
      ],
      10_000, true,
    );

    if (vaultSel) {
      await this.page.click(vaultSel);
    } else {
      const btn = this.page.getByText("Select a vault", { exact: false });
      if (await btn.count() > 0 && await btn.first().isVisible().catch(() => false)) {
        await btn.first().click();
      } else {
        this.emit("navigating", "Vault 드롭다운 미발견 — 현재 Vault로 계속합니다.", 23);
      }
    }

    await this.page.waitForTimeout(1_000);

    const skyOption = this.page.getByText("SKY QMS Production", { exact: false });
    if (await skyOption.count() > 0 && await skyOption.first().isVisible().catch(() => false)) {
      await skyOption.first().click();
      this.emit("navigating", "SKY QMS Production 선택 완료", 25);
      await this.page.waitForLoadState("networkidle").catch(() => {});
    } else {
      this.emit("navigating", "SKY QMS Production 옵션 미발견 — 계속 진행합니다.", 25);
    }

    // ── Step 3. 대시보드 URL 접속 ──────────────────────────────────────────────
    this.emit("navigating", "대시보드 페이지 접속 중…", 30);
    await this.page.setViewportSize({ width: 1600, height: 1000 });

    await this.page.goto(LhouseVeevaDashboardCrawler.DASHBOARD_URL, {
      waitUntil: "domcontentloaded",
      timeout:   60_000,
    });

    // ── Step 4. 차트 6개 로딩 대기 ─────────────────────────────────────────────
    this.emit("navigating", "대시보드 차트 로딩 대기 중…", 40);

    // networkidle 대기 (SPA 초기 렌더링)
    await this.page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
    await this.page.waitForTimeout(3_000);

    // SVG/Canvas 요소 6개 이상 출현할 때까지 폴링 (최대 2분)
    const CHART_TIMEOUT_MS = 120_000;
    const chartDeadline    = Date.now() + CHART_TIMEOUT_MS;
    let   svgCount         = 0;

    while (Date.now() < chartDeadline) {
      svgCount = await this.page.evaluate(() => {
        const svgs    = document.querySelectorAll("svg").length;
        const canvas  = document.querySelectorAll("canvas").length;
        return svgs + canvas;
      });

      const elapsed = CHART_TIMEOUT_MS - (chartDeadline - Date.now());
      const pct     = Math.min(75, 40 + Math.floor((elapsed / CHART_TIMEOUT_MS) * 35));
      this.emit("navigating", `차트 요소 감지 중… (SVG/Canvas: ${svgCount}개)`, pct);

      if (svgCount >= 6) break;
      await this.page.waitForTimeout(2_000);
    }

    this.emit("navigating", `차트 ${svgCount}개 감지 — 렌더링 안정화 대기…`, 80);

    // 차트 애니메이션 완료 대기 (추가 5초)
    await this.page.waitForTimeout(5_000);

    // ── Step 5. 전체 페이지 스크린샷 캡처 ────────────────────────────────────
    this.emit("downloading", "대시보드 스크린샷 캡처 중…", 90);

    const ts        = Date.now();
    const tempPath  = path.join(this.downloadDir, `_tmp_dashboard_${ts}.png`);
    const savedPath = path.join(this.downloadDir, `dashboard_veeva_${ts}.png`);

    await this.page.screenshot({ path: tempPath, fullPage: true, type: "png" });

    // ── Step 6. 차트 카드 컨테이너 좌표 추출 (document 기준) ──────────────
    this.emit("downloading", "차트 영역 좌표 계산 중…", 93);

    const chartBounds = await this.page.evaluate(() => {
      const scrollY = window.scrollY;
      const scrollX = window.scrollX;

      // 아이콘·장식을 제외한 차트 크기 SVG/Canvas (150×100px 이상)
      const innerEls = Array.from(
        document.querySelectorAll<Element>("svg:not(svg svg), canvas")
      ).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 150 && r.height > 100;
      });

      if (innerEls.length === 0) return null;

      // SVG/Canvas → 카드 컨테이너 탐색
      // 1순위: Veeva 전용 클래스명으로 closest() 시도
      // 2순위: 뷰포트 60% 이하인 범위 내 최대 조상 탐색
      const maxCardW = window.innerWidth * 0.6;

      function findCard(el: Element): Element {
        const veeva = el.closest(
          ".vv-dashboard-widget, .dashboard-widget, " +
          "[class*='WidgetCard'], [class*='widget-card'], [class*='chart-card'], " +
          "[class*='widgetContainer'], [class*='widget-container']"
        );
        if (veeva) return veeva;

        let node: Element = el;
        let best: Element = el;
        for (let i = 0; i < 10 && node.parentElement; i++) {
          node = node.parentElement!;
          const r = node.getBoundingClientRect();
          // 뷰포트 폭의 60% 초과하면 그리드/전체 컨테이너이므로 중단
          if (r.width > maxCardW) break;
          best = node;
        }
        return best;
      }

      const cards = Array.from(new Set(innerEls.map(findCard)));

      const rects = cards.map(el => {
        const r = el.getBoundingClientRect();
        return {
          top:    r.top    + scrollY,
          left:   r.left   + scrollX,
          bottom: r.bottom + scrollY,
          right:  r.right  + scrollX,
        };
      });

      const pad = 8; // 카드 테두리 바깥 소량 여백
      return {
        top:    Math.max(0, Math.round(Math.min(...rects.map(r => r.top))    - pad)),
        left:   Math.max(0, Math.round(Math.min(...rects.map(r => r.left))   - pad)),
        bottom: Math.round(Math.max(...rects.map(r => r.bottom)) + pad),
        right:  Math.round(Math.max(...rects.map(r => r.right))  + pad),
      };
    });

    // ── Step 7. sharp 로 차트 영역만 크롭 ─────────────────────────────────
    if (chartBounds) {
      const meta  = await sharp(tempPath).metadata();
      const imgW  = meta.width  ?? 1600;
      const imgH  = meta.height ?? 1000;

      const left   = Math.min(chartBounds.left,  imgW - 1);
      const top    = Math.min(chartBounds.top,   imgH - 1);
      const width  = Math.min(chartBounds.right  - chartBounds.left, imgW - left);
      const height = Math.min(chartBounds.bottom - chartBounds.top,  imgH - top);

      await sharp(tempPath)
        .extract({ left, top, width, height })
        .toFile(savedPath);

      this.emit("downloading", `차트 영역 크롭 완료 (${width}×${height}px)`, 98);
    } else {
      // 차트 좌표 감지 실패 → 전체 이미지 그대로 사용
      fs.renameSync(tempPath, savedPath);
      this.emit("downloading", "차트 위치 미감지 — 전체 이미지 저장", 98);
    }

    // 임시 파일 정리
    try { fs.unlinkSync(tempPath); } catch { /* 이미 삭제(rename)된 경우 무시 */ }

    return [savedPath];
  }
}
