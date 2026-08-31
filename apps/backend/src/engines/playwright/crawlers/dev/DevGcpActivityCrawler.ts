import fs                      from "fs";
import path                    from "path";
import { openVeevaReportUrl, dismissVeevaCallouts } from "../veeva/veevaNavigation";
import { BaseCrawler }         from "../../BaseCrawler";
import type { CrawlerContext } from "../../types";

/**
 * DEV — GCP Quality System Veeva Vault Activity 리포트 Export 크롤러
 *   (LHOUSE LhouseVeevaCrawler 와 동일 흐름 — GCP Vault/리포트 설정으로 복제)
 *
 * 접속 URL : https://login.veevavault.com
 * 계정     : DEV_GCP_VEEVA_USER / DEV_GCP_VEEVA_PASS  (없으면 LHOUSE 계정 fallback)
 *
 * 수집 흐름:
 *  1. 로그인 (2단계: 이메일 → 비밀번호)
 *  2. "Select a vault" 드롭다운 → "SKY GCP Production" 선택
 *  3. 리포트 직접 URL 접속
 *     https://sk-gcp.veevavault.com/ui/#reporting/viewer/0RP00000002D001
 *  4. "Activity (Task) Count - GCP Quality System" 헤더 … 버튼 → Export to Excel
 *  5. Template 라디오 선택 → Export
 *  6. "Converting Data to Excel Format" 팝업 완료 대기
 *  7. 파일 다운로드 → uploads/Activity_GCP.xlsx 로 저장
 */
export class DevGcpActivityCrawler extends BaseCrawler {
  private static readonly LOGIN_URL   = "https://login.veevavault.com";
  private static readonly REPORT_URL  = "https://sk-gcp.veevavault.com/ui/#reporting/viewer/0RP00000002D001";

  private readonly veevaUser = process.env.DEV_GCP_VEEVA_USER ?? process.env.LHOUSE_VEEVA_USER ?? "apiadmin@sk.com";
  private readonly veevaPass = process.env.DEV_GCP_VEEVA_PASS ?? process.env.LHOUSE_VEEVA_PASS ?? "12345QWert";

  constructor(ctx: CrawlerContext) {
    super(ctx);
  }

  // ── 헬퍼: CSS 후보 폴링 ─────────────────────────────────────────────────────

  private async waitForVisible(
    candidates: string[],
    timeoutMs = 15_000,
    optional  = false,
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

  // ── 헬퍼: 로그인 제출 버튼 클릭 ─────────────────────────────────────────────

  private async clickSubmit(): Promise<boolean> {
    for (const text of ["Next", "Continue", "Sign In", "Log In"]) {
      const btn = this.page.getByRole("button", { name: text, exact: false });
      if (await btn.count() > 0 && await btn.first().isVisible().catch(() => false)) {
        await btn.first().click();
        return true;
      }
      // <a> / div 등 비표준 요소 대응
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

  // ── 헬퍼: 리포트 페이지 완전 로딩 대기 ─────────────────────────────────────────

  private async _waitForReportReady(anchorText: string): Promise<void> {
    // Veeva Vault 리포트 뷰어는 데이터를 실행하는 동안 화면 상단에
    // 'Running report "Activity (Task) Count"…' 형태의 팝업 배너를 표시합니다.
    // 이 배너가 사라지면 리포트 로딩이 완료된 것입니다.
    //
    // 대기 전략:
    //  1. 팝업 배너가 DOM에 나타날 때까지 최대 30초 대기 (나타나지 않으면 skip)
    //  2. 팝업 배너가 DOM에서 사라질 때까지 최대 5분 대기
    //  3. 대상 텍스트(anchorText)가 visible 요소에 나타날 때까지 폴링
    //  4. 대상 텍스트 요소를 viewport 중앙으로 스크롤
    //  5. 디버그 스크린샷 저장

    const BANNER_POLL_MS  =  1_000;  // 폴링 간격
    const LOADING_TIMEOUT = 300_000; // 배너 소멸 대기 (최대 5분)
    const CONTENT_TIMEOUT =  60_000; // 콘텐츠 출현 대기

    // "Running report …" 배너 가시성 판단.
    //
    // ※ 핵심: Veeva 배너는 position:fixed 요소이므로 offsetParent === null 이 됩니다.
    //   offsetParent 체크를 사용하면 배너가 보여도 항상 false 를 반환하므로 사용 금지.
    //   대신 getBoundingClientRect().height > 0 으로 실제 렌더링 여부를 확인합니다.
    const isBannerVisible = async (): Promise<boolean> => {
      // 방법 1: Playwright getByText — 내부적으로 getBoundingClientRect 기반 isVisible 사용
      try {
        const loc = this.page.getByText(/Running report/i);
        const cnt = await loc.count();
        if (cnt > 0) {
          for (let i = 0; i < cnt; i++) {
            if (await loc.nth(i).isVisible().catch(() => false)) return true;
          }
        }
      } catch { /* ignore */ }

      // 방법 2: evaluate — getBoundingClientRect 로 실제 렌더링 크기 확인
      return this.page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
          if (node.textContent?.includes("Running report")) {
            const el = node.parentElement as HTMLElement | null;
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            // fixed 요소는 offsetParent=null 이지만 rect는 정상 값을 반환
            if (rect.width > 0 && rect.height > 0) return true;
          }
        }
        return false;
      });
    };

    // 1) 배너가 나타날 때까지 최대 30초 대기
    this.emit("navigating", "리포트 실행 배너 확인 중…", 34);
    let bannerSeen = false;
    const appearDeadline = Date.now() + 30_000;
    while (Date.now() < appearDeadline) {
      if (await isBannerVisible()) { bannerSeen = true; break; }
      await this.page.waitForTimeout(BANNER_POLL_MS);
    }

    // 2) 배너가 보이면 → 사라질 때까지 폴링 (최대 5분)
    if (bannerSeen) {
      this.emit("navigating", "리포트 데이터 실행 중… (배너 소멸 대기, 최대 5분)", 35);
      const disappearDeadline = Date.now() + LOADING_TIMEOUT;
      while (Date.now() < disappearDeadline) {
        if (!(await isBannerVisible())) break;
        const elapsed = LOADING_TIMEOUT - (disappearDeadline - Date.now());
        const pct     = Math.min(39, 35 + Math.floor((elapsed / LOADING_TIMEOUT) * 4));
        this.emit("navigating", "리포트 데이터 로딩 중…", pct);
        await this.page.waitForTimeout(BANNER_POLL_MS);
      }
      if (await isBannerVisible()) {
        this.emit("navigating", "배너 소멸 대기 타임아웃 — 계속 진행합니다.", 39);
      }
    } else {
      // 배너가 없으면(즉시 완료 또는 캐시됨) networkidle로 보완
      this.emit("navigating", "배너 미감지 — networkidle 대기…", 35);
      await this.page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    }

    await this.page.waitForTimeout(1_000); // DOM 안정화

    // 3) anchorText가 visible 요소에 나타날 때까지 폴링 (최대 60초)
    this.emit("navigating", `'${anchorText}' 콘텐츠 확인 중…`, 39);
    let anchorFound = false;
    const deadline = Date.now() + CONTENT_TIMEOUT;
    while (Date.now() < deadline) {
      const found = await this.page.evaluate((text) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
          if (node.textContent?.includes(text)) {
            const el = node.parentElement;
            if (el && el.offsetParent !== null) return true;
          }
        }
        return false;
      }, anchorText);
      if (found) { anchorFound = true; break; }
      await this.page.waitForTimeout(1_000);
    }

    // 4) 대상 텍스트 요소를 viewport 중앙으로 스크롤
    this.emit("navigating", `'${anchorText}' 섹션을 화면 중앙으로 스크롤…`, 39);
    await this.page.evaluate((text) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        if (node.textContent?.includes(text)) {
          const el = node.parentElement;
          if (el && el.offsetParent !== null) {
            el.scrollIntoView({ behavior: "instant", block: "center" });
            return;
          }
        }
      }
    }, anchorText);
    await this.page.waitForTimeout(800);

    // 5) 디버그 스크린샷 (viewport만 — 현재 보이는 상태 확인용)
    const shotPath = `${this.downloadDir}/debug_loaded_${Date.now()}.png`;
    await this.page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
    if (anchorFound) {
      this.emit("navigating", `페이지 로딩 완료 (스크린샷: ${shotPath})`, 40);
    } else {
      // 리포트 라우트 검증은 이동 단계에서 이미 통과했으므로 여기서 예외를 던지지는 않는다.
      // 다만 "완료" 로 오인되지 않도록 경고로 남긴다(과거 오진의 원인).
      this.emit("navigating",
        `'${anchorText}' 텍스트를 확인하지 못했습니다 — 계속 진행합니다. (스크린샷: ${shotPath})`, 40);
    }
  }

  // ── 헬퍼: "Running report …" 배너(=리포트 실행 중) 가시 여부 ───────────────────

  private async _isReportRunning(): Promise<boolean> {
    try {
      const loc = this.page.getByText(/Running report/i);
      const cnt = await loc.count();
      for (let i = 0; i < cnt; i++) {
        if (await loc.nth(i).isVisible().catch(() => false)) return true;
      }
    } catch { /* ignore */ }
    return this.page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        if (node.textContent?.includes("Running report")) {
          const el = node.parentElement as HTMLElement | null;
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return true;
          }
        }
      }
      return false;
    }).catch(() => false);
  }

  // ── 헬퍼: 리포트 헤더의 "…"(More Actions) 메뉴 버튼 클릭 ──────────────────────
  //   제목("Activity (Task) Count")과 같은 헤더 행에서 가장 오른쪽 버튼 = "…".
  //   (↻ 새로고침 · ✎ 편집 다음의 마지막 아이콘) 직접 좌표 기반으로 클릭한다.

  private async _clickReportActionsMenu(titleText: string): Promise<boolean> {
    // ⓪ 혹시 열려있는 다른 메뉴(계정 아바타 드롭다운 등)를 빈 영역 클릭으로 닫는다.
    //    (한 번 잘못 열리면 보고서 헤더 우측을 가려 이후 시도가 모두 막힘)
    await this.page.mouse.click(450, 320).catch(() => {});
    await this.page.waitForTimeout(200);

    // 안내 콜아웃이 헤더를 덮고 있으면 어떤 클릭도 통하지 않는다.
    await dismissVeevaCallouts(this.page);

    // Veeva 자체 클래스로 "…"(More Actions) 버튼을 먼저 노린다.
    //   아래 휴리스틱은 제목 위치 기준으로 오른쪽 아이콘을 추정하므로 헤더 레이아웃이
    //   바뀌면 조용히 어긋난다. Veeva 는 리포트 뷰어 헤더의 "…" 를
    //   `.actionMenuContainer`(= .vv-action-menu-button-container) 안의 버튼으로
    //   렌더링하므로 이 쪽이 훨씬 안정적이다. (2026-08-31 라이브 확인)
    for (const sel of [
      ".actionMenuContainer button",
      ".vv-action-menu-button-container button",
      ".vv_page_header_actions .actionMenuContainer",
    ]) {
      const loc = this.page.locator(sel).first();
      if (await loc.count() === 0) continue;
      if (!await loc.isVisible().catch(() => false)) continue;
      try {
        await loc.click({ timeout: 5_000 });
        return true;
      } catch { /* 다음 후보 / 휴리스틱으로 폴백 */ }
    }

    // ① 제목 요소를 태깅하고 Playwright 로 hover → GCP 리포트 헤더는 hover 시
    //    ↻ ✎ ⋯ 액션 아이콘이 나타나는 경우가 있어 hover 후 탐색한다.
    const titleTagged = await this.page.evaluate((title) => {
      const matchTitle = (s: string) => s === title || s.startsWith("Activity (Task) Count");
      const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
      const el =
        all.find((e) => e.childElementCount === 0 && matchTitle(e.textContent?.trim() ?? "") && e.offsetParent !== null) ??
        all.find((e) => matchTitle(e.textContent?.trim() ?? "") && e.offsetParent !== null);
      if (!el) return false;
      document.querySelectorAll("[data-omc-title]").forEach((x) => x.removeAttribute("data-omc-title"));
      el.setAttribute("data-omc-title", "1");
      return true;
    }, titleText).catch(() => false);
    if (!titleTagged) return false;

    await this.page.locator('[data-omc-title="1"]').first().hover({ timeout: 4_000 }).catch(() => {});
    await this.page.waitForTimeout(500);

    // ② 보고서 헤더 행(제목 세로중심 ±50px)에서 제목 오른쪽의 "…" 후보를 태깅.
    //    ★ 상단 nav 바(아바타/카트/벨, top<100)와 계정 메뉴류는 반드시 제외한다.
    const tagged = await this.page.evaluate(() => {
      const titleEl = document.querySelector<HTMLElement>('[data-omc-title="1"]');
      if (!titleEl) return false;
      const tRect   = titleEl.getBoundingClientRect();
      const titleCY = tRect.top + tRect.height / 2;

      const isAccountish = (el: HTMLElement) => {
        const meta = ((el.getAttribute("aria-label") ?? "") + " " +
                      (el.getAttribute("title") ?? "") + " " +
                      (typeof el.className === "string" ? el.className : "")).toLowerCase();
        return /account|user|profile|avatar|logout|notification|cart|벨|알림/.test(meta);
      };

      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        "button, [role='button'], a, [aria-haspopup], [class*='action'], [class*='menu'], [class*='overflow'], svg"
      )).filter((el) => {
        if (el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (r.top < 100) return false;          // 상단 nav 바 제외 (아바타/카트/벨)
        if (isAccountish(el)) return false;
        const cy = r.top + r.height / 2;
        return Math.abs(cy - titleCY) < 50 && r.left >= tRect.right - 4;
      });
      if (candidates.length === 0) return false;

      candidates.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      let target: HTMLElement = candidates[0];
      let p: HTMLElement | null = target;
      for (let i = 0; i < 4 && p; i++) {
        const tag = p.tagName.toLowerCase();
        if (tag === "button" || p.getAttribute("role") === "button" || tag === "a") { target = p; break; }
        p = p.parentElement;
      }

      document.querySelectorAll("[data-omc-actions]").forEach((e) => e.removeAttribute("data-omc-actions"));
      target.setAttribute("data-omc-actions", "1");
      return true;
    }).catch(() => false);

    if (!tagged) return false;

    // ③ Playwright 실제 클릭
    const loc = this.page.locator('[data-omc-actions="1"]').first();
    try {
      await loc.click({ timeout: 5_000 });
      return true;
    } catch {
      try { await loc.click({ timeout: 3_000, force: true }); return true; }
      catch { return false; }
    }
  }

  /** 실패 진단용: 제목과 같은 헤더 행의 버튼들 정보를 덤프 */
  private async _dumpHeaderButtons(titleText: string): Promise<string> {
    return this.page.evaluate((title) => {
      const matchTitle = (s: string) => s === title || s.startsWith("Activity (Task) Count");
      const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
      const titleEl = all.find((el) => matchTitle(el.textContent?.trim() ?? "") && el.offsetParent !== null);
      if (!titleEl) return "(제목 요소 미발견)";
      const tRect = titleEl.getBoundingClientRect();
      const cy    = tRect.top + tRect.height / 2;
      const btns  = Array.from(document.querySelectorAll<HTMLElement>(
        "button, [role='button'], a, [aria-haspopup], [class*='action'], [class*='menu'], svg"
      ))
        .filter((el) => {
          if (el.offsetParent === null) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && Math.abs(r.top + r.height / 2 - cy) < 60 && r.left >= tRect.right - 4;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return `${el.tagName}@x${Math.round(r.left)} aria='${el.getAttribute("aria-label") ?? ""}' title='${el.getAttribute("title") ?? ""}' cls='${String(el.className ?? "").slice(0, 30)}'`;
        });
      return btns.join("  |  ") || "(헤더 버튼 없음)";
    }, titleText).catch(() => "(덤프 실패)");
  }

  // ── 헬퍼: 특정 텍스트가 있는 섹션/위젯/행의 … 버튼 클릭 ──────────────────────

  private async _clickEllipsisOnRow(sectionText: string): Promise<void> {
    const BTN_SEL =
      "button, [role='button'], a, " +
      "[class*='ellipsis'], [class*='overflow'], [class*='more-action'], " +
      "[class*='action-btn'], [class*='kebab'], [class*='dot-menu'], " +
      "[aria-label*='more' i], [aria-label*='action' i], " +
      "[title*='more' i], [title*='action' i], [title*='export' i]";

    // ── 전략 0: 텍스트 요소 hover → 인근 버튼 감지 (가장 신뢰도 높음) ─────────────
    //   Veeva Vault는 해당 섹션 위에 마우스를 올려야 … 버튼이 나타남
    const candidates = [
      this.page.getByText(sectionText, { exact: true }),
      this.page.getByText(sectionText, { exact: false }),
    ];
    for (const loc of candidates) {
      try {
        const cnt = await loc.count();
        if (cnt === 0) continue;
        // 첫 번째 visible 요소를 찾아 hover
        for (let i = 0; i < cnt; i++) {
          const el = loc.nth(i);
          if (!(await el.isVisible().catch(() => false))) continue;

          // 1) 텍스트 요소 자체에 hover
          await el.hover({ force: true }).catch(() => {});
          await this.page.waitForTimeout(800);

          // 2) 해당 요소 위치 기준 부모를 최대 10단계 올라가며 버튼 탐색
          const clicked = await this.page.evaluate(
            ({ btnSel, idx }) => {
              // 텍스트 노드 기반으로 대상 요소 탐색
              const walker = document.createTreeWalker(
                document.body, NodeFilter.SHOW_TEXT, null
              );
              let node: Text | null;
              let matchEl: HTMLElement | null = null;
              let matchIdx = 0;
              while ((node = walker.nextNode() as Text | null)) {
                if (node.textContent?.includes("Activity (Task) Count")) {
                  const el = node.parentElement as HTMLElement;
                  if (el && el.offsetParent !== null) {
                    if (matchIdx === idx) { matchEl = el; break; }
                    matchIdx++;
                  }
                }
              }
              if (!matchEl) return false;

              // hover 후 visible 버튼 탐색 (부모 최대 10단계)
              let container: Element | null = matchEl;
              for (let i = 0; i < 10 && container; i++) {
                const btns = Array.from(container.querySelectorAll(btnSel))
                  .filter((b) => (b as HTMLElement).offsetParent !== null &&
                                 getComputedStyle(b as HTMLElement).visibility !== "hidden");
                if (btns.length > 0) {
                  (btns[btns.length - 1] as HTMLElement).click();
                  return true;
                }
                container = container.parentElement;
              }
              return false;
            },
            { btnSel: BTN_SEL, idx: i }
          );

          if (clicked) return;
        }
      } catch { /* 다음 후보 */ }
    }

    // ── 전략 1: JS evaluate — hover 없이 DOM에서 직접 탐색 ────────────────────────
    const titleElInfo = await this.page.evaluate((text) => {
      const all = Array.from(document.querySelectorAll("*"));
      const exact = all.find(
        (el) => el.childElementCount === 0 && el.textContent?.trim() === text
      );
      if (exact) return (exact as HTMLElement).className + "||" + (exact as HTMLElement).tagName;
      const partial = all.find((el) => el.textContent?.trim().startsWith(text));
      if (partial) return (partial as HTMLElement).className + "||" + (partial as HTMLElement).tagName;
      return null;
    }, sectionText);

    const jsClicked = await this.page.evaluate(
      ({ text, btnSel }) => {
        const all = Array.from(document.querySelectorAll("*"));
        const titleNodes = all.filter(
          (el) =>
            (el.textContent?.trim() === text ||
             el.textContent?.trim().startsWith(text)) &&
            (el as HTMLElement).offsetParent !== null
        );
        for (const node of titleNodes) {
          let container: Element | null = node.parentElement;
          for (let i = 0; i < 8 && container; i++) {
            const btns = Array.from(container.querySelectorAll(btnSel))
              .filter((b) => (b as HTMLElement).offsetParent !== null);
            if (btns.length > 0) {
              (btns[btns.length - 1] as HTMLElement).click();
              return true;
            }
            container = container.parentElement;
          }
        }
        return false;
      },
      { text: sectionText, btnSel: BTN_SEL }
    );
    if (jsClicked) return;

    // ── 전략 2: Playwright locator — 텍스트 포함 컨테이너 hover 후 버튼 탐색 ────────
    const containerSels = [
      `tr:has-text("${sectionText}")`,
      `[role='row']:has-text("${sectionText}")`,
      `li:has-text("${sectionText}")`,
      `[class*='header']:has-text("${sectionText}")`,
      `[class*='title']:has-text("${sectionText}")`,
      `[class*='panel']:has-text("${sectionText}")`,
      `[class*='widget']:has-text("${sectionText}")`,
      `[class*='card']:has-text("${sectionText}")`,
      `[class*='section']:has-text("${sectionText}")`,
      `div:has-text("${sectionText}")`,
    ];

    for (const csel of containerSels) {
      try {
        const containers = this.page.locator(csel);
        const cnt = await containers.count();
        if (cnt === 0) continue;

        // 가장 작은(leaf에 가까운) 컨테이너부터 탐색
        for (let ci = cnt - 1; ci >= 0; ci--) {
          const c = containers.nth(ci);
          if (!(await c.isVisible().catch(() => false))) continue;
          await c.hover({ force: true }).catch(() => {});
          await this.page.waitForTimeout(600);

          const btns = c.locator(BTN_SEL);
          const bc = await btns.count();
          if (bc > 0) {
            await btns.nth(bc - 1).click();
            return;
          }
        }
      } catch { /* 다음 후보 */ }
    }

    // ── 전략 3: 스크린샷 저장 후 오류 ──────────────────────────────────────────
    const debugPath = `${this.downloadDir}/debug_ellipsis_${Date.now()}.png`;
    await this.page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
    throw new Error(
      `'${sectionText}' 섹션의 … 버튼을 찾을 수 없습니다.\n` +
      `스크린샷: ${debugPath}\n` +
      `titleEl 디버그: ${titleElInfo ?? "미발견"}`
    );
  }

  // ── 헬퍼: 드롭다운에서 "Export to Excel" 클릭 ──────────────────────────────────

  private async _clickExportToExcel(): Promise<boolean> {
    // Veeva Vault 드롭다운은 body에 portal로 렌더링될 수 있으므로 전체 페이지 탐색
    // 텍스트 변형: "Export to Excel" / "Export to Excel..." / "Excel로 내보내기" 등
    const textVariants = [
      /export to excel/i,
      /export.*excel/i,
      /excel.*export/i,
    ];

    for (const pattern of textVariants) {
      const loc = this.page.getByText(pattern);
      if (await loc.count() > 0 && await loc.first().isVisible().catch(() => false)) {
        await loc.first().click();
        return true;
      }
    }

    // role='menuitem' 에서 탐색
    const menuItems = this.page.getByRole("menuitem");
    const itemCount = await menuItems.count();
    for (let i = 0; i < itemCount; i++) {
      const item = menuItems.nth(i);
      const txt  = await item.textContent().catch(() => "");
      if (/export.*excel/i.test(txt ?? "")) {
        await item.click();
        return true;
      }
    }

    // option / li 에서 텍스트 탐색
    const jsClicked = await this.page.evaluate(() => {
      const els = Array.from(document.querySelectorAll(
        "[role='menuitem'], [role='option'], li, a, button, [class*='menu-item'], [class*='dropdown-item']"
      ));
      for (const el of els) {
        const txt = el.textContent?.toLowerCase() ?? "";
        if (txt.includes("export") && txt.includes("excel")) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    return jsClicked;
  }

  // ── 헬퍼: "Excel Export Options" 팝업의 Export 버튼 클릭 ───────────────────────
  //   ("Export to Excel/Text/PDF" 메뉴 항목이 아닌, 정확히 "Export" 인 확정 버튼)

  private async _clickExportButton(): Promise<boolean> {
    // 1) role=button, 접근가능 이름이 정확히 "Export"
    const byRole = this.page.getByRole("button", { name: /^\s*export\s*$/i });
    const rc = await byRole.count();
    for (let i = 0; i < rc; i++) {
      const b = byRole.nth(i);
      if (await b.isVisible().catch(() => false)) {
        await b.click().catch(() => {});
        return true;
      }
    }

    // 2) evaluate — 보이는 요소 중 트림 텍스트가 정확히 "Export" 인 클릭 가능 요소
    //    (다이얼로그/모달 내부를 우선 선택)
    return this.page.evaluate(() => {
      const visible = (el: HTMLElement) =>
        el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden";
      const inDialog = (el: Element) =>
        !!el.closest("dialog, [role='dialog'], [class*='modal'], [class*='dialog'], [class*='popup']");

      const els = Array.from(document.querySelectorAll<HTMLElement>(
        "button, [role='button'], a, input[type='button'], input[type='submit'], [class*='btn'], [class*='button']"
      )).filter((el) => {
        if (!visible(el)) return false;
        const t = (el.tagName === "INPUT"
          ? (el as HTMLInputElement).value
          : el.textContent ?? "").trim();
        return /^export$/i.test(t);
      });
      if (els.length === 0) return false;

      els.sort((a, b) => Number(inDialog(b)) - Number(inDialog(a)));
      const target = els[0];
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      target.dispatchEvent(new PointerEvent("pointerup",   { bubbles: true }));
      target.dispatchEvent(new MouseEvent("click",         { bubbles: true }));
      return true;
    }).catch(() => false);
  }

  // ── 헬퍼: 디버그 스크린샷(단계별 진행 상황 확인용) ───────────────────────────────

  private async _debugShot(label: string): Promise<void> {
    const p = `${this.downloadDir}/step_${label}_${Date.now()}.png`;
    await this.page.screenshot({ path: p, fullPage: false }).catch(() => {});
    this.emit("navigating", `[스크린샷] ${label} → ${p}`);
  }

  // ── 헬퍼: "Excel Export Options" 팝업이 열렸는지 확인 ─────────────────────────────

  private async _isExportOptionsDialogOpen(): Promise<boolean> {
    try {
      const loc = this.page.getByText(/Excel Export Options/i);
      if (await loc.count() > 0 && await loc.first().isVisible().catch(() => false)) return true;
    } catch { /* ignore */ }
    // 보조 판단: 옵션 라디오(Data Only · Formatted · Template) 가 동시에 보이면 다이얼로그로 간주
    return this.page.evaluate(() => {
      const txt = document.body.innerText || "";
      return /Excel Export Options/i.test(txt) ||
        (/Data Only/i.test(txt) && /Formatted/i.test(txt) && /Template/i.test(txt));
    }).catch(() => false);
  }

  // ── 메인 ─────────────────────────────────────────────────────────────────────

  protected async downloadReport(): Promise<string[]> {

    // ── Step 1. 로그인 ───────────────────────────────────────────────────────────
    this.emit("login", "Veeva Vault 로그인 페이지 접속 중…", 3);
    await this.page.goto(DevGcpActivityCrawler.LOGIN_URL, {
      waitUntil: "networkidle",
      timeout:   45_000,
    });

    this.emit("login", "로그인 폼 확인 중…", 5);

    // password 필드가 이미 보이면(재방문 단일 폼) 이메일 단계 skip
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

      // 이메일 제출 후 Okta SSO 리다이렉트 완료 대기
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

    // 로그인 오류 확인
    const errEl = await this.page.$(".login-error, [class*='error-msg']");
    if (errEl) {
      const msg = await errEl.innerText().catch(() => "");
      if (msg.trim()) throw new Error(`로그인 오류: ${msg.trim()}`);
    }
    this.emit("login", "로그인 완료", 20);

    // ── Step 2. Vault 선택 ───────────────────────────────────────────────────────
    this.emit("navigating", "Vault 드롭다운 탐색 중…", 22);
    await this.page.waitForTimeout(2_000);

    // Vault 업그레이드 안내 콜아웃이 화면 전체를 덮어 클릭을 가로채므로 먼저 닫는다.
    await dismissVeevaCallouts(this.page, (m) => this.emit("navigating", m, 22));

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

    try {
      if (vaultSel) {
        await this.page.click(vaultSel, { timeout: 10_000 });
      } else {
        const btn = this.page.getByText("Select a vault", { exact: false });
        if (await btn.count() > 0 && await btn.first().isVisible().catch(() => false)) {
          await btn.first().click({ timeout: 10_000 });
        } else {
          this.emit("navigating", "Vault 드롭다운 미발견 — 현재 Vault로 계속합니다.", 23);
        }
      }
    } catch (e) {
      // 리포트는 아래에서 URL 로 직접 여므로 드롭다운을 못 열어도 계속 진행한다.
      this.emit("navigating",
        `Vault 드롭다운 클릭 실패 — 현재 Vault로 계속합니다. (${(e as Error).message.split("\n")[0]})`, 23);
    }

    await this.page.waitForTimeout(1_000);

    const vaultNames = ["SKY GCP Production", "GCP Production", "GCP", "sk-gcp"];
    let vaultSelected = false;
    for (const name of vaultNames) {
      const opt = this.page.getByText(name, { exact: false });
      if (await opt.count() > 0 && await opt.first().isVisible().catch(() => false)) {
        await opt.first().click();
        this.emit("navigating", `${name} 선택 완료`, 25);
        await this.page.waitForLoadState("networkidle").catch(() => {});
        vaultSelected = true;
        break;
      }
    }
    if (!vaultSelected) {
      this.emit("navigating", "GCP Vault 옵션 미발견 — 리포트 URL로 직접 접속합니다.", 25);
    }

    // ── Step 3. 리포트 URL 직접 접속 + 완전 로딩 대기 ──────────────────────────────
    this.emit("navigating", "리포트 페이지 접속 중…", 30);

    // 이동 + 리포트 라우트 유지 검증 (공용 헬퍼) — 해시만 바꿀 때 SPA 부팅 라우팅과
    //   경쟁해 Home 으로 튕기던 문제를 강제 재로딩 + URL 검증으로 해결한다.
    const targetUrl = DevGcpActivityCrawler.REPORT_URL;
    await openVeevaReportUrl(this.page, targetUrl, {
      emit: (m) => this.emit("navigating", m, 31),
    });

    // 재로딩 뒤 콜아웃이 다시 뜰 수 있다 — "…" 메뉴 클릭이 막히지 않도록 한 번 더 닫는다.
    await dismissVeevaCallouts(this.page, (m) => this.emit("navigating", m, 32));

    this.emit("navigating", "리포트 페이지 렌더링 대기 중…", 33);
    await this._waitForReportReady("Activity (Task) Count");
    await this._debugShot("report_loaded");

    // ── Step 4-5. … 메뉴 → Export to Excel (리포트 로딩 완료까지 재시도) ─────────
    // 리포트가 아직 실행 중("Running report" 배너 / 표가 연하게 표시)이면 … 메뉴에
    // Export to Excel 이 나타나지 않거나 메뉴가 열리지 않는다. 배너가 사라질 때까지
    // 기다린 뒤 (… 메뉴 열기 → Export 클릭)을 최대 5분간 재시도한다.
    this.emit("navigating", "… 메뉴 → Export to Excel 준비 중…", 45);

    // 리포트 실행 배너가 떠 있으면 한 번만 최대 90초 대기 (배너가 끝내 안 사라져도 진행)
    const bannerDeadline = Date.now() + 90_000;
    while (Date.now() < bannerDeadline && (await this._isReportRunning())) {
      this.emit("navigating", "리포트 로딩 대기 중…", 46);
      await this.page.waitForTimeout(3_000);
    }

    const MAX_ATTEMPTS = 15;
    let exportClicked = false;
    let attempt = 0;

    while (attempt < MAX_ATTEMPTS && !exportClicked) {
      attempt++;

      // (a) "…"(More Actions) 메뉴 열기 — 보고서 헤더 우측 "…" 직접 클릭.
      //     (구 _clickEllipsisOnRow 폴백은 페이지 우상단 아바타를 잘못 클릭하므로 미사용)
      this.emit("navigating", `… 메뉴 열기 (시도 ${attempt}/${MAX_ATTEMPTS})`, 50);
      await this._clickReportActionsMenu("Activity (Task) Count - GCP Quality System");

      await this.page.waitForTimeout(1_500);
      await this._debugShot(`menu_open_a${attempt}`);

      // (b) Export to Excel 클릭
      this.emit("navigating", `Export to Excel 선택 중… (시도 ${attempt}/${MAX_ATTEMPTS})`, 55);
      const clickedExcel = await this._clickExportToExcel();
      await this.page.waitForTimeout(1_500);

      // (c) "Excel Export Options" 다이얼로그가 실제로 열렸는지 확인해야 성공으로 간주
      if (clickedExcel && (await this._isExportOptionsDialogOpen())) {
        await this._debugShot(`exportoptions_a${attempt}`);
        exportClicked = true;
        break;
      }

      // 실패 → 디버그샷 + 열린 메뉴(아바타 드롭다운 등) 빈 영역 클릭으로 닫고 재시도.
      //   (Veeva 계정 메뉴는 Escape 로 안 닫혀 헤더를 계속 가리므로 outside-click 사용)
      await this._debugShot(`fail_a${attempt}`);
      await this.page.mouse.click(450, 320).catch(() => {});
      await this.page.keyboard.press("Escape").catch(() => {});
      await this.page.waitForTimeout(4_000);
    }

    if (!exportClicked) {
      const debugPath = `${this.downloadDir}/debug_menu_${Date.now()}.png`;
      await this.page.screenshot({ path: debugPath, fullPage: false }).catch(() => {});
      const headerBtns = await this._dumpHeaderButtons("Activity (Task) Count");
      throw new Error(
        `'Export to Excel' 메뉴 항목을 찾을 수 없습니다 (${attempt}회 시도). 스크린샷: ${debugPath}\n` +
        `현재 URL: ${this.page.url()}\n` +
        `헤더 버튼 후보: ${headerBtns}\n` +
        `페이지 텍스트(일부): ${(await this.page.innerText("body").catch(() => "")).slice(0, 300)}`
      );
    }

    await this.page.waitForTimeout(1_000);
    this.emit("navigating", "Export to Excel 다이얼로그 열림", 60);
    await this._debugShot("dialog_opened");

    // ── Step 5. Template 라디오 선택 → Export ────────────────────────────────────
    this.emit("navigating", "Template 옵션 선택 중…", 65);

    const templateRadio = this.page.getByRole("radio", { name: /template/i });
    const templateLabel = this.page.getByLabel(/template/i);
    const templateText  = this.page.getByText("Template", { exact: true });

    // Template 은 보통 기본 선택(파란 라디오)이므로, 선택 클릭이 실패해도 흐름을
    // 막지 않는다. 클릭은 전부 best-effort 로 처리한다.
    let templateSelected = false;
    for (const loc of [templateRadio, templateLabel, templateText]) {
      if (await loc.count() > 0 && await loc.first().isVisible().catch(() => false)) {
        await loc.first().click({ timeout: 4_000 }).catch(() => {});
        templateSelected = true;
        break;
      }
    }
    if (!templateSelected) {
      const sel = await this.waitForVisible(
        ["input[value='template']", "input[value='Template']", "[data-value='template']"],
        5_000, true,
      );
      if (sel) await this.page.click(sel).catch(() => {});
    }

    await this.page.waitForTimeout(500);
    await this._debugShot("template_selected");

    this.emit("navigating", "Export 버튼 클릭…", 70);
    let exportBtnClicked = false;
    const exportBtnDeadline = Date.now() + 30_000; // 다이얼로그 렌더 대비 최대 30초 재시도
    while (Date.now() < exportBtnDeadline && !exportBtnClicked) {
      if (await this._clickExportButton()) { exportBtnClicked = true; break; }
      await this.page.waitForTimeout(1_500);
    }
    if (!exportBtnClicked) {
      const debugPath = `${this.downloadDir}/debug_exportbtn_${Date.now()}.png`;
      await this.page.screenshot({ path: debugPath, fullPage: false }).catch(() => {});
      throw new Error(
        `'Excel Export Options' 팝업의 Export 버튼을 찾을 수 없습니다. 스크린샷: ${debugPath}\n` +
        `페이지 텍스트(일부): ${(await this.page.innerText("body").catch(() => "")).slice(0, 300)}`
      );
    }

    // ── Step 6. 다운로드 대기 + 변환 진행 표시 ──────────────────────────────────
    // ★ 중요: 다운로드 이벤트는 "변환 완료 시점"(=팝업이 사라지는 순간)에 발생한다.
    //   팝업이 사라진 뒤에 리스너를 걸면 그 이벤트를 놓쳐 타임아웃→재시도되므로,
    //   변환 대기 "이전에" 다운로드 리스너(Promise)를 먼저 등록해 둔다.
    this.emit("downloading", "Excel 변환 중… 완료될 때까지 대기합니다.", 75);
    const downloadPromise = this.page.waitForEvent("download", { timeout: 600_000 }); // 최대 10분

    await this.page.waitForTimeout(2_000);
    await this._debugShot("converting");

    // 변환 팝업이 사라질 때까지 대기(진행 표시용) — 실패해도 무시(실제 신호는 download)
    await this.page.waitForSelector("text=Converting Data to Excel Format", {
      state:   "detached",
      timeout: 600_000,
    }).catch(() => {});

    // ── Step 7. 파일 다운로드 ────────────────────────────────────────────────────
    this.emit("downloading", "파일 다운로드 대기 중…", 85);
    const download = await downloadPromise;

    // 보고서/화면은 UPLOAD_DIR/{jobId}/uploads/Activity_GCP.xlsx 경로의 파일을
    // 사용한다(수동 업로드와 동일 위치). downloadDir 은 UPLOAD_DIR/{jobId} 이므로
    // 반드시 그 하위 uploads/ 폴더에 저장해야 한다.
    const filename   = "Activity_GCP.xlsx";
    const uploadsDir = path.join(this.downloadDir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const savedPath  = path.join(uploadsDir, filename);
    await download.saveAs(savedPath);

    this.emit("downloading", `다운로드 완료 → uploads/${filename}`, 95);
    return [savedPath];
  }
}
