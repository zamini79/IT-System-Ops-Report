import { chromium, Browser } from "playwright";
import { logger } from "../../utils/logger";

/**
 * Chromium 인스턴스 풀 (싱글턴).
 *
 * - 최대 동시 브라우저 수: BROWSER_POOL_SIZE (기본 3)
 * - 브라우저는 lazy 생성 후 풀에 반환해 재사용
 * - 용량 초과 시 acquire() 가 해제될 때까지 Promise 큐에서 대기
 */
export class BrowserManager {
  private static instance: BrowserManager;

  private readonly maxSize: number;
  private pool: Browser[]      = [];   // 유휴 브라우저
  private busyCount            = 0;
  private waitQueue: Array<() => void> = [];

  private constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  // ── 싱글턴 접근 ─────────────────────────────────────────────────────────────
  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      const size = Number(process.env.BROWSER_POOL_SIZE ?? 3);
      BrowserManager.instance = new BrowserManager(size);
      logger.info(`[BrowserManager] Pool initialised (maxSize=${size})`);
    }
    return BrowserManager.instance;
  }

  // ── 브라우저 획득 ────────────────────────────────────────────────────────────
  /**
   * 풀에서 브라우저를 빌려옵니다.
   * 풀이 가득 차면 다른 작업이 release() 할 때까지 대기합니다.
   *
   * @returns browser  — Playwright Browser 인스턴스
   * @returns release  — 작업 완료 후 반드시 호출해야 하는 반환 함수
   */
  async acquire(): Promise<{ browser: Browser; release: () => void }> {
    if (this.busyCount >= this.maxSize) {
      logger.debug(`[BrowserManager] Pool full (${this.busyCount}/${this.maxSize}), queuing…`);
      await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    }

    this.busyCount++;

    // 유휴 브라우저 재사용, 없거나 끊어졌으면 새로 기동
    let browser = this.pool.pop();
    if (!browser || !browser.isConnected()) {
      logger.debug("[BrowserManager] Launching new Chromium instance");
      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });
    }

    logger.debug(`[BrowserManager] Browser acquired (busy=${this.busyCount}/${this.maxSize})`);

    const captured = browser;
    const release = () => this._release(captured);
    return { browser: captured, release };
  }

  // ── 브라우저 반환 ────────────────────────────────────────────────────────────
  private _release(browser: Browser): void {
    if (browser.isConnected()) {
      this.pool.push(browser);   // 재사용 가능 → 풀로 복귀
    }
    this.busyCount--;

    logger.debug(`[BrowserManager] Browser released (busy=${this.busyCount}/${this.maxSize})`);

    // 대기 중인 요청 깨우기
    const next = this.waitQueue.shift();
    if (next) next();
  }

  // ── 전체 종료 ────────────────────────────────────────────────────────────────
  async shutdown(): Promise<void> {
    logger.info("[BrowserManager] Shutting down all browser instances…");
    await Promise.all([...this.pool].map((b) => b.close().catch(() => {})));
    this.pool      = [];
    this.busyCount = 0;
    logger.info("[BrowserManager] Shutdown complete");
  }

  // ── 상태 조회 ────────────────────────────────────────────────────────────────
  get status() {
    return {
      idle:    this.pool.length,
      busy:    this.busyCount,
      queued:  this.waitQueue.length,
      maxSize: this.maxSize,
    };
  }
}
