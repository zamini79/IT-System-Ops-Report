import path from "path";
import fs   from "fs";
import type { Browser, BrowserContext, Page } from "playwright";
import { logger }                              from "../../utils/logger";
import { getLastNMonths }                      from "./utils/dateRange";
import type { ReportSelectors }                from "./config/selectors";
import type {
  CrawlerContext,
  CrawlerResult,
  LoginCredentials,
  ProgressCallback,
  ProgressEvent,
  CrawlStage,
  ScreenshotOptions,
  ScreenshotResult,
} from "./types";

/**
 * 모든 크롤러가 상속하는 추상 기반 클래스.
 *
 * ─ 템플릿 메서드 패턴 ──────────────────────────────────────────────────────────
 *   run()            → (공통) startTimer → downloadReport → buildResult
 *   downloadReport() → (서브클래스 구현) 실제 크롤링 로직
 *
 * ─ 진행률 규약 ────────────────────────────────────────────────────────────────
 *    0 %  : init      — 크롤러 시작
 *   25 %  : login     — 로그인 완료
 *   75 %  : navigating — 보고서 필터 설정 완료
 *  100 %  : completed — 다운로드 완료
 */
export abstract class BaseCrawler {
  protected readonly page:        Page;
  protected readonly context:     BrowserContext;
  protected readonly jobId:       string;
  protected readonly system:      string;
  protected readonly downloadDir: string;

  private progressCb?: ProgressCallback;
  private startedAt   = 0;

  constructor(ctx: CrawlerContext) {
    this.page        = ctx.page;
    this.context     = ctx.context;
    this.jobId       = ctx.jobId;
    this.system      = ctx.system;
    this.downloadDir = ctx.downloadDir;
  }

  // ── 공개 API ─────────────────────────────────────────────────────────────────

  /** 진행 상태 콜백 등록 (메서드 체이닝 지원) */
  onProgress(cb: ProgressCallback): this {
    this.progressCb = cb;
    return this;
  }

  /**
   * 템플릿 메서드: 타이머 → downloadReport() → 결과 반환.
   * 서브클래스는 run() 대신 downloadReport() 를 구현하세요.
   */
  async run(): Promise<CrawlerResult> {
    this.startTimer();
    const files = await this.downloadReport();
    return this.buildResult(files);
  }

  /** 실제 크롤링 구현 — 서브클래스 필수 구현 */
  protected abstract downloadReport(): Promise<string[]>;

  /** 브라우저 컨텍스트 정리 */
  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }

  // ── 공통 헬퍼 (protected) ─────────────────────────────────────────────────────

  /**
   * 범용 폼 로그인.
   * 시스템별 셀렉터는 LoginSelectors 에서 주입받습니다.
   */
  protected async login(creds: LoginCredentials & {
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?:   string;
    successSelector?:  string;
  }): Promise<void> {
    this.emit("login", `${creds.url} 로그인 중…`);

    await this.page.goto(creds.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const userSel   = creds.usernameSelector ?? 'input[name="username"], input[name="userId"], input[name="id"], input[type="email"], #userId, #username';
    const passSel   = creds.passwordSelector ?? 'input[name="password"], input[name="passwd"], input[type="password"], #password, #userPw';
    const submitSel = creds.submitSelector   ?? 'button[type="submit"], input[type="submit"], .login-btn, #loginBtn, .btn-login';

    await this._fillFirst(userSel.split(",").map(s => s.trim()),   creds.username);
    await this._fillFirst(passSel.split(",").map(s => s.trim()),   creds.password);
    await this._clickFirst(submitSel.split(",").map(s => s.trim()));

    if (creds.successSelector) {
      await this.page.waitForSelector(creds.successSelector, { timeout: 15_000 });
    } else {
      await this.page
        .waitForNavigation({ waitUntil: "networkidle", timeout: 15_000 })
        .catch(() => {});
    }
  }

  /**
   * 보고서 페이지로 이동합니다.
   * reportPath 가 있으면 직접 goto, menuPath 가 있으면 순서대로 클릭.
   */
  protected async navigateToReport(
    baseUrl: string,
    sel:     ReportSelectors
  ): Promise<void> {
    this.emit("navigating", "보고서 페이지 이동 중…");

    if (sel.reportPath) {
      await this.page.goto(`${baseUrl}${sel.reportPath}`, {
        waitUntil: "networkidle",
        timeout:   20_000,
      });
    } else if (sel.menuPath?.length) {
      for (const menuSel of sel.menuPath) {
        await this.page.click(menuSel);
        await this.page.waitForTimeout(500);
      }
    }
  }

  /**
   * 날짜 범위 필터를 설정합니다.
   * 기본: 최근 3개월. 날짜 포맷은 sel.dateFormat 을 따릅니다.
   */
  protected async setDateFilter(
    sel:    ReportSelectors,
    months  = 3
  ): Promise<void> {
    const { from, to } = getLastNMonths(months, sel.dateFormat);
    this.emit("navigating", `기간 설정: ${from} ~ ${to}`);

    await this._setDateInput(sel.dateFromInput, from);
    await this._setDateInput(sel.dateToInput,   to);

    if (sel.applyButton) {
      await this.page.click(sel.applyButton);
      if (sel.tableReady) {
        await this.page.waitForSelector(sel.tableReady, { timeout: 20_000 });
      } else {
        await this.page.waitForLoadState("networkidle");
      }
    }
  }

  /**
   * 스크린샷 캡처.
   *
   * ─ 동작 순서 ─────────────────────────────────────────────────────────────────
   *  1. 뷰포트 해상도 설정 (기본 1280×720)
   *  2. options.url 로 이동 (기존 로그인 세션 유지)
   *  3. selector 있으면 해당 요소만, 없으면 viewport(fullPage 옵션 적용) 캡처
   *  4. PNG 파일로 저장 후 { path, width, height, capturedAt } 반환
   *
   * @remarks 반드시 login() 이후에 호출해야 세션이 유지됩니다.
   */
  protected async takeScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const width  = options.width  ?? 1280;
    const height = options.height ?? 720;

    // 1. 해상도 설정
    await this.page.setViewportSize({ width, height });

    // 2. URL 이동 (세션 쿠키 포함)
    await this.page.goto(options.url, { waitUntil: "networkidle", timeout: 30_000 });

    // 3. 저장 디렉토리 보장
    const dir = path.dirname(options.outputPath);
    fs.mkdirSync(dir, { recursive: true });

    let capturedWidth  = width;
    let capturedHeight = height;

    if (options.selector) {
      // 특정 요소 캡처
      const el = await this.page.waitForSelector(options.selector, { timeout: 15_000 });
      if (!el) throw new Error(`요소를 찾을 수 없습니다: ${options.selector}`);

      await el.screenshot({ path: options.outputPath, type: "png" });

      // 실제 요소 크기 반영
      const box = await el.boundingBox();
      if (box) {
        capturedWidth  = Math.round(box.width);
        capturedHeight = Math.round(box.height);
      }
    } else {
      // viewport 또는 전체 페이지 캡처
      await this.page.screenshot({
        path:     options.outputPath,
        type:     "png",
        fullPage: options.fullPage ?? false,
      });

      if (options.fullPage) {
        // 전체 페이지의 실제 크기
        const dims = await this.page.evaluate(() => ({
          width:  document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }));
        capturedWidth  = dims.width;
        capturedHeight = dims.height;
      }
    }

    const result: ScreenshotResult = {
      path:       options.outputPath,
      width:      capturedWidth,
      height:     capturedHeight,
      capturedAt: new Date().toISOString(),
    };

    logger.info(
      `[${this.system}] Screenshot → ${options.outputPath} ` +
      `(${capturedWidth}×${capturedHeight})`
    );

    return result;
  }

  /**
   * 로그인 → 스크린샷 공개 진입점.
   *
   * CrawlerFactory.screenshot() 에서 호출하며,
   * 서브클래스는 특수 인증이 필요한 경우 이 메서드를 override 하세요.
   *
   * 진행률: 0% init → 25% login → 50% navigating → 100% completed
   */
  async runScreenshot(
    screenshotOptions: ScreenshotOptions,
    loginParams: LoginCredentials & {
      usernameSelector?: string;
      passwordSelector?: string;
      submitSelector?:   string;
      successSelector?:  string;
    }
  ): Promise<ScreenshotResult> {
    this.startTimer();

    await this.login(loginParams);
    this.emit("login", "로그인 완료", 25);

    this.emit("navigating", `${screenshotOptions.url} 이동 중…`, 50);
    const result = await this.takeScreenshot(screenshotOptions);

    this.emit("completed", `스크린샷 완료 → ${result.path}`, 100);
    return result;
  }

  /**
   * 다운로드 완료 대기.
   * trigger 콜백과 download 이벤트를 동시에 기다립니다.
   */
  protected async waitForDownload(
    trigger:   () => Promise<void>,
    filename?: string
  ): Promise<string> {
    this.emit("downloading", "다운로드 대기 중…");

    const [download] = await Promise.all([
      this.page.waitForEvent("download", { timeout: 60_000 }),
      trigger(),
    ]);

    // 다운로드 확인 팝업 자동 처리 (있을 경우)
    const destName = filename ?? download.suggestedFilename();
    const destPath = path.join(this.downloadDir, destName);

    await download.saveAs(destPath);
    logger.info(`[${this.system}] Downloaded → ${destPath}`);

    return destPath;
  }

  /**
   * 지수 백오프 재시도 래퍼.
   * @param maxRetries 최대 재시도 횟수 (기본 3)
   * @param baseMs     초기 지연 ms (재시도마다 2배 증가: 1s → 2s → 4s)
   */
  protected async retry<T>(
    fn:        () => Promise<T>,
    maxRetries = 3,
    baseMs     = 1_000
  ): Promise<T> {
    let lastErr: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err as Error;
        logger.warn(`[${this.system}] Attempt ${attempt}/${maxRetries} failed: ${lastErr.message}`);

        if (attempt < maxRetries) {
          const delay = baseMs * 2 ** (attempt - 1);
          this.emit("retrying", `재시도 ${attempt}/${maxRetries} (${delay}ms 후)`, undefined, attempt);
          await this._sleep(delay);
        }
      }
    }
    throw lastErr;
  }

  // ── emit 헬퍼 ─────────────────────────────────────────────────────────────────

  protected emit(
    stage:   CrawlStage,
    message: string,
    percent?: number,
    attempt?: number
  ): void {
    const event: ProgressEvent = { jobId: this.jobId, system: this.system, stage, message, percent, attempt };
    logger.debug(`[${this.system}] ${stage}(${percent ?? "-"}%): ${message}`);
    this.progressCb?.(event);
  }

  // ── 결과 빌더 ─────────────────────────────────────────────────────────────────

  protected buildResult(files: string[]): CrawlerResult {
    const durationMs = Date.now() - this.startedAt;
    this.emit("completed", `완료 (${files.length}개 파일, ${durationMs}ms)`, 100);
    return { system: this.system, files, durationMs };
  }

  protected startTimer(): void {
    this.startedAt = Date.now();
    this.emit("init", "크롤러 시작", 0);
  }

  // ── static 팩토리 헬퍼 ────────────────────────────────────────────────────────

  static async createContext(
    browser: Browser,
    jobId:   string,
    system:  string
  ): Promise<CrawlerContext> {
    const uploadDir   = process.env.UPLOAD_DIR ?? "uploads";
    const downloadDir = path.resolve(uploadDir, jobId);
    fs.mkdirSync(downloadDir, { recursive: true });

    const context = await browser.newContext({
      acceptDownloads:   true,
      ignoreHTTPSErrors: true,
      viewport:          { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") logger.debug(`[${system}][console] ${msg.text()}`);
    });

    return { page, context, jobId, system, downloadDir };
  }

  // ── 내부 유틸 ─────────────────────────────────────────────────────────────────

  private async _setDateInput(selector: string, value: string): Promise<void> {
    try {
      // 방법 1: 직접 fill (일반 텍스트 입력)
      await this.page.fill(selector, value, { timeout: 3_000 });
    } catch {
      try {
        // 방법 2: 클릭 후 Ctrl+A → 입력 (읽기전용 date picker 우회)
        await this.page.click(selector, { timeout: 2_000 });
        await this.page.keyboard.press("Control+A");
        await this.page.keyboard.type(value);
        await this.page.keyboard.press("Tab");
      } catch {
        // 방법 3: JavaScript 직접 주입 (최후 수단)
        await this.page.evaluate(
          ({ sel, val }) => {
            const el = document.querySelector(sel) as HTMLInputElement | null;
            if (el) {
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, "value"
              )?.set;
              nativeInputValueSetter?.call(el, val);
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          },
          { sel: selector, val: value }
        );
      }
    }
  }

  private async _fillFirst(selectors: string[], value: string): Promise<void> {
    for (const sel of selectors) {
      try {
        await this.page.fill(sel, value, { timeout: 3_000 });
        return;
      } catch { /* 다음 셀렉터 시도 */ }
    }
    throw new Error(`입력 필드를 찾지 못했습니다: [${selectors.join(", ")}]`);
  }

  private async _clickFirst(selectors: string[]): Promise<void> {
    for (const sel of selectors) {
      try {
        await this.page.click(sel, { timeout: 3_000 });
        return;
      } catch { /* 다음 셀렉터 시도 */ }
    }
    throw new Error(`버튼을 찾지 못했습니다: [${selectors.join(", ")}]`);
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
