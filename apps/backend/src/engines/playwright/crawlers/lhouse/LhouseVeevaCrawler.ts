import { BaseCrawler }         from "../../BaseCrawler";
import type { CrawlerContext } from "../../types";

/**
 * L HOUSE — Veeva Vault 크롤러 (eQMS · eDMS · eLMS 통합)
 *
 * 접속 URL : https://login.veevavault.com
 * 계정     : LHOUSE_VEEVA_USER / LHOUSE_VEEVA_PASS  (env)
 *
 * 수집 흐름:
 *  1. 로그인 (2단계: 이메일 → 비밀번호)
 *  2. "Select a vault" 드롭다운 → "SKY QMS Production" 선택
 *  3. 리포트 직접 URL 접속
 *     https://sk-qms.veevavault.com/ui/#reporting/viewer/0RP00000008Z001
 *  4. "Activity (Task) Count" 행 우측 … 버튼 → Export to Excel
 *  5. Template 라디오 선택 → Export
 *  6. "Converting Data to Excel Format" 팝업 완료 대기
 *  7. 파일 다운로드 후 경로 반환
 */
export class LhouseVeevaCrawler extends BaseCrawler {
  private static readonly LOGIN_URL   = "https://login.veevavault.com";
  private static readonly REPORT_URL  = "https://sk-qms.veevavault.com/ui/#reporting/viewer/0RP00000008Z001";

  private readonly veevaUser = process.env.LHOUSE_VEEVA_USER ?? "apiadmin@sk.com";
  private readonly veevaPass = process.env.LHOUSE_VEEVA_PASS ?? "12345QWert";

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
      if (found) break;
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
    this.emit("navigating", `페이지 로딩 완료 (스크린샷: ${shotPath})`, 40);
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
                if (node.textContent?.includes("월간 현황 지표")) {
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

  // ── 메인 ─────────────────────────────────────────────────────────────────────

  protected async downloadReport(): Promise<string[]> {

    // ── Step 1. 로그인 ───────────────────────────────────────────────────────────
    this.emit("login", "Veeva Vault 로그인 페이지 접속 중…", 3);
    await this.page.goto(LhouseVeevaCrawler.LOGIN_URL, {
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

    // ── Step 3. 리포트 URL 직접 접속 + 완전 로딩 대기 ──────────────────────────────
    this.emit("navigating", "리포트 페이지 접속 중…", 30);

    await this.page.goto(LhouseVeevaCrawler.REPORT_URL, {
      waitUntil: "domcontentloaded", // SPA는 networkidle이 오래 걸리므로 DOM 기준으로 먼저
      timeout:   60_000,
    });

    this.emit("navigating", "리포트 페이지 렌더링 대기 중…", 33);
    await this._waitForReportReady("월간 현황 지표");

    // ── Step 4. "월간 현황 지표 (월간 Task 실행 수)" 행의 … 버튼 클릭 ─────────────
    this.emit("navigating", "… 버튼 탐색 중…", 45);

    await this._clickEllipsisOnRow("월간 현황 지표 (월간 Task 실행 수)");

    // 드롭다운 메뉴가 실제로 열렸는지 확인 (최대 5초 대기)
    this.emit("navigating", "드롭다운 메뉴 출현 대기 중…", 50);
    const menuAppeared = await this.page.waitForFunction(
      () => {
        // 드롭다운/컨텍스트 메뉴가 DOM에 나타났는지 확인
        const candidates = [
          ...Array.from(document.querySelectorAll("[role='menu'], [role='listbox'], [role='menuitem']")),
          ...Array.from(document.querySelectorAll(".dropdown-menu, .context-menu, .action-menu, .popup-menu")),
          ...Array.from(document.querySelectorAll("[class*='dropdown'], [class*='context'], [class*='popup']")),
        ];
        return candidates.some((el) => (el as HTMLElement).offsetParent !== null);
      },
      { timeout: 5_000 }
    ).catch(() => null);

    if (!menuAppeared) {
      // 디버그용 스크린샷 저장
      const debugPath = `${this.downloadDir}/debug_ellipsis_${Date.now()}.png`;
      await this.page.screenshot({ path: debugPath, fullPage: false }).catch(() => {});
      this.emit("navigating", `드롭다운 미감지 — 스크린샷 저장: ${debugPath}`, 51);
    }

    // "Export to Excel" 항목 탐색 — 다양한 텍스트 변형 시도
    this.emit("navigating", "Export to Excel 선택 중…", 55);

    const exportFound = await this._clickExportToExcel();
    if (!exportFound) {
      const debugPath = `${this.downloadDir}/debug_menu_${Date.now()}.png`;
      await this.page.screenshot({ path: debugPath, fullPage: false }).catch(() => {});
      throw new Error(
        `'Export to Excel' 메뉴 항목을 찾을 수 없습니다. 스크린샷: ${debugPath}\n` +
        `현재 URL: ${this.page.url()}\n` +
        `페이지 텍스트(일부): ${(await this.page.innerText("body").catch(() => "")).slice(0, 300)}`
      );
    }

    await this.page.waitForTimeout(1_000);
    this.emit("navigating", "Export to Excel 다이얼로그 열림", 60);

    // ── Step 5. Template 라디오 선택 → Export ────────────────────────────────────
    this.emit("navigating", "Template 옵션 선택 중…", 65);

    const templateRadio = this.page.getByRole("radio", { name: /template/i });
    const templateLabel = this.page.getByLabel(/template/i);
    const templateText  = this.page.getByText("Template", { exact: true });

    let templateSelected = false;
    for (const loc of [templateRadio, templateLabel, templateText]) {
      if (await loc.count() > 0 && await loc.first().isVisible().catch(() => false)) {
        await loc.first().click();
        templateSelected = true;
        break;
      }
    }
    if (!templateSelected) {
      const sel = await this.waitForVisible(
        ["input[value='template']", "input[value='Template']", "[data-value='template']"],
        5_000, true,
      );
      if (sel) await this.page.click(sel);
    }

    await this.page.waitForTimeout(500);

    this.emit("navigating", "Export 버튼 클릭…", 70);
    const exportBtn = this.page.getByRole("button", { name: /^export$/i });
    if (await exportBtn.count() > 0 && await exportBtn.first().isVisible().catch(() => false)) {
      await exportBtn.first().click();
    } else {
      const exportSel = await this.waitForVisible(
        ["button.export-btn", "[data-testid='export-button']", "button.vv-btn-primary"],
        5_000, false,
      );
      await this.page.click(exportSel!);
    }

    // ── Step 6. "Converting Data to Excel Format" 팝업 완료 대기 ────────────────
    this.emit("downloading", "Excel 변환 중… 완료될 때까지 대기합니다.", 75);
    await this.page.waitForTimeout(2_000);

    // 팝업이 사라질 때까지 최대 5분 대기
    await this.page.waitForSelector("text=Converting Data to Excel Format", {
      state:   "detached",
      timeout: 300_000,
    }).catch(() => {});

    // ── Step 7. 파일 다운로드 ────────────────────────────────────────────────────
    this.emit("downloading", "파일 다운로드 대기 중…", 85);
    const download = await this.page.waitForEvent("download", { timeout: 120_000 });

    const filename  = `veeva_activity_task_count_${Date.now()}.xlsx`;
    const savedPath = `${this.downloadDir}/${filename}`;
    await download.saveAs(savedPath);

    this.emit("downloading", `다운로드 완료 → ${filename}`, 95);
    return [savedPath];
  }
}
