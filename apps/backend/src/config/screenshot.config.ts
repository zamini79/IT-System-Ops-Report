/**
 * 시스템별 스크린샷 캡처 대상 설정
 *
 * ─ 설계 원칙 ─────────────────────────────────────────────────────────────────
 *  • 이 파일이 "코드 기본값"의 단일 진실 공급원(Single Source of Truth)입니다.
 *  • 관리자 화면에서 변경한 값은 divisions.system_configs JSONB 에 저장됩니다.
 *  • 런타임에는 DB 값과 코드 기본값을 병합하여 사용합니다.
 *    → DB 에 없는 새 항목은 코드 기본값으로 자동 노출됩니다.
 *    → DB 에 있는 항목은 코드 기본값을 덮어씁니다.
 *
 * ─ TODO 작성 규칙 ─────────────────────────────────────────────────────────────
 *  urlPath  : 시스템 Base URL 에 붙는 상대 경로.  예) "/dashboard/docs"
 *  selector : 요소 캡처용 CSS 셀렉터.            예) "#doc-status-chart"
 *             null 이면 viewport 전체를 캡처합니다.
 *  waitForSelector : 캡처 직전 대기할 셀렉터 (데이터 로딩 완료 지표).
 *                    null 이면 networkidle 만 대기합니다.
 */

import type { DivisionCode } from "../engines/playwright/types";

// ── 타입 정의 ─────────────────────────────────────────────────────────────────

/** 단일 스크린샷 캡처 대상 */
export interface ScreenshotTargetConfig {
  /** CrawlerFactory 레지스트리 키 (EDMS, ELN, GCLP_LIMS 등) */
  systemName:        string;
  /** 관리 화면·보고서에 표시되는 이름 */
  label:             string;
  /** 시스템 Base URL 뒤에 붙는 상대 경로 */
  urlPath:           string;
  /** 캡처할 요소의 CSS 셀렉터. null → viewport 전체 */
  selector:          string | null;
  /** 로그인 세션 유지 후 캡처 (현재 항상 true) */
  captureAfterLogin: true;
  /** 캡처 전 이 셀렉터가 나타날 때까지 대기. null → networkidle 대기 */
  waitForSelector:   string | null;
  /** 이 캡처 대상의 목적·용도 설명 */
  description:       string;
}

/** 사업부 단위 스크린샷 설정 */
export interface DivisionScreenshotConfig {
  divisionCode: DivisionCode;
  targets:      ScreenshotTargetConfig[];
}

/**
 * DB(divisions.system_configs)에 저장되는 최상위 JSONB 구조.
 * screenshotTargets 키 아래에 ScreenshotTargetConfig[] 를 직렬화합니다.
 */
export interface DivisionSystemConfigs {
  /** 기존 시스템 접속 정보 (auth 등) */
  systems?: unknown[];
  /** 스크린샷 설정 (관리자 저장 후 코드 기본값 대체) */
  screenshotTargets?: ScreenshotTargetConfig[];
}

// ── 코드 기본값 ───────────────────────────────────────────────────────────────

/** BIO 사업부 캡처 대상 목록 */
const BIO_TARGETS: ScreenshotTargetConfig[] = [
  {
    systemName:        "EDMS",
    label:             "문서 현황 대시보드",
    urlPath:           "TODO: /dashboard/documents",
    selector:          "TODO: #doc-status-dashboard",
    captureAfterLogin: true,
    waitForSelector:   "TODO: .chart-container.loaded",
    description:       "월간 문서 등록·승인·폐기 현황을 한눈에 보여주는 메인 대시보드",
  },
  {
    systemName:        "ELN",
    label:             "실험 현황 차트",
    urlPath:           "TODO: /reports/experiment-summary",
    selector:          "TODO: #experiment-status-chart",
    captureAfterLogin: true,
    waitForSelector:   "TODO: canvas.chart-rendered",
    description:       "기간별 실험 건수·완료율·지연 현황 차트",
  },
  {
    systemName:        "GCLP_LIMS",
    label:             "샘플 처리 현황",
    urlPath:           "TODO: /lims/sample/status",
    selector:          "TODO: .sample-processing-board",
    captureAfterLogin: true,
    waitForSelector:   "TODO: table.sample-grid tbody tr",
    description:       "당월 샘플 접수·분석 완료·반려 현황 현황판",
  },
];

/** DEV 개발본부 캡처 대상 목록 */
const DEV_TARGETS: ScreenshotTargetConfig[] = [
  {
    systemName:        "EQMS",
    label:             "CAPA 현황",
    urlPath:           "TODO: /eqms/capa/dashboard",
    selector:          "TODO: #capa-status-panel",
    captureAfterLogin: true,
    waitForSelector:   "TODO: .capa-chart.ready",
    description:       "시정 조치(CAPA) 등록·진행·완료 건수 요약 패널",
  },
  {
    systemName:        "CTMS",
    label:             "임상 진행 현황",
    urlPath:           "TODO: /ctms/trials/overview",
    selector:          "TODO: .trial-progress-dashboard",
    captureAfterLogin: true,
    waitForSelector:   "TODO: .trial-table.loaded",
    description:       "임상시험 단계별 진행 현황 및 일정 준수율 대시보드",
  },
  {
    systemName:        "MEDCOMMS",
    label:             "발행 현황 대시보드",
    urlPath:           "TODO: /medcomms/analytics/dashboard",
    selector:          "TODO: #publication-overview",
    captureAfterLogin: true,
    waitForSelector:   "TODO: .analytics-chart",
    description:       "의학정보 자료 발행 건수·채널별 현황 대시보드",
  },
];

/** L HOUSE 사업부 캡처 대상 목록 */
const LHOUSE_TARGETS: ScreenshotTargetConfig[] = [
  {
    systemName:        "EQMS",
    label:             "품질 지표",
    urlPath:           "TODO: /eqms/quality/kpi",
    selector:          "TODO: .quality-kpi-section",
    captureAfterLogin: true,
    waitForSelector:   "TODO: .kpi-card:last-child",
    description:       "월간 품질 핵심지표(KPI) 달성률 현황",
  },
  {
    systemName:        "EDMS",
    label:             "문서 현황",
    urlPath:           "TODO: /edms/statistics/monthly",
    selector:          "TODO: #monthly-doc-stats",
    captureAfterLogin: true,
    waitForSelector:   "TODO: .statistics-table.loaded",
    description:       "월간 문서 등록·개정·폐기 통계 요약 화면",
  },
];

/**
 * 사업부별 기본 스크린샷 설정 레지스트리.
 * 새 캡처 대상 추가 시 이 객체에만 항목을 추가하세요.
 */
export const DEFAULT_SCREENSHOT_CONFIGS: Record<DivisionCode, DivisionScreenshotConfig> = {
  BIO: {
    divisionCode: "BIO",
    targets:      BIO_TARGETS,
  },
  DEV: {
    divisionCode: "DEV",
    targets:      DEV_TARGETS,
  },
  LHOUSE: {
    divisionCode: "LHOUSE",
    targets:      LHOUSE_TARGETS,
  },
};

// ── DB 직렬화 / 역직렬화 ─────────────────────────────────────────────────────

/**
 * DB 에 저장된 screenshotTargets 와 코드 기본값을 병합합니다.
 *
 * 병합 규칙:
 *  1. 코드 기본값의 순서·항목을 기준으로 삼습니다.
 *  2. DB 에 같은 systemName 의 항목이 있으면 해당 필드를 덮어씁니다.
 *  3. DB 에만 있는 항목(코드에서 제거된 시스템)은 무시합니다.
 *  4. 코드에만 있는 항목(새로 추가된 시스템)은 기본값 그대로 포함됩니다.
 *
 * @param divisionCode  사업부 코드
 * @param dbTargets     DB 에서 읽어온 screenshotTargets (없으면 undefined)
 */
export function mergeWithDefaults(
  divisionCode: DivisionCode,
  dbTargets?: ScreenshotTargetConfig[]
): ScreenshotTargetConfig[] {
  const defaults = DEFAULT_SCREENSHOT_CONFIGS[divisionCode].targets;

  if (!dbTargets?.length) return defaults;

  const dbMap = new Map(dbTargets.map((t) => [t.systemName, t]));

  return defaults.map((def) => {
    const override = dbMap.get(def.systemName);
    return override ? { ...def, ...override } : def;
  });
}

/**
 * ScreenshotTargetConfig[] 를 DB 저장용 형식으로 직렬화합니다.
 * JSONB 에 그대로 넣을 수 있는 순수 객체 배열을 반환합니다.
 */
export function serializeTargets(
  targets: ScreenshotTargetConfig[]
): ScreenshotTargetConfig[] {
  return targets.map((t) => ({ ...t }));
}

/**
 * DB JSONB 에서 역직렬화합니다.
 * 알 수 없는 필드는 무시하고, 누락 필드는 기본값으로 보완합니다.
 *
 * @param raw         DB 에서 읽어온 unknown 객체
 * @param divisionCode 역직렬화 기준 사업부 코드
 */
export function deserializeTargets(
  raw: unknown,
  divisionCode: DivisionCode
): ScreenshotTargetConfig[] {
  if (!Array.isArray(raw)) return DEFAULT_SCREENSHOT_CONFIGS[divisionCode].targets;

  const defaults = DEFAULT_SCREENSHOT_CONFIGS[divisionCode].targets;
  const defMap   = new Map(defaults.map((d) => [d.systemName, d]));

  const parsed: ScreenshotTargetConfig[] = raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const base = defMap.get(item.systemName as string) ?? ({} as Partial<ScreenshotTargetConfig>);
      return {
        systemName:        String(item.systemName        ?? base.systemName        ?? ""),
        label:             String(item.label             ?? base.label             ?? ""),
        urlPath:           String(item.urlPath           ?? base.urlPath           ?? ""),
        selector:          item.selector != null ? String(item.selector)           : (base.selector ?? null),
        captureAfterLogin: true,
        waitForSelector:   item.waitForSelector != null
                             ? String(item.waitForSelector)
                             : (base.waitForSelector ?? null),
        description:       String(item.description      ?? base.description       ?? ""),
      } satisfies ScreenshotTargetConfig;
    });

  return mergeWithDefaults(divisionCode, parsed);
}

/**
 * 사업부 코드와 DB JSON 으로부터 완전한 설정을 반환하는 편의 함수.
 *
 * 사용 예)
 *   const configs = getScreenshotConfig("BIO", dbRow.system_configs);
 */
export function getScreenshotConfig(
  divisionCode: DivisionCode,
  dbSystemConfigs?: DivisionSystemConfigs | null
): DivisionScreenshotConfig {
  const dbTargets = dbSystemConfigs?.screenshotTargets;
  return {
    divisionCode,
    targets: deserializeTargets(dbTargets, divisionCode),
  };
}
