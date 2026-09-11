/**
 * JobProgressContext — 수집/보고서 진행 상태를 **라우터 바깥**에서 보관한다.
 *
 * ── 왜 필요한가 ───────────────────────────────────────────────────────────────
 *  진행 상태(`crawlActive`, `devCollecting` …)와 SSE 구독이 본부 페이지 컴포넌트의
 *  useState 안에 있었다. 다른 메뉴로 이동하면 컴포넌트가 언마운트되어
 *    · SSE 연결이 끊기고 (useCrawlSSE 의 cleanup 이 abort 한다)
 *    · 진행 플래그가 false 로 초기화되어 **돌아와도 재연결하지 않았다**
 *  백엔드는 이미 원하는 대로 동작한다 — 수집 요청은 202 로 즉시 반환하고
 *  작업은 백그라운드에서 계속되며, 이벤트 버스가 30분간 이력을 보관해
 *  재연결 시 전부 다시 보내준다(jobEventBus). 즉 **프론트만 붙어 있지 않았다.**
 *
 *  그래서 이 Provider 를 Routes 위에 두어 화면 전환과 무관하게 구독을 유지하고,
 *  진행 중인 작업을 localStorage 에 남겨 **새로고침·재접속 후에도 복구**한다.
 *  복구 시 백엔드 replay 로 로그가 처음부터 다시 채워진다.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";
import { useCrawlSSE, type LogEntry } from "../hooks/useCrawlSSE";

// ── 진행 중 작업 ──────────────────────────────────────────────────────────────

export type RunKind = "collect" | "crawl" | "report";

export interface ActiveRun {
  jobId:        string;
  divisionCode: "BIO" | "DEV" | "LHOUSE";
  /** SSE 태스크 표시에 필요한 시스템 코드 목록 */
  systemCodes:  string[];
  kind:         RunKind;
  startedAt:    number;
}

const STORAGE_KEY = "active_job_run";
/** 너무 오래된 기록은 복구하지 않는다 — 서버 이력 TTL(30분)과 맞춘다 */
const RESTORE_TTL_MS = 30 * 60 * 1000;

function loadRun(): ActiveRun | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as ActiveRun;
    if (!r?.jobId || typeof r.startedAt !== "number") return null;
    if (Date.now() - r.startedAt > RESTORE_TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return r;
  } catch { return null; }
}

// ── Context ───────────────────────────────────────────────────────────────────

type SseState = ReturnType<typeof useCrawlSSE>;

interface JobProgressValue {
  /** 진행 중인 작업 (없으면 null) */
  run: ActiveRun | null;
  /** SSE 상태 — 화면 전환과 무관하게 유지된다 */
  sse: SseState;
  /** 업로드·PDF 등 프론트에서 만든 로그 (SSE 로그와 합쳐 표시) */
  localLogs: LogEntry[];
  addLocalLog: (systemName: string, message: string, kind?: LogEntry["kind"]) => void;
  /** 작업 시작 — localStorage 에 기록해 이동·새로고침에도 살아남는다 */
  startRun: (run: Omit<ActiveRun, "startedAt">) => void;
  /** 작업 종료 (완료·실패·사용자 취소) */
  endRun: () => void;
  /** 이 본부에서 진행 중인가 (버튼 비활성·스피너 표시용) */
  isRunning: (divisionCode: string, kind?: RunKind) => boolean;
}

const JobProgressContext = createContext<JobProgressValue | null>(null);

export function JobProgressProvider({ children }: { children: ReactNode }) {
  const [run, setRun] = useState<ActiveRun | null>(() => loadRun());
  const [localLogs, setLocalLogs] = useState<LogEntry[]>([]);

  // 구독은 Provider 에서 한 번만 — 어느 화면에 있어도 끊기지 않는다.
  const sse = useCrawlSSE(run?.jobId ?? "", run?.systemCodes ?? [], !!run);

  const startRun = useCallback((r: Omit<ActiveRun, "startedAt">) => {
    const next: ActiveRun = { ...r, startedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setRun(next);
  }, []);

  const endRun = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setRun(null);
  }, []);

  const addLocalLog = useCallback(
    (systemName: string, message: string, kind: LogEntry["kind"] = "info") => {
      setLocalLogs((prev) => [
        ...prev, { time: new Date().toISOString(), systemName, message, kind },
      ]);
    }, []
  );

  // 수집이 끝나면(완료·오류) 실행 기록을 정리한다. 단 원클릭 흐름은 수집 뒤
  // PDF 생성이 이어지므로, 그 단계는 호출부가 startRun(kind:"report") 로 이어받는다.
  useEffect(() => {
    if (!run) return;
    if (run.kind === "collect" || run.kind === "crawl") {
      if (sse.phase === "done" || sse.phase === "error") {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }, [run, sse.phase]);

  const isRunning = useCallback(
    (divisionCode: string, kind?: RunKind) => {
      if (!run || run.divisionCode !== divisionCode) return false;
      if (kind && run.kind !== kind) return false;
      return sse.phase !== "done" && sse.phase !== "error";
    }, [run, sse.phase]
  );

  const value = useMemo<JobProgressValue>(
    () => ({ run, sse, localLogs, addLocalLog, startRun, endRun, isRunning }),
    [run, sse, localLogs, addLocalLog, startRun, endRun, isRunning]
  );

  return <JobProgressContext.Provider value={value}>{children}</JobProgressContext.Provider>;
}

export function useJobProgress(): JobProgressValue {
  const ctx = useContext(JobProgressContext);
  if (!ctx) throw new Error("useJobProgress 는 JobProgressProvider 안에서만 사용할 수 있습니다.");
  return ctx;
}
