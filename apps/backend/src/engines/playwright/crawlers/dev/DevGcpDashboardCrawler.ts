/**
 * DEV — GCP Quality System Veeva Vault 대시보드 스크린샷 크롤러
 *
 * 로그인 후 아래 URL의 대시보드를 캡처합니다.
 *   https://sk-gcp.veevavault.com/ui/#dashboards/viewer/0DB000000001010
 *
 * 필터 설정 흐름:
 *   "FILTERS (N)" 텍스트 우측 연필 아이콘 클릭
 *   → 팝업에서 날짜 범위 입력 (3개월 전 1일 ~ 1개월 전 마지막 날)
 *   → Continue 클릭 → 차트 재로딩 대기 → 상위 2행 크롭
 */

import path                   from "path";
import fs                     from "fs";
import sharp                  from "sharp";
import type { Frame }          from "playwright";
import { BaseCrawler }         from "../../BaseCrawler";
import type { CrawlerContext } from "../../types";

export class DevGcpDashboardCrawler extends BaseCrawler {
  private static readonly LOGIN_URL     = "https://login.veevavault.com";
  private static readonly DASHBOARD_URL =
    "https://sk-gcp.veevavault.com/ui/#dashboards/viewer/0DB000000001010";

  private readonly veevaUser = process.env.DEV_GCP_VEEVA_USER ?? process.env.LHOUSE_VEEVA_USER ?? "apiadmin@sk.com";
  private readonly veevaPass = process.env.DEV_GCP_VEEVA_PASS ?? process.env.LHOUSE_VEEVA_PASS ?? "12345QWert";

  constructor(ctx: CrawlerContext) {
    super(ctx);
  }

  // ── 헬퍼: CSS 후보 폴링 ────────────────────────────────────────────────────

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

  // ── 헬퍼: 로그인 제출 버튼 클릭 ────────────────────────────────────────────

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

  // ── 헬퍼: 날짜 포맷 (MM/DD/YYYY) ──────────────────────────────────────────

  private fmtDate(d: Date): string {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getFullYear()}`;
  }

  /**
   * "FILTERS" 텍스트가 포함된 프레임을 반환합니다.
   * Veeva Vault 대시보드가 iframe 안에 렌더링될 수 있으므로 모든 프레임을 순회합니다.
   * 15초 내에 찾지 못하면 메인 프레임을 반환합니다.
   */
  private async _findTargetFrame(): Promise<Frame> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      for (const frame of this.page.frames()) {
        try {
          const has = await frame.evaluate(
            () => /FILTERS/i.test(document.body?.innerText ?? "")
          ).catch(() => false);
          if (has) return frame;
        } catch { /* ignore */ }
      }
      await this.page.waitForTimeout(500);
    }
    // FILTERS 미발견 — 메인 프레임으로 계속 진행
    return this.page.mainFrame();
  }

  /**
   * 대상 iframe 요소의 페이지 내 오프셋을 반환합니다.
   * 메인 프레임이면 { x: 0, y: 0 }.
   */
  private async _getFrameOffset(frame: Frame): Promise<{ x: number; y: number }> {
    if (frame === this.page.mainFrame()) return { x: 0, y: 0 };
    for (const el of await this.page.$$("iframe")) {
      try {
        const f = await el.contentFrame();
        if (f === frame) {
          const box = await el.boundingBox();
          if (box) return { x: box.x, y: box.y };
        }
      } catch { /* ignore */ }
    }
    return { x: 0, y: 0 };
  }

  // ── 헬퍼: 필터 날짜 범위 설정 ─────────────────────────────────────────────

  /**
   * "FILTERS (N)" 텍스트 우측 연필 아이콘 클릭 → 팝업에서 날짜 설정 → Continue.
   * frame: _findTargetFrame() 으로 얻은 대시보드 렌더링 프레임.
   * 모든 단계는 실패해도 진행을 막지 않습니다(warn 후 return).
   */
  private async _applyDateFilter(
    startStr: string,
    endStr:   string,
    frame:    Frame,
  ): Promise<void> {
    this.emit("navigating", `날짜 필터 설정 중… (${startStr} ~ ${endStr})`, 34);

    // ── ① FILTERS 텍스트 우측 연필 아이콘 클릭 ────────────────────────────
    // frame.evaluate() 를 사용해 iframe 내부 DOM에서 탐색합니다.
    // React/Angular SPA가 기대하는 전체 포인터 이벤트 시퀀스를 발송합니다.
    const clickedPencil = await frame.evaluate((): boolean => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let textNode: Text | null;
      let filtersEl: Element | null = null;

      while ((textNode = walker.nextNode() as Text | null)) {
        if (/FILTERS/i.test(textNode.textContent ?? "")) {
          filtersEl = textNode.parentElement;
          break;
        }
      }
      if (!filtersEl) return false;

      let ancestor: Element | null = filtersEl.parentElement;
      for (let i = 0; i < 8 && ancestor; i++) {
        const candidates = Array.from(
          ancestor.querySelectorAll<HTMLElement>('button, a, [role="button"]')
        ).filter((el) => {
          if (!el.offsetParent) return false;
          if (el.contains(filtersEl)) return false;
          return el.querySelector("svg") !== null;
        });

        if (candidates.length > 0) {
          const filtersRect = filtersEl.getBoundingClientRect();
          const rightOf = candidates.filter(
            (el) => el.getBoundingClientRect().left >= filtersRect.right - 4
          );
          const target = rightOf.length > 0
            ? rightOf.reduce((a, b) =>
                a.getBoundingClientRect().left < b.getBoundingClientRect().left ? a : b)
            : candidates[0];

          target.dispatchEvent(new PointerEvent("pointerover",  { bubbles: true }));
          target.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
          target.dispatchEvent(new PointerEvent("pointerdown",  { bubbles: true }));
          target.dispatchEvent(new PointerEvent("pointerup",    { bubbles: true }));
          target.dispatchEvent(new MouseEvent("click",          { bubbles: true }));
          return true;
        }
        ancestor = ancestor.parentElement;
      }
      return false;
    });

    if (!clickedPencil) {
      this.emit("navigating", "FILTERS 연필 아이콘 미발견 — 필터 건너뜀", 35);
      return;
    }

    this.emit("navigating", "필터 팝업 대기 중…", 35);
    await this.page.waitForTimeout(3_000);

    // ── ② 날짜 입력 — frame.evaluate() 로 직접 값 주입 ────────────────────
    // ElementHandle.click() 의 actionability 체크(not visible / covered)를 완전히
    // 우회하고, React/Angular controlled input 에 맞는 native value setter +
    // input/change 이벤트 발송 방식으로 처리합니다.
    const datesSet = await frame.evaluate(
      ([start, end]: [string, string]): boolean => {
        function isActuallyVisible(el: HTMLElement): boolean {
          const s = window.getComputedStyle(el);
          return (
            s.display     !== "none"    &&
            s.visibility  !== "hidden"  &&
            s.opacity     !== "0"       &&
            el.offsetParent !== null
          );
        }

        function setNativeValue(el: HTMLInputElement, value: string) {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
          )?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event("input",  { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }

        // 팝업/패널 컨테이너 후보 안에서 먼저 탐색
        const PANEL_SELS = [
          "dialog", "[role='dialog']",
          "[class*='modal']", "[class*='popup']", "[class*='overlay']",
          "[class*='filter']", "[class*='Filter']",
        ];

        for (const sel of PANEL_SELS) {
          const panel = document.querySelector(sel);
          if (!panel) continue;
          const inputs = Array.from(panel.querySelectorAll<HTMLInputElement>("input"))
            .filter(el => isActuallyVisible(el));
          if (inputs.length >= 2) {
            setNativeValue(inputs[0], start);
            setNativeValue(inputs[1], end);
            return true;
          }
        }

        // 팝업 미발견 시 페이지 전체 visible input (단, 2개가 정확히 있을 때만)
        const allVisible = Array.from(document.querySelectorAll<HTMLInputElement>("input"))
          .filter(el => isActuallyVisible(el));
        if (allVisible.length === 2) {
          setNativeValue(allVisible[0], start);
          setNativeValue(allVisible[1], end);
          return true;
        }

        return false;
      },
      [startStr, endStr] as [string, string],
    );

    if (datesSet) {
      this.emit("navigating", `날짜 입력 완료: ${startStr} ~ ${endStr}`, 37);
    } else {
      this.emit("navigating", "날짜 입력 필드 미발견 — 날짜 미설정", 37);
    }

    // ── ③ Continue 버튼 클릭 (frame 내) ──────────────────────────────────
    let continueDone = false;
    for (const name of ["Continue", "Apply", "OK", "확인", "Submit"]) {
      const btn = frame.getByRole("button", { name, exact: false });
      if (await btn.count() > 0 && await btn.first().isVisible().catch(() => false)) {
        await btn.first().click();
        this.emit("navigating", `"${name}" 버튼 클릭 완료`, 38);
        continueDone = true;
        break;
      }
    }
    if (!continueDone) {
      this.emit("navigating", "Continue 버튼 미발견 — Escape 시도", 38);
      await this.page.keyboard.press("Escape");
    }

    await this.page.waitForTimeout(2_000);
  }

  // ── 메인 ─────────────────────────────────────────────────────────────────────

  protected async downloadReport(): Promise<string[]> {

    // ── Step 1. 로그인 ──────────────────────────────────────────────────────────
    this.emit("login", "Veeva Vault 로그인 페이지 접속 중…", 3);
    await this.page.goto(DevGcpDashboardCrawler.LOGIN_URL, {
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

    // ── Step 2. Vault 선택 (sk-gcp.veevavault.com) ─────────────────────────────
    this.emit("navigating", "GCP Vault 탐색 중…", 22);
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

    const vaultNames = ["SKY GCP Production", "GCP Production", "GCP", "sk-gcp"];
    let vaultSelected = false;
    for (const name of vaultNames) {
      const opt = this.page.getByText(name, { exact: false });
      if (await opt.count() > 0 && await opt.first().isVisible().catch(() => false)) {
        await opt.first().click();
        this.emit("navigating", `${name} Vault 선택 완료`, 25);
        await this.page.waitForLoadState("networkidle").catch(() => {});
        vaultSelected = true;
        break;
      }
    }
    if (!vaultSelected) {
      this.emit("navigating", "GCP Vault 옵션 미발견 — 계속 진행합니다.", 25);
    }

    // ── Step 3. 대시보드 URL 접속 ──────────────────────────────────────────────
    this.emit("navigating", "GCP 대시보드 페이지 접속 중…", 28);
    await this.page.setViewportSize({ width: 1600, height: 1000 });

    await this.page.goto(DevGcpDashboardCrawler.DASHBOARD_URL, {
      waitUntil: "domcontentloaded",
      timeout:   60_000,
    });

    await this.page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await this.page.waitForTimeout(3_000);

    // ── Step 3.5. 대시보드 프레임 탐지 ────────────────────────────────────────
    // Veeva 대시보드가 iframe 안에 렌더링될 경우를 대비해 FILTERS 포함 프레임을 탐색합니다.
    this.emit("navigating", "대시보드 프레임 탐색 중…", 29);
    const targetFrame = await this._findTargetFrame();
    const isIframe    = targetFrame !== this.page.mainFrame();
    this.emit(
      "navigating",
      isIframe ? `iframe 내 대시보드 감지: ${targetFrame.url().substring(0, 80)}` : "메인 프레임에서 대시보드 렌더링",
      30,
    );

    // ── Step 3.6. 날짜 필터 설정 ─────────────────────────────────────────────
    const now = new Date();
    const filterStart = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const filterEnd   = new Date(now.getFullYear(), now.getMonth(),     0);

    await this._applyDateFilter(
      this.fmtDate(filterStart),
      this.fmtDate(filterEnd),
      targetFrame,
    );

    await this.page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
    await this.page.waitForTimeout(3_000);

    // ── Step 4. 차트 로딩 대기 ─────────────────────────────────────────────────
    this.emit("navigating", "대시보드 차트 로딩 대기 중…", 42);

    const CHART_TIMEOUT_MS = 120_000;
    const chartDeadline    = Date.now() + CHART_TIMEOUT_MS;
    let   svgCount         = 0;
    let   prevSvgCount     = -1;
    let   stableIterations = 0;

    while (Date.now() < chartDeadline) {
      svgCount = await targetFrame.evaluate(() => {
        const large = (sel: string) =>
          Array.from(document.querySelectorAll<Element>(sel)).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 150 && r.height > 100;
          }).length;
        return large("svg:not(svg svg)") + large("canvas");
      });

      const elapsed = CHART_TIMEOUT_MS - (chartDeadline - Date.now());
      const pct     = Math.min(78, 42 + Math.floor((elapsed / CHART_TIMEOUT_MS) * 36));
      this.emit("navigating", `차트 요소 감지 중… (대형 SVG/Canvas: ${svgCount}개)`, pct);

      if (svgCount > 0 && svgCount === prevSvgCount) {
        stableIterations++;
        if (stableIterations >= 3) break;
      } else {
        stableIterations = 0;
      }
      prevSvgCount = svgCount;
      await this.page.waitForTimeout(2_000);
    }

    this.emit("navigating", `차트 ${svgCount}개 감지 — 렌더링 안정화 대기…`, 80);
    await this.page.waitForTimeout(5_000);

    // ── Step 5. 전체 페이지 스크린샷 캡처 ────────────────────────────────────
    this.emit("downloading", "대시보드 스크린샷 캡처 중…", 90);

    const ts        = Date.now();
    const tempPath  = path.join(this.downloadDir, `_tmp_gcp_dashboard_${ts}.png`);
    const savedPath = path.join(this.downloadDir, `gcp_dashboard_${ts}.png`);

    await this.page.screenshot({ path: tempPath, fullPage: true, type: "png" });

    // ── Step 6. 차트 카드 좌표 추출 (상위 2행만, iframe 오프셋 적용) ──────────
    this.emit("downloading", "차트 영역 좌표 계산 중…", 93);

    // iframe 렌더링이면 해당 iframe 요소의 페이지 내 절대 위치를 더합니다.
    const iframeOffset = await this._getFrameOffset(targetFrame);

    const chartBoundsRaw = await targetFrame.evaluate(() => {
      const scrollY = window.scrollY;
      const scrollX = window.scrollX;

      const innerEls = Array.from(
        document.querySelectorAll<Element>("svg:not(svg svg), canvas")
      ).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 150 && r.height > 100;
      });

      if (innerEls.length === 0) return null;

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
      }).sort((a, b) => a.top - b.top || a.left - b.left);

      if (rects.length === 0) return null;

      type Rect = { top: number; left: number; bottom: number; right: number };
      const ROW_THRESHOLD = 60;
      const rows: Rect[][] = [];
      for (const rect of rects) {
        const lastRow = rows[rows.length - 1];
        if (!lastRow || rect.top - lastRow[0].top > ROW_THRESHOLD) {
          rows.push([rect]);
        } else {
          lastRow.push(rect);
        }
      }

      const targetRects = rows.slice(0, 2).flat();

      const pad = 8;
      return {
        top:    Math.max(0, Math.round(Math.min(...targetRects.map(r => r.top))    - pad)),
        left:   Math.max(0, Math.round(Math.min(...targetRects.map(r => r.left))   - pad)),
        bottom: Math.round(Math.max(...targetRects.map(r => r.bottom)) + pad),
        right:  Math.round(Math.max(...targetRects.map(r => r.right))  + pad),
      };
    });

    // iframe 좌표 보정
    const chartBounds = chartBoundsRaw
      ? {
          top:    chartBoundsRaw.top    + iframeOffset.y,
          left:   chartBoundsRaw.left   + iframeOffset.x,
          bottom: chartBoundsRaw.bottom + iframeOffset.y,
          right:  chartBoundsRaw.right  + iframeOffset.x,
        }
      : null;

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
      fs.renameSync(tempPath, savedPath);
      this.emit("downloading", "차트 위치 미감지 — 전체 이미지 저장", 98);
    }

    try { fs.unlinkSync(tempPath); } catch { /* 이미 삭제(rename)된 경우 무시 */ }

    return [savedPath];
  }
}
