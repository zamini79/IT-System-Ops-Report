import type { Page, BrowserContext } from "playwright";

// ── 공유 타입 ──────────────────────────────────────────────────────────────────

export type DivisionCode = "BIO" | "DEV" | "LHOUSE";

export type CrawlStage =
  | "init"
  | "login"
  | "navigating"
  | "downloading"
  | "completed"
  | "error"
  | "retrying";

export interface ProgressEvent {
  jobId:    string;
  system:   string;
  stage:    CrawlStage;
  message:  string;
  percent?: number;   // 0–100
  attempt?: number;   // retry 이벤트 전용
  error?:   string;   // error 이벤트 전용
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface CrawlerContext {
  page:        Page;
  context:     BrowserContext;
  jobId:       string;
  system:      string;
  downloadDir: string;           // UPLOAD_DIR/{jobId}/
}

export interface CrawlerResult {
  system:    string;
  files:     string[];           // 저장된 파일 절대 경로 목록
  durationMs: number;
}

export interface LoginCredentials {
  url:      string;
  username: string;
  password: string;
}

// ── 스크린샷 ───────────────────────────────────────────────────────────────────

export interface ScreenshotOptions {
  /** 캡처할 페이지 URL (로그인 세션 유지) */
  url:        string;
  /** 특정 요소만 캡처할 CSS 셀렉터 (없으면 viewport 전체) */
  selector?:  string;
  /** true 면 스크롤을 포함한 전체 페이지 캡처 (selector 없을 때만 유효) */
  fullPage?:  boolean;
  /** 뷰포트 너비 px — 기본 1280 */
  width?:     number;
  /** 뷰포트 높이 px — 기본 720 */
  height?:    number;
  /** PNG 저장 경로 (절대경로) */
  outputPath: string;
}

export interface ScreenshotResult {
  path:       string;   // 저장된 파일 절대경로
  width:      number;   // 실제 캡처 너비 px
  height:     number;   // 실제 캡처 높이 px
  capturedAt: string;   // ISO 8601
}
