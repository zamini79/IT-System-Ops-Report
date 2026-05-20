/**
 * DEV — Clinical Trial Management System (CTMS) Veeva Vault 대시보드 스크린샷 크롤러
 *
 * 로그인 후 아래 URL의 대시보드를 캡처합니다.
 *   https://sk-clinical.veevavault.com/ui/#dashboards/viewer/0DB000000003001
 *
 * 필터 설정 흐름:
 *   "FILTERS (N)" 텍스트 우측 연필 아이콘 클릭
 *   → 팝업에서 날짜 범위 입력 (3개월 전 1일 ~ 1개월 전 마지막 날, "DD MMM YYYY")
 *   → Continue 클릭 → 차트 재로딩 대기
 *
 * 결과 파일(반환 순서):
 *   files[0] = Clinical1 (차트 2 + 차트 3 결합)
 *   files[1] = Clinical2 (차트 1 단독)
 */

import path                   from "path";
import fs                     from "fs";
import sharp                  from "sharp";
import type { Frame }          from "playwright";
import { BaseCrawler }         from "../../BaseCrawler";
import type { CrawlerContext } from "../../types";

export class DevClinicalDashboardCrawler extends BaseCrawler {
  private static readonly LOGIN_URL     = "https://login.veevavault.com";
  private static readonly DASHBOARD_URL =
    "https://sk-clinical.veevavault.com/ui/#dashboards/viewer/0DB000000003001";

  private readonly veevaUser = process.env.DEV_CLINICAL_VEEVA_USER ?? process.env.LHOUSE_VEEVA_USER ?? "apiadmin@sk.com";
  private readonly veevaPass = process.env.DEV_CLINICAL_VEEVA_PASS ?? process.env.LHOUSE_VEEVA_PASS ?? "12345QWert";

  constructor(ctx: CrawlerContext) {
    super(ctx);
  }

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

  // ── 헬퍼: 날짜 포맷 (DD MMM YYYY, 예: "01 Feb 2026") ─────────────────────

  private fmtDate(d: Date): string {
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dd = String(d.getDate()).padStart(2, "0");
    return `${dd} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

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
    return this.page.mainFrame();
  }

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

  private async _applyDateFilter(
    startStr: string,
    endStr:   string,
    frame:    Frame,
  ): Promise<void> {
    this.emit("navigating", `날짜 필터 설정 중… (${startStr} ~ ${endStr})`, 34);

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

    const BTN_NAMES = [
      "Continue", "Apply", "OK", "확인", "Submit",
      "Save", "Done", "Update", "Refresh", "Run",
      "View", "Show", "Filter", "Go", "저장", "적용",
    ];
    const CANCEL_NAMES = /cancel|close|취소|reset|clear/i;

    let continueDone = false;
    for (const name of BTN_NAMES) {
      const btn = frame.getByRole("button", { name, exact: false });
      if (await btn.count() > 0 && await btn.first().isVisible().catch(() => false)) {
        await btn.first().click();
        this.emit("navigating", `"${name}" 버튼 클릭 완료`, 38);
        continueDone = true;
        break;
      }
    }

    if (!continueDone) {
      const clicked = await frame.evaluate((cancelPattern: string): string | null => {
        const cancelRe = new RegExp(cancelPattern, "i");
        const PANEL_SELS = [
          "dialog", "[role='dialog']",
          "[class*='modal']", "[class*='popup']", "[class*='overlay']",
          "[class*='filter']", "[class*='Filter']",
        ];
        for (const sel of PANEL_SELS) {
          const panel = document.querySelector(sel);
          if (!panel) continue;
          const btns = Array.from(
            panel.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]')
          ).filter((el) => {
            const s = window.getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden" || el.offsetParent === null) return false;
            const label = (el.innerText || el.getAttribute("aria-label") || "").trim();
            return label.length > 0 && !cancelRe.test(label);
          });
          if (btns.length === 0) continue;
          const primary = btns.find((b) => /primary|confirm|action/i.test(b.className));
          const target  = primary ?? btns[btns.length - 1];
          target.click();
          return (target.innerText || target.getAttribute("aria-label") || "").trim();
        }
        return null;
      }, CANCEL_NAMES.source);

      if (clicked) {
        this.emit("navigating", `휴리스틱 버튼 클릭: "${clicked}"`, 38);
        continueDone = true;
      }
    }

    if (!continueDone) {
      this.emit("navigating", "Continue 버튼 미발견 — Enter 키 시도", 38);
      await this.page.keyboard.press("Enter");
    }

    await this.page.waitForTimeout(2_000);
  }

  // ── 메인 ─────────────────────────────────────────────────────────────────────

  protected async downloadReport(): Promise<string[]> {

    // ── Step 1. 로그인 ──────────────────────────────────────────────────────────
    this.emit("login", "Veeva Vault 로그인 페이지 접속 중…", 3);
    await this.page.goto(DevClinicalDashboardCrawler.LOGIN_URL, {
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

    // ── Step 2. Vault 선택 (sk-clinical.veevavault.com) ────────────────────────
    this.emit("navigating", "Clinical Vault 탐색 중…", 22);
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

    const vaultNames = [
      "SKY Clinical Production", "Clinical Production",
      "CTMS Production", "CTMS",
      "Clinical", "sk-clinical",
    ];
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
      this.emit("navigating", "Clinical Vault 옵션 미발견 — 대시보드 URL로 직접 접속합니다.", 25);
    }

    // ── Step 3. 대시보드 URL 접속 ──────────────────────────────────────────────
    this.emit("navigating", "Clinical 대시보드 페이지 접속 중…", 28);
    await this.page.setViewportSize({ width: 1600, height: 1000 });

    await this.page.goto(DevClinicalDashboardCrawler.DASHBOARD_URL, {
      waitUntil: "domcontentloaded",
      timeout:   60_000,
    });

    await this.page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await this.page.waitForTimeout(3_000);

    // ── Step 3.5. 대시보드 프레임 탐지 ────────────────────────────────────────
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
    const tempPath  = path.join(this.downloadDir, `_tmp_clinical_dashboard_${ts}.png`);
    const clinical1Path = path.join(this.downloadDir, `clinical_dashboard_chart23_${ts}.png`);
    const clinical2Path = path.join(this.downloadDir, `clinical_dashboard_chart1_${ts}.png`);

    await this.page.screenshot({ path: tempPath, fullPage: true, type: "png" });

    // ── Step 6. 3개 차트 좌표 추출 ───────────────────────────────────────────
    this.emit("downloading", "차트 영역 좌표 계산 중…", 93);

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

      const maxCardW = window.innerWidth * 0.9;

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

      if (rects.length < 3) return { partial: true, rects };

      const pad = 8;
      return {
        partial: false,
        // 차트 1 (단독) → Clinical2
        clinical2: {
          top:    Math.max(0, Math.round(rects[0].top    - pad)),
          left:   Math.max(0, Math.round(rects[0].left   - pad)),
          bottom: Math.round(rects[0].bottom + pad),
          right:  Math.round(rects[0].right  + pad),
        },
        // 차트 2 + 차트 3 (결합) → Clinical1
        clinical1: {
          top:    Math.max(0, Math.round(Math.min(rects[1].top,    rects[2].top)    - pad)),
          left:   Math.max(0, Math.round(Math.min(rects[1].left,   rects[2].left)   - pad)),
          bottom: Math.round(Math.max(rects[1].bottom, rects[2].bottom) + pad),
          right:  Math.round(Math.max(rects[1].right,  rects[2].right)  + pad),
        },
      };
    });

    // ── Step 7. sharp 로 분할 저장 ────────────────────────────────────────────
    const meta  = await sharp(tempPath).metadata();
    const imgW  = meta.width  ?? 1600;
    const imgH  = meta.height ?? 1000;

    const applyOffset = (b: { top: number; left: number; bottom: number; right: number }) => ({
      top:    b.top    + iframeOffset.y,
      left:   b.left   + iframeOffset.x,
      bottom: b.bottom + iframeOffset.y,
      right:  b.right  + iframeOffset.x,
    });

    const extractTo = async (b: { top: number; left: number; bottom: number; right: number }, outPath: string) => {
      const left   = Math.min(b.left, imgW - 1);
      const top    = Math.min(b.top,  imgH - 1);
      const width  = Math.min(b.right  - b.left, imgW - left);
      const height = Math.min(b.bottom - b.top,  imgH - top);
      await sharp(tempPath).extract({ left, top, width, height }).toFile(outPath);
      return { width, height };
    };

    if (chartBoundsRaw && !chartBoundsRaw.partial) {
      const sz1 = await extractTo(applyOffset(chartBoundsRaw.clinical1!), clinical1Path);
      const sz2 = await extractTo(applyOffset(chartBoundsRaw.clinical2!), clinical2Path);
      this.emit("downloading",
        `Clinical1 (차트 2+3) ${sz1.width}×${sz1.height}px · Clinical2 (차트 1) ${sz2.width}×${sz2.height}px`,
        98,
      );
    } else {
      // 차트 3개 미감지 — 전체 이미지를 양쪽에 동일하게 저장
      fs.copyFileSync(tempPath, clinical1Path);
      fs.copyFileSync(tempPath, clinical2Path);
      this.emit("downloading", "차트 3개 미감지 — 전체 이미지 저장", 98);
    }

    try { fs.unlinkSync(tempPath); } catch { /* 이미 정리된 경우 무시 */ }

    return [clinical1Path, clinical2Path];
  }
}
