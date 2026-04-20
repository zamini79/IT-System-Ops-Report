/**
 * SSE 이벤트 버스 — 잡(job) 단위 pub/sub + 재연결 replay 버퍼
 *
 * ─ 설계 원칙 ─────────────────────────────────────────────────────────────────
 *  • SSE 연결이 끊겨도 크롤 작업은 계속 실행됩니다.
 *  • 재연결 시 재연결 시점까지 누락된 이벤트를 히스토리에서 한꺼번에 전송합니다.
 *  • all_done 이후 HISTORY_TTL_MS(기본 30분) 뒤 자원을 자동 정리합니다.
 */

import { EventEmitter } from "events";

// ── SSE 이벤트 페이로드 타입 ──────────────────────────────────────────────────

export type SseEventType =
  | "task_start"        // 크롤 태스크 시작
  | "progress"          // 크롤 진행률
  | "task_retry"        // 크롤 태스크 재시도
  | "task_done"         // 크롤 태스크 성공 완료
  | "task_error"        // 크롤 태스크 실패
  | "all_done"          // 전체 크롤 완료
  | "screenshot_done"   // 스크린샷 완료
  | "screenshot_error"  // 스크린샷 실패
  | "report_generating" // PDF 생성 시작
  | "report_done"       // PDF 생성 완료
  | "report_error"      // PDF 생성 실패

export interface SsePayload {
  type:        SseEventType;
  systemName?: string;          // task_start · progress · task_done · task_error · screenshot_*
  total?:      number;          // task_start: 전체 태스크 수
  percent?:    number;          // progress: 0–100
  message?:    string;          // progress: 사람이 읽을 수 있는 단계 설명
  filePaths?:  string[];        // task_done: 저장된 파일 경로 목록
  error?:      string;          // task_error · screenshot_error · report_error
  jobId?:      string;          // all_done · report_done
  attempt?:    number;          // task_retry: 현재 재시도 횟수
  maxRetries?: number;          // task_retry: 최대 재시도 횟수
  // screenshot_done 전용
  screenshotPath?:   string;
  screenshotWidth?:  number;
  screenshotHeight?: number;
  capturedAt?:       string;    // ISO 8601
  // report_done 전용
  pdfPath?:    string;
  pageCount?:  number;
  fileSize?:   number;          // bytes
}

// ── JobEventBus ───────────────────────────────────────────────────────────────

const HISTORY_TTL_MS = 30 * 60 * 1_000; // 30분

class JobEventBus {
  private static instance: JobEventBus;

  /** jobId → EventEmitter (진행 중 구독자 대상 실시간 이벤트) */
  private emitters = new Map<string, EventEmitter>();
  /** jobId → 이벤트 배열 (재연결 시 replay용) */
  private histories = new Map<string, SsePayload[]>();
  /** jobId → 정리 타이머 */
  private timers = new Map<string, NodeJS.Timeout>();

  static getInstance(): JobEventBus {
    if (!JobEventBus.instance) JobEventBus.instance = new JobEventBus();
    return JobEventBus.instance;
  }

  /**
   * 이벤트 발행 — 구독자에게 즉시 전달 + 히스토리에 저장
   */
  emit(jobId: string, payload: SsePayload): void {
    if (!this.histories.has(jobId)) this.histories.set(jobId, []);
    this.histories.get(jobId)!.push(payload);
    this.emitters.get(jobId)?.emit("sse", payload);
  }

  /**
   * SSE 구독 등록.
   * 반환된 unsubscribe 함수를 클라이언트 disconnect 시 호출하세요.
   */
  subscribe(jobId: string, cb: (p: SsePayload) => void): () => void {
    if (!this.emitters.has(jobId)) {
      const ee = new EventEmitter();
      ee.setMaxListeners(100); // 동시 SSE 연결 수 허용
      this.emitters.set(jobId, ee);
    }
    this.emitters.get(jobId)!.on("sse", cb);
    return () => this.emitters.get(jobId)?.off("sse", cb);
  }

  /**
   * 히스토리 전체 반환 — 재연결 클라이언트가 Last-Event-ID 없이 재접속 시 사용.
   * lastIndex 를 넘기면 그 이후 이벤트만 반환합니다 (향후 확장용).
   */
  replay(jobId: string, fromIndex = 0): SsePayload[] {
    return (this.histories.get(jobId) ?? []).slice(fromIndex);
  }

  /** jobId의 히스토리가 존재하는지 확인 (작업이 시작됐는지 체크) */
  hasJob(jobId: string): boolean {
    return this.histories.has(jobId);
  }

  /**
   * all_done 이벤트 후 호출 — HISTORY_TTL_MS 뒤 자원 자동 해제.
   */
  scheduleCleanup(jobId: string): void {
    // 이미 타이머가 있으면 갱신
    const existing = this.timers.get(jobId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => this._cleanup(jobId), HISTORY_TTL_MS);
    this.timers.set(jobId, timer);
  }

  private _cleanup(jobId: string): void {
    this.emitters.get(jobId)?.removeAllListeners();
    this.emitters.delete(jobId);
    this.histories.delete(jobId);
    this.timers.delete(jobId);
  }
}

export const jobEventBus = JobEventBus.getInstance();
