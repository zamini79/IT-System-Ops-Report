import { BrowserManager }         from "./BrowserManager";
import { BaseCrawler }             from "./BaseCrawler";
import type {
  DivisionCode,
  ProgressCallback,
  CrawlerResult,
  ScreenshotOptions,
  ScreenshotResult,
} from "./types";
import { SELECTORS, loadCreds, getCredsPrefix } from "./config/selectors";
import { logger }                  from "../../utils/logger";

// ── BIO 크롤러 ────────────────────────────────────────────────────────────────
import { BioEdmsCrawler }          from "./crawlers/bio/BioEdmsCrawler";
import { BioElnCrawler }           from "./crawlers/bio/BioElnCrawler";
import { BioGclpLimsCrawler }      from "./crawlers/bio/BioGclpLimsCrawler";
import { BioErpCrawler }           from "./crawlers/bio/BioErpCrawler";
import { BioMesCrawler }           from "./crawlers/bio/BioMesCrawler";

// ── DEV 크롤러 ────────────────────────────────────────────────────────────────
import { DevEqmsCrawler }          from "./crawlers/dev/DevEqmsCrawler";
import { DevEdmsCrawler }          from "./crawlers/dev/DevEdmsCrawler";
import { DevElmsCrawler }          from "./crawlers/dev/DevElmsCrawler";
import { DevCtmsCrawler }          from "./crawlers/dev/DevCtmsCrawler";
import { DevEtmfCrawler }          from "./crawlers/dev/DevEtmfCrawler";
import { DevMedcommsCrawler }      from "./crawlers/dev/DevMedcommsCrawler";
import { DevGitlabCrawler }        from "./crawlers/dev/DevGitlabCrawler";
import { DevJiraCrawler }          from "./crawlers/dev/DevJiraCrawler";

// ── LHOUSE 크롤러 ─────────────────────────────────────────────────────────────
import { LhouseVeevaCrawler }           from "./crawlers/lhouse/LhouseVeevaCrawler";
import { LhouseVeevaDashboardCrawler }  from "./crawlers/lhouse/LhouseVeevaDashboardCrawler";

// ── 크롤러 레지스트리 ─────────────────────────────────────────────────────────
// 새 크롤러 추가 시 이 맵에만 등록하면 됩니다.
type CrawlerCtor = new (ctx: ConstructorParameters<typeof BaseCrawler>[0]) => BaseCrawler;

const REGISTRY: Record<DivisionCode, Record<string, CrawlerCtor>> = {
  BIO: {
    EDMS:      BioEdmsCrawler,
    ELN:       BioElnCrawler,
    GCLP_LIMS: BioGclpLimsCrawler,
    ERP:       BioErpCrawler,
    MES:       BioMesCrawler,
  },
  DEV: {
    EQMS:     DevEqmsCrawler,
    EDMS:     DevEdmsCrawler,
    ELMS:     DevElmsCrawler,
    CTMS:     DevCtmsCrawler,
    ETMF:     DevEtmfCrawler,
    MEDCOMMS: DevMedcommsCrawler,
    GitLab:   DevGitlabCrawler,
    Jira:     DevJiraCrawler,
  },
  LHOUSE: {
    VEEVA: LhouseVeevaCrawler,   // Veeva Vault (eQMS · eDMS · eLMS 통합)
  },
};

// 전체 크롤 대상에는 포함되지 않는 단일 실행 전용 크롤러
const SINGLE_REGISTRY: Record<string, CrawlerCtor> = {
  VEEVA_DASHBOARD: LhouseVeevaDashboardCrawler,
};

// ── 팩토리 ───────────────────────────────────────────────────────────────────

export class CrawlerFactory {
  /**
   * divisionCode + systemName 조합으로 크롤러를 인스턴스화하고 실행합니다.
   *
   * BrowserManager 풀에서 브라우저를 획득하고, 완료 시 자동 반환합니다.
   *
   * @param divisionCode  사업부 코드 ('BIO' | 'DEV' | 'LHOUSE')
   * @param systemName    시스템 이름 (레지스트리 키와 일치해야 함)
   * @param jobId         report_jobs.id (다운로드 폴더 구분자)
   * @param onProgress    진행 상태 콜백 (선택)
   * @returns             CrawlerResult (저장 파일 목록 + 소요 시간)
   */
  static async run(
    divisionCode: DivisionCode,
    systemName:   string,
    jobId:        string,
    onProgress?:  ProgressCallback
  ): Promise<CrawlerResult> {
    // ── 레지스트리 조회 ─────────────────────────────────────────────────────
    const divisionMap = REGISTRY[divisionCode];
    if (!divisionMap) {
      throw new Error(`알 수 없는 사업부 코드: ${divisionCode}`);
    }

    const CrawlerClass = divisionMap[systemName];
    if (!CrawlerClass) {
      const available = Object.keys(divisionMap).join(", ");
      throw new Error(
        `[${divisionCode}] 알 수 없는 시스템: '${systemName}'. 사용 가능: ${available}`
      );
    }

    // ── 브라우저 획득 ───────────────────────────────────────────────────────
    const manager = BrowserManager.getInstance();
    const { browser, release } = await manager.acquire();

    logger.info(`[CrawlerFactory] Starting ${divisionCode}/${systemName} (job=${jobId})`);

    // ── 컨텍스트 + 크롤러 생성 ─────────────────────────────────────────────
    const ctx = await BaseCrawler.createContext(browser, jobId, systemName);
    const crawler = new CrawlerClass(ctx);

    if (onProgress) {
      crawler.onProgress(onProgress);
    }

    // ── 실행 ────────────────────────────────────────────────────────────────
    try {
      const result = await crawler.run();
      logger.info(
        `[CrawlerFactory] Completed ${divisionCode}/${systemName} ` +
        `(${result.files.length} files, ${result.durationMs}ms)`
      );
      return result;
    } catch (err) {
      logger.error(`[CrawlerFactory] Failed ${divisionCode}/${systemName}`, {
        error: (err as Error).message,
      });
      throw err;
    } finally {
      await crawler.close();
      release(); // 반드시 브라우저 반환
    }
  }

  /**
   * 로그인 후 스크린샷 캡처.
   *
   * ─ 인증 로직 ─────────────────────────────────────────────────────────────────
   *  SELECTORS 레지스트리에 등록된 시스템 → 해당 로그인 셀렉터 사용
   *  미등록 시스템 (ERP, MES, PMS 등) → BaseCrawler 기본 셀렉터 폴백
   *
   * @param divisionCode   사업부 코드
   * @param systemName     시스템 이름 (REGISTRY 키)
   * @param jobId          저장 디렉토리 구분자 (UPLOAD_DIR/{jobId}/)
   * @param options        url·selector·fullPage·width·height·outputPath
   * @param onProgress     진행 상태 콜백 (선택)
   */
  static async screenshot(
    divisionCode: DivisionCode,
    systemName:   string,
    jobId:        string,
    options:      ScreenshotOptions,
    onProgress?:  ProgressCallback
  ): Promise<ScreenshotResult> {
    // ── 레지스트리 조회 ─────────────────────────────────────────────────────
    const divisionMap = REGISTRY[divisionCode];
    if (!divisionMap) throw new Error(`알 수 없는 사업부 코드: ${divisionCode}`);

    const CrawlerClass = divisionMap[systemName];
    if (!CrawlerClass) {
      const available = Object.keys(divisionMap).join(", ");
      throw new Error(
        `[${divisionCode}] 알 수 없는 시스템: '${systemName}'. 사용 가능: ${available}`
      );
    }

    // ── 로그인 파라미터 구성 ────────────────────────────────────────────────
    // SELECTORS 에 등록된 시스템은 시스템 전용 셀렉터 사용
    const selectorKey = `${divisionCode}/${systemName}`;
    const sel         = SELECTORS[selectorKey];
    const envPrefix   = getCredsPrefix(divisionCode, systemName);
    const creds       = loadCreds(envPrefix);

    const loginParams = {
      url:              creds.url,
      username:         creds.user,
      password:         creds.pass,
      usernameSelector: sel?.login.usernameInput,
      passwordSelector: sel?.login.passwordInput,
      submitSelector:   sel?.login.submitButton,
      successSelector:  sel?.login.successIndicator,
    };

    // ── 브라우저 획득 ───────────────────────────────────────────────────────
    const manager = BrowserManager.getInstance();
    const { browser, release } = await manager.acquire();

    logger.info(
      `[CrawlerFactory] Screenshot: ${divisionCode}/${systemName} → ${options.outputPath}`
    );

    const ctx     = await BaseCrawler.createContext(browser, jobId, systemName);
    const crawler = new CrawlerClass(ctx);

    if (onProgress) crawler.onProgress(onProgress);

    try {
      const result = await crawler.runScreenshot(options, loginParams);
      logger.info(
        `[CrawlerFactory] Screenshot done: ${result.path} ` +
        `(${result.width}×${result.height})`
      );
      return result;
    } catch (err) {
      logger.error(`[CrawlerFactory] Screenshot failed: ${divisionCode}/${systemName}`, {
        error: (err as Error).message,
      });
      throw err;
    } finally {
      await crawler.close();
      release();
    }
  }

  /**
   * SINGLE_REGISTRY 에 등록된 단일 크롤러를 실행합니다.
   * 전체 사업부 크롤 잡(listAvailable)과 독립적으로 동작합니다.
   *
   * @param systemName  SINGLE_REGISTRY 키 (예: "VEEVA_DASHBOARD")
   * @param jobId       저장 디렉토리 구분자
   * @param onProgress  진행 상태 콜백
   */
  static async runSingle(
    systemName:  string,
    jobId:       string,
    onProgress?: ProgressCallback,
  ): Promise<CrawlerResult> {
    const CrawlerClass = SINGLE_REGISTRY[systemName];
    if (!CrawlerClass) {
      const available = Object.keys(SINGLE_REGISTRY).join(", ");
      throw new Error(`단일 크롤러 미등록: '${systemName}'. 사용 가능: ${available}`);
    }

    const manager = BrowserManager.getInstance();
    const { browser, release } = await manager.acquire();

    logger.info(`[CrawlerFactory] RunSingle: ${systemName} (job=${jobId})`);

    const ctx     = await BaseCrawler.createContext(browser, jobId, systemName);
    const crawler = new CrawlerClass(ctx);

    if (onProgress) crawler.onProgress(onProgress);

    try {
      const result = await crawler.run();
      logger.info(`[CrawlerFactory] RunSingle done: ${systemName} (${result.files.length} files, ${result.durationMs}ms)`);
      return result;
    } catch (err) {
      logger.error(`[CrawlerFactory] RunSingle failed: ${systemName}`, { error: (err as Error).message });
      throw err;
    } finally {
      await crawler.close();
      release();
    }
  }

  /** 등록된 전체 크롤러 목록 반환 (관리 API용) */
  static listAvailable(): Record<DivisionCode, string[]> {
    return Object.fromEntries(
      Object.entries(REGISTRY).map(([div, systems]) => [div, Object.keys(systems)])
    ) as Record<DivisionCode, string[]>;
  }
}
