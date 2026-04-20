/**
 * 시스템별 CSS 셀렉터 설정
 *
 * ─ 사용 방법 ─────────────────────────────────────────────────────────────────
 * 1. TODO 주석 위치의 셀렉터를 실제 값으로 교체합니다.
 * 2. 각 크롤러는 SELECTORS['KEY']로 주입받아 사용합니다.
 * 3. 동일 제품의 다른 사업부 인스턴스도 UI가 동일하면 셀렉터를 공유할 수 있습니다.
 *
 * ─ 셀렉터 찾는 법 ───────────────────────────────────────────────────────────
 * 브라우저 DevTools → Elements 탭 → 우클릭 → "Copy selector" 사용
 * ID가 있으면 `#id` 를, 없으면 `[data-testid="..."]` 나 역할 기반 선택 권장
 */

// ── 타입 ───────────────────────────────────────────────────────────────────────

export interface LoginSelectors {
  usernameInput:     string;    // 아이디 입력 필드
  passwordInput:     string;    // 비밀번호 입력 필드
  submitButton:      string;    // 로그인 버튼
  successIndicator?: string;    // 로그인 성공 후 대기할 요소 (없으면 navigation 대기)
}

export interface ReportSelectors {
  /** 보고서 메뉴로 이동하기 위해 순서대로 클릭할 셀렉터 목록 */
  menuPath?:         string[];
  /** 직접 이동할 URL 경로 (baseUrl 뒤에 붙임). menuPath 보다 우선 */
  reportPath?:       string;
  /** 시작일 입력 필드 */
  dateFromInput:     string;
  /** 종료일 입력 필드 */
  dateToInput:       string;
  /** 날짜 포맷 — formatDate() 에 전달 (기본 YYYY-MM-DD) */
  dateFormat:        string;
  /** 날짜 적용 후 검색/조회 트리거 버튼 */
  applyButton?:      string;
  /** 데이터 로딩 완료 대기 셀렉터 (없으면 networkidle 대기) */
  tableReady?:       string;
  /** 다운로드 버튼 */
  downloadButton:    string;
  /** 다운로드 확인 팝업의 확인 버튼 (없으면 스킵) */
  confirmButton?:    string;
  /** 다운로드 파일 확장자 */
  fileExt:           string;
}

export interface SystemSelectors {
  login:  LoginSelectors;
  report: ReportSelectors;
}

// ── 시스템별 셀렉터 레지스트리 ────────────────────────────────────────────────

export const SELECTORS: Record<string, SystemSelectors> = {

  // ===========================================================================
  // BIO 연구본부
  // ===========================================================================

  "BIO/EDMS": {
    login: {
      usernameInput:    "TODO: #userId",                  // TODO: 실제 셀렉터 교체
      passwordInput:    "TODO: #userPw",
      submitButton:     "TODO: button[type='submit']",
      successIndicator: "TODO: .main-dashboard",
    },
    report: {
      reportPath:    "/report/doc-status",               // TODO: 실제 경로 교체
      dateFromInput: "TODO: #searchStartDt",
      dateToInput:   "TODO: #searchEndDt",
      dateFormat:    "YYYY-MM-DD",
      applyButton:   "TODO: #btnSearch",
      tableReady:    "TODO: table.result-table tbody tr",
      downloadButton:"TODO: #btnExcelDown",
      confirmButton: "TODO: .modal-confirm-btn",
      fileExt:       "xlsx",
    },
  },

  "BIO/ELN": {
    login: {
      usernameInput:    "TODO: input[name='username']",
      passwordInput:    "TODO: input[name='password']",
      submitButton:     "TODO: .login-submit",
      successIndicator: "TODO: .eln-workspace",
    },
    report: {
      menuPath:      ["TODO: #menu-reports", "TODO: #menu-summary"],
      dateFromInput: "TODO: input.date-from",
      dateToInput:   "TODO: input.date-to",
      dateFormat:    "YYYY-MM-DD",
      applyButton:   "TODO: button.apply-filter",
      tableReady:    "TODO: .report-loaded",
      downloadButton:"TODO: button.export-excel",
      fileExt:       "xlsx",
    },
  },

  "BIO/GCLP_LIMS": {
    login: {
      usernameInput:    "TODO: #login-id",
      passwordInput:    "TODO: #login-pw",
      submitButton:     "TODO: #login-btn",
      successIndicator: "TODO: .lims-main",
    },
    report: {
      reportPath:    "/lims/report/monthly",
      dateFromInput: "TODO: #fromDate",
      dateToInput:   "TODO: #toDate",
      dateFormat:    "YYYYMMDD",                         // TODO: 시스템 날짜 포맷 확인
      applyButton:   "TODO: #searchBtn",
      tableReady:    "TODO: #resultGrid",
      downloadButton:"TODO: #excelDown",
      fileExt:       "xlsx",
    },
  },

  // ===========================================================================
  // 개발본부 (DEV)
  // ===========================================================================

  "DEV/EQMS": {
    login: {
      usernameInput:    "TODO: #user_id",
      passwordInput:    "TODO: #user_pw",
      submitButton:     "TODO: #loginBtn",
      successIndicator: "TODO: #main-content",
    },
    report: {
      reportPath:    "/eqms/report/equipment",
      dateFromInput: "TODO: #srchFromDt",
      dateToInput:   "TODO: #srchToDt",
      dateFormat:    "YYYY-MM-DD",
      applyButton:   "TODO: #srchBtn",
      tableReady:    "TODO: .data-grid tbody tr:first-child",
      downloadButton:"TODO: #excelDownload",
      confirmButton: "TODO: .confirm-ok",
      fileExt:       "xlsx",
    },
  },

  "DEV/EDMS": {
    login: {
      usernameInput:    "TODO: #userId",
      passwordInput:    "TODO: #userPw",
      submitButton:     "TODO: button[type='submit']",
      successIndicator: "TODO: .portal-main",
    },
    report: {
      reportPath:    "/edms/report/document-status",
      dateFromInput: "TODO: #searchFromDate",
      dateToInput:   "TODO: #searchToDate",
      dateFormat:    "YYYY-MM-DD",
      applyButton:   "TODO: #searchButton",
      tableReady:    "TODO: #listArea tr.data-row",
      downloadButton:"TODO: #excelBtn",
      fileExt:       "xlsx",
    },
  },

  "DEV/ELMS": {
    login: {
      usernameInput:    "TODO: input[placeholder='ID']",
      passwordInput:    "TODO: input[placeholder='Password']",
      submitButton:     "TODO: .btn-login",
      successIndicator: "TODO: nav.sidebar",
    },
    report: {
      menuPath:      ["TODO: a[href*='report']", "TODO: a[href*='monthly']"],
      dateFromInput: "TODO: .from-date input",
      dateToInput:   "TODO: .to-date input",
      dateFormat:    "YYYY-MM-DD",
      applyButton:   "TODO: .search-btn",
      tableReady:    "TODO: .table-container.loaded",
      downloadButton:"TODO: .download-excel",
      fileExt:       "xlsx",
    },
  },

  "DEV/CTMS": {
    login: {
      usernameInput:    "TODO: #username",
      passwordInput:    "TODO: #password",
      submitButton:     "TODO: .btn-primary[type='submit']",
      successIndicator: "TODO: .dashboard-header",
    },
    report: {
      reportPath:    "/ctms/reports/trial-status",
      dateFromInput: "TODO: #reportStartDate",
      dateToInput:   "TODO: #reportEndDate",
      dateFormat:    "YYYY-MM-DD",
      applyButton:   "TODO: #generateReport",
      tableReady:    "TODO: #reportContent.ready",
      downloadButton:"TODO: #downloadExcel",
      confirmButton: "TODO: #downloadConfirm",
      fileExt:       "xlsx",
    },
  },

  "DEV/ETMF": {
    login: {
      usernameInput:    "TODO: input[name='userId']",
      passwordInput:    "TODO: input[name='password']",
      submitButton:     "TODO: button.sign-in-btn",
      successIndicator: "TODO: .vault-home",
    },
    report: {
      reportPath:    "/etmf/reports",
      dateFromInput: "TODO: [data-field='startDate'] input",
      dateToInput:   "TODO: [data-field='endDate'] input",
      dateFormat:    "MM/DD/YYYY",                       // TODO: 영문 시스템 날짜 포맷 확인
      applyButton:   "TODO: button.run-report",
      tableReady:    "TODO: .report-results-container",
      downloadButton:"TODO: button.export-btn",
      fileExt:       "xlsx",
    },
  },

  "DEV/MEDCOMMS": {
    login: {
      usernameInput:    "TODO: #email",
      passwordInput:    "TODO: #pass",
      submitButton:     "TODO: [data-action='login']",
      successIndicator: "TODO: .medcomms-dashboard",
    },
    report: {
      reportPath:    "/medcomms/analytics/period",
      dateFromInput: "TODO: .period-from",
      dateToInput:   "TODO: .period-to",
      dateFormat:    "YYYY-MM-DD",
      applyButton:   "TODO: .apply-period",
      tableReady:    "TODO: .analytics-table",
      downloadButton:"TODO: .export-csv",
      fileExt:       "csv",                              // 일부 시스템은 CSV
    },
  },

  // ===========================================================================
  // L HOUSE
  // ===========================================================================

  // Veeva Vault — eQMS · eDMS · eLMS 통합 (https://login.veevavault.com)
  "LHOUSE/VEEVA": {
    login: {
      usernameInput:    "#username",
      passwordInput:    "#password",
      submitButton:     "#loginButton",
      successIndicator: ".header-logo, .vault-header, nav.primary-nav",
    },
    report: {
      // 다운로드 경로는 크롤러 내부에서 직접 구현 (Vault API / UI 흐름)
      dateFromInput:  "",
      dateToInput:    "",
      dateFormat:     "YYYY-MM-DD",
      downloadButton: "",
      fileExt:        "xlsx",
    },
  },

};

/** 셀렉터 맵 키 헬퍼 */
export function getSelectorKey(division: string, system: string): string {
  return `${division}/${system}`;
}

/**
 * 환경변수 접두어 계산.
 * 예: ("BIO", "GCLP_LIMS") → "BIO_GCLP_LIMS"
 *     ("DEV", "GitLab")    → "DEV_GITLAB"
 */
export function getCredsPrefix(division: string, system: string): string {
  return `${division}_${system.toUpperCase()}`;
}

/** 환경변수에서 시스템 자격증명을 로드합니다. */
export function loadCreds(envPrefix: string): {
  url:  string;
  user: string;
  pass: string;
} {
  const url  = process.env[`${envPrefix}_URL`]  ?? "";
  const user = process.env[`${envPrefix}_USER`] ?? "";
  const pass = process.env[`${envPrefix}_PASS`] ?? "";

  if (!url) {
    throw new Error(
      `환경변수 ${envPrefix}_URL 이 설정되지 않았습니다. .env 파일을 확인하세요.`
    );
  }
  return { url, user, pass };
}
