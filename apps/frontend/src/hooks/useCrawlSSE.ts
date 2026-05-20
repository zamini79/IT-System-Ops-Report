/**
 * useCrawlSSE
 *
 * fetch + ReadableStream 기반 SSE 구독 훅.
 * EventSource 대신 fetch를 사용하여 Authorization 헤더 첨부가 가능합니다.
 *
 * 구독 이벤트 (crawl.events.ts SseEventType):
 *   task_start · progress · task_done · task_error · all_done
 *   screenshot_done · screenshot_error
 *   report_generating · report_done · report_error
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ── 공개 타입 ─────────────────────────────────────────────────────────────────

export type CrawlPhase =
  | "idle"       // 시작 전
  | "crawling"   // 수집 중
  | "done"       // 완료
  | "error";     // 오류

export type TaskStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export interface TaskState {
  status:     TaskStatus;
  progress:   number;          // 0-100
  error:      string | null;
  updatedAt:  string | null;
  screenshot: {
    path:      string;
    width:     number;
    height:    number;
    capturedAt: string;
  } | null;
  filePaths:  string[];
}

export interface PdfInfo {
  pdfPath:   string;
  pageCount: number;
  fileSize:  number;
}

export interface LogEntry {
  time:       string;   // ISO timestamp
  systemName: string;
  message:    string;
  kind:       "info" | "success" | "error" | "warn";
}

export interface CrawlSSEState {
  phase:       CrawlPhase;
  taskMap:     Record<string, TaskState>;
  isConnected: boolean;
  pdfReady:    boolean;
  pdfInfo:     PdfInfo | null;
  /** crawl_error / report_error 메시지 */
  globalError: string | null;
  /** 실시간 진행 로그 */
  logs:        LogEntry[];
}

// ── 내부 SSE 페이로드 타입 ────────────────────────────────────────────────────

interface SsePayload {
  type:             string;
  systemName?:      string;
  total?:           number;
  percent?:         number;
  message?:         string;
  filePaths?:       string[];
  error?:           string;
  jobId?:           string;
  screenshotPath?:  string;
  screenshotWidth?: number;
  screenshotHeight?: number;
  capturedAt?:      string;
  pdfPath?:         string;
  pageCount?:       number;
  fileSize?:        number;
  attempt?:         number;
  maxRetries?:      number;
}

// ── 초기 TaskState 팩토리 ────────────────────────────────────────────────────

function makeInitialTaskMap(systems: string[]): Record<string, TaskState> {
  return Object.fromEntries(
    systems.map((s) => [
      s,
      {
        status:     "PENDING" as TaskStatus,
        progress:   0,
        error:      null,
        updatedAt:  null,
        screenshot: null,
        filePaths:  [],
      },
    ])
  );
}

// ── SSE 파싱 헬퍼 ─────────────────────────────────────────────────────────────

function parseSseChunk(chunk: string): SsePayload[] {
  const results: SsePayload[] = [];
  const blocks = chunk.split(/\n\n+/);
  for (const block of blocks) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    try {
      results.push(JSON.parse(dataLine.slice(6)) as SsePayload);
    } catch {
      // 파싱 실패는 무시
    }
  }
  return results;
}

// ── 훅 ───────────────────────────────────────────────────────────────────────

export function useCrawlSSE(
  jobId: string | null,
  systems: string[],
  /** crawling 페이즈일 때만 연결 */
  active: boolean
): CrawlSSEState & { reset: () => void } {
  const initialMap = useRef(makeInitialTaskMap(systems));

  const [phase,       setPhase]       = useState<CrawlPhase>("idle");
  const [taskMap,     setTaskMap]     = useState<Record<string, TaskState>>(initialMap.current);
  const [isConnected, setIsConnected] = useState(false);
  const [pdfReady,    setPdfReady]    = useState(false);
  const [pdfInfo,     setPdfInfo]     = useState<PdfInfo | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [logs,        setLogs]        = useState<LogEntry[]>([]);

  const addLog = useCallback((systemName: string, message: string, kind: LogEntry["kind"] = "info") => {
    setLogs((prev) => [
      ...prev,
      { time: new Date().toISOString(), systemName, message, kind },
    ]);
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setTaskMap(makeInitialTaskMap(systems));
    setIsConnected(false);
    setPdfReady(false);
    setPdfInfo(null);
    setGlobalError(null);
    setLogs([]);
  }, [systems]);

  // 재실행 시 잔존 상태(COMPLETED/FAILED)가 새 실행의 완료로 오인되는 것 방지
  const resetTask = useCallback((systemName: string) => {
    setTaskMap((prev) => ({
      ...prev,
      [systemName]: {
        status:     "PENDING",
        progress:   0,
        error:      null,
        updatedAt:  null,
        screenshot: null,
        filePaths:  [],
      },
    }));
  }, []);

  // 이벤트 핸들러 (setState 함수형 업데이트로 stale closure 방지)
  const handlePayload = useCallback((p: SsePayload) => {
    switch (p.type) {
      case "task_start":
        setPhase("crawling");
        if (p.systemName) {
          addLog(p.systemName, `수집 시작`, "info");
          setTaskMap((prev) => ({
            ...prev,
            [p.systemName!]: {
              ...prev[p.systemName!],
              status:    "RUNNING",
              progress:  5,
              updatedAt: new Date().toISOString(),
            },
          }));
        }
        break;

      case "progress":
        if (p.systemName) {
          if (p.message) addLog(p.systemName, p.message, "info");
          setTaskMap((prev) => ({
            ...prev,
            [p.systemName!]: {
              ...prev[p.systemName!],
              progress:  p.percent ?? prev[p.systemName!]?.progress ?? 0,
              updatedAt: new Date().toISOString(),
            },
          }));
        }
        break;

      case "task_done":
        if (p.systemName) {
          addLog(p.systemName, `수집 완료 (${p.filePaths?.length ?? 0}개 파일)`, "success");
          setTaskMap((prev) => ({
            ...prev,
            [p.systemName!]: {
              ...prev[p.systemName!],
              status:    "COMPLETED",
              progress:  100,
              filePaths: p.filePaths ?? [],
              updatedAt: new Date().toISOString(),
            },
          }));
        }
        break;

      case "task_error":
        if (p.systemName) {
          addLog(p.systemName, `오류: ${p.error ?? "알 수 없는 오류"}`, "error");
          setTaskMap((prev) => ({
            ...prev,
            [p.systemName!]: {
              ...prev[p.systemName!],
              status:    "FAILED",
              progress:  100,
              error:     p.error ?? "알 수 없는 오류",
              updatedAt: new Date().toISOString(),
            },
          }));
        }
        break;

      case "task_retry":
        if (p.systemName) {
          addLog(p.systemName, `재시도 중 (${p.attempt}/${p.maxRetries})`, "warn");
        }
        break;

      case "screenshot_done":
        if (p.systemName && p.screenshotPath) {
          addLog(p.systemName, "스크린샷 캡처 완료", "success");
          setTaskMap((prev) => ({
            ...prev,
            [p.systemName!]: {
              ...prev[p.systemName!],
              screenshot: {
                path:       p.screenshotPath!,
                width:      p.screenshotWidth  ?? 0,
                height:     p.screenshotHeight ?? 0,
                capturedAt: p.capturedAt ?? new Date().toISOString(),
              },
            },
          }));
        }
        break;

      case "all_done":
        addLog("시스템", "전체 수집 완료", "success");
        setPhase("done");
        setIsConnected(false);
        break;

      case "screenshot_error":
        // 개별 스크린샷 오류 — 무시 (task_error에서 처리)
        break;

      case "report_generating":
        addLog("시스템", "PDF 보고서 생성 중…", "info");
        break;

      case "report_done":
        addLog("시스템", "PDF 보고서 생성 완료", "success");
        setPdfReady(true);
        if (p.pdfPath) {
          setPdfInfo({ pdfPath: p.pdfPath, pageCount: p.pageCount ?? 0, fileSize: p.fileSize ?? 0 });
        }
        break;

      case "report_error":
        addLog("시스템", `PDF 생성 실패: ${p.error ?? ""}`, "error");
        setGlobalError(p.error ?? "PDF 생성 실패");
        break;
    }
  }, [addLog]);

  useEffect(() => {
    if (!jobId || !active) return;

    const ctrl = new AbortController();
    const token = localStorage.getItem("token");

    setIsConnected(false);

    const connect = async () => {
      try {
        const res = await fetch(`/api/crawl/${jobId}/stream`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal:  ctrl.signal,
        });

        if (!res.ok || !res.body) {
          setPhase("error");
          setGlobalError(`SSE 연결 실패: ${res.status}`);
          return;
        }

        setIsConnected(true);

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let   buffer  = "";

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // \n\n 단위로 청크 분리
          const boundary = buffer.lastIndexOf("\n\n");
          if (boundary === -1) continue;

          const chunk = buffer.slice(0, boundary + 2);
          buffer      = buffer.slice(boundary + 2);

          for (const payload of parseSseChunk(chunk)) {
            handlePayload(payload);
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setIsConnected(false);
        setPhase("error");
        setGlobalError("SSE 연결이 끊어졌습니다.");
      }
    };

    void connect();
    return () => ctrl.abort();
  }, [jobId, active, handlePayload]);

  return { phase, taskMap, isConnected, pdfReady, pdfInfo, globalError, logs, reset, resetTask };
}
