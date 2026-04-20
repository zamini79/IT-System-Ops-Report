/**
 * ReportGeneratePage
 *
 * ─ 진입 경로 ─────────────────────────────────────────────────────────────────
 *  • location.state = { jobId, divisionCode }  — DivisionReportPage 에서 이동
 *  • ?jobId=<uuid>                             — 직접 URL 접근
 *  • 상태 없음                                 — 이력 목록에서 선택
 *
 * ─ 화면 구성 ─────────────────────────────────────────────────────────────────
 *  1. Job 선택 카드 (jobId 없을 때)
 *  2. Job 개요 (본부, 생성일, 현재 상태)
 *  3. 수집 데이터 요약 (시스템별 태스크 + 업로드 파일)
 *  4. PDF 생성 패널 (idle → generating → done | error)
 */

import {
  useState, useEffect, useCallback, type ReactNode,
}                                                    from "react";
import { useLocation, useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient }     from "@tanstack/react-query";
import { apiClient }                                  from "../api/client";
import { useAuth }                                    from "../hooks/useAuth";
import {
  AppLayout,
  StatusBadge,
  ProgressBar,
  LoadingSpinner,
  useToast,
}                                                    from "../components/common";
import type { PaginatedResponse }                    from "@skbs/shared";

// ── 시스템 순서 (백엔드 SYSTEM_ORDER 동기화) ──────────────────────────────────

const SYSTEM_ORDER: Record<string, string[]> = {
  BIO:    ["EDMS", "ELN", "GCLP_LIMS"],
  DEV:    ["EQMS", "EDMS", "ELMS", "CTMS", "ETMF", "MEDCOMMS"],
  LHOUSE: ["EQMS", "EDMS", "ELMS"],
};

const SYSTEM_LABELS: Record<string, string> = {
  EDMS: "eDMS", ELN: "ELN", GCLP_LIMS: "GCLP LIMS",
  EQMS: "eQMS", ELMS: "eLMS",
  CTMS: "CTMS", ETMF: "eTMF", MEDCOMMS: "Medcomms",
};

// ── 내부 타입 ─────────────────────────────────────────────────────────────────

interface HistoryJob {
  id:            string;
  status:        string;
  pdf_path:      string | null;
  error_message: string | null;
  started_at:    string | null;
  completed_at:  string | null;
  created_at:    string;
  division_code: string;
  division_name: string;
}

interface SsePayload {
  type:        string;
  systemName?: string;
  filePaths?:  string[];
  error?:      string;
  pdfPath?:    string;
  pageCount?:  number;
  fileSize?:   number;
}

interface JobStatusResponse {
  job: {
    id:         string;
    status:     string;
    pdf_path:   string | null;
    created_at: string;
  };
  events: SsePayload[];
}

interface UploadedFileRow {
  id:              string;
  original_name:   string;
  file_type:       string;
  file_size:       number;
  analysis_result: { status: string; result?: { type: string; sheetCount?: number; pageCount?: number } } | null;
  created_at:      string;
}

interface TaskDerived {
  systemName: string;
  label:      string;
  status:     "PENDING" | "COMPLETED" | "FAILED";
  filePaths:  string[];
  error:      string | null;
}

type GenPhase = "idle" | "generating" | "done" | "error";

interface PdfResult {
  pdfPath:   string;
  pageCount: number;
  fileSize:  number;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

function fmtBytes(b: number): string {
  if (b < 1024)        return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** SSE 이벤트 replay 에서 시스템별 태스크 상태 재구성 */
function deriveTasksFromEvents(
  divisionCode: string,
  events: SsePayload[]
): TaskDerived[] {
  const systems = SYSTEM_ORDER[divisionCode] ?? [];

  return systems.map((sysName) => {
    const doneEv  = events.find((e) => e.type === "task_done"  && e.systemName === sysName);
    const errEv   = events.find((e) => e.type === "task_error" && e.systemName === sysName);

    if (doneEv) {
      return {
        systemName: sysName,
        label:      SYSTEM_LABELS[sysName] ?? sysName,
        status:     "COMPLETED",
        filePaths:  doneEv.filePaths ?? [],
        error:      null,
      };
    }
    if (errEv) {
      return {
        systemName: sysName,
        label:      SYSTEM_LABELS[sysName] ?? sysName,
        status:     "FAILED",
        filePaths:  [],
        error:      errEv.error ?? "알 수 없는 오류",
      };
    }
    return {
      systemName: sysName,
      label:      SYSTEM_LABELS[sysName] ?? sysName,
      status:     "PENDING",
      filePaths:  [],
      error:      null,
    };
  });
}

// ── SSE 파싱 헬퍼 ─────────────────────────────────────────────────────────────

function parseChunk(chunk: string): SsePayload[] {
  const result: SsePayload[] = [];
  for (const block of chunk.split(/\n\n+/)) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try { result.push(JSON.parse(line.slice(6)) as SsePayload); } catch { /* skip */ }
  }
  return result;
}

// ── 서브 컴포넌트: 섹션 카드 ──────────────────────────────────────────────────

function SectionCard({ title, subtitle, children }: {
  title:    string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
        {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

// ── 서브 컴포넌트: Job 선택기 ──────────────────────────────────────────────────

function JobSelector({
  jobs,
  onSelect,
}: {
  jobs:     HistoryJob[];
  onSelect: (job: HistoryJob) => void;
}) {
  if (!jobs.length) {
    return (
      <p className="text-sm text-gray-400 text-center py-8">
        생성된 보고서 이력이 없습니다. 사업부 페이지에서 먼저 데이터를 수집하세요.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-gray-100">
      {jobs.map((j) => (
        <li
          key={j.id}
          onClick={() => onSelect(j)}
          className="flex items-center justify-between gap-4 px-1 py-3 cursor-pointer rounded-lg hover:bg-primary-50 transition-colors"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-800">{j.division_name}</p>
            <p className="text-xs text-gray-400 mt-0.5 font-mono truncate">{j.id}</p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="text-xs text-gray-500">{fmtDate(j.created_at)}</span>
            <StatusBadge status={j.status} size="sm" />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── 서브 컴포넌트: 태스크 행 ──────────────────────────────────────────────────

function TaskRow({ task, idx }: { task: TaskDerived; idx: number }) {
  return (
    <tr className={idx % 2 === 1 ? "bg-gray-50" : ""}>
      <td className="px-4 py-2.5 text-sm font-medium text-gray-700">{task.label}</td>
      <td className="px-4 py-2.5">
        <StatusBadge status={task.status} size="sm" />
      </td>
      <td className="px-4 py-2.5 text-xs text-gray-500">
        {task.status === "COMPLETED"
          ? `${task.filePaths.length}개 파일`
          : task.error
          ? <span className="text-red-500 truncate max-w-[200px] block" title={task.error}>{task.error.slice(0, 60)}</span>
          : "—"}
      </td>
    </tr>
  );
}

// ── 서브 컴포넌트: PDF 생성 패널 ──────────────────────────────────────────────

function GenerationPanel({
  phase,
  message,
  result,
  error,
  onGenerate,
  onRetry,
  onDownload,
  isSubmitting,
  canGenerate,
}: {
  phase:       GenPhase;
  message:     string;
  result:      PdfResult | null;
  error:       string | null;
  onGenerate:  () => void;
  onRetry:     () => void;
  onDownload:  () => void;
  isSubmitting: boolean;
  canGenerate:  boolean;
}) {
  return (
    <div className="space-y-4">
      {/* idle */}
      {phase === "idle" && (
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <div className="w-14 h-14 rounded-full bg-secondary/10 flex items-center justify-center">
            <svg className="w-7 h-7 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800 mb-1">PDF 보고서 생성</p>
            <p className="text-xs text-gray-500">수집된 데이터를 바탕으로 A4 PDF 보고서를 생성합니다.</p>
          </div>
          <button
            onClick={onGenerate}
            disabled={!canGenerate || isSubmitting}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold transition-all shadow-sm
              ${canGenerate && !isSubmitting
                ? "bg-secondary text-white hover:bg-secondary-600"
                : "bg-gray-100 text-gray-400 cursor-not-allowed"}`}
          >
            {isSubmitting ? (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            )}
            보고서 생성
          </button>
          {!canGenerate && (
            <p className="text-xs text-amber-600">보고서 작업(Job)을 먼저 선택하세요.</p>
          )}
        </div>
      )}

      {/* generating */}
      {phase === "generating" && (
        <div className="space-y-4 py-4">
          <div className="flex items-center gap-3">
            <LoadingSpinner size="md" />
            <div>
              <p className="text-sm font-semibold text-gray-800">PDF 생성 중…</p>
              <p className="text-xs text-gray-500 mt-0.5">{message || "Headless Chrome으로 렌더링하는 중입니다."}</p>
            </div>
          </div>
          <ProgressBar value={0} size="md" showPercent={false} />
          <div className="bg-blue-50 rounded-lg px-4 py-3">
            <p className="text-xs text-blue-700">
              페이지 수와 복잡도에 따라 수십 초가 소요될 수 있습니다. 창을 닫아도 서버에서 계속 생성됩니다.
            </p>
          </div>
        </div>
      )}

      {/* done */}
      {phase === "done" && result && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 bg-green-50 border border-green-200 rounded-xl p-4">
            <svg className="w-6 h-6 text-green-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-green-800 mb-2">PDF 생성 완료</p>
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-white rounded-lg px-3 py-2 text-center border border-green-100">
                  <p className="text-xs text-gray-500 mb-0.5">파일명</p>
                  <p className="text-xs font-semibold text-gray-700 truncate" title={result.pdfPath.split("/").pop()}>
                    {result.pdfPath.split("/").pop() ?? "report.pdf"}
                  </p>
                </div>
                <div className="bg-white rounded-lg px-3 py-2 text-center border border-green-100">
                  <p className="text-xs text-gray-500 mb-0.5">페이지</p>
                  <p className="text-sm font-bold text-gray-800">{result.pageCount}</p>
                </div>
                <div className="bg-white rounded-lg px-3 py-2 text-center border border-green-100">
                  <p className="text-xs text-gray-500 mb-0.5">크기</p>
                  <p className="text-sm font-bold text-gray-800">{fmtBytes(result.fileSize)}</p>
                </div>
              </div>
            </div>
          </div>
          <button
            onClick={onDownload}
            className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-secondary text-white
              rounded-lg text-sm font-semibold hover:bg-secondary-600 transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            PDF 다운로드
          </button>
        </div>
      )}

      {/* error */}
      {phase === "error" && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4">
            <svg className="w-6 h-6 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.008v.008H12v-.008z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-red-700 mb-1">PDF 생성 실패</p>
              <p className="text-xs text-red-600 break-words">{error ?? "알 수 없는 오류가 발생했습니다."}</p>
            </div>
          </div>
          <button
            onClick={onRetry}
            className="w-full flex items-center justify-center gap-2 px-5 py-2.5 border-2 border-secondary
              text-secondary rounded-lg text-sm font-semibold hover:bg-secondary/5 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            재시도
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 메인 페이지
// ─────────────────────────────────────────────────────────────────────────────

export function ReportGeneratePage() {
  const location     = useLocation();
  const [searchParams] = useSearchParams();
  const navigate     = useNavigate();
  const { user }     = useAuth();
  const { success, error: toastError } = useToast();
  const queryClient  = useQueryClient();

  // ── 초기 jobId / divisionCode 결정 ──────────────────────────────────────────
  const stateJobId        = (location.state as { jobId?: string } | null)?.jobId ?? null;
  const stateDivisionCode = (location.state as { divisionCode?: string } | null)?.divisionCode ?? null;
  const paramJobId        = searchParams.get("jobId");

  const [selectedJobId,       setSelectedJobId]       = useState<string | null>(stateJobId ?? paramJobId);
  const [selectedDivisionCode, setSelectedDivisionCode] = useState<string | null>(stateDivisionCode);

  // ── 생성 상태 ──────────────────────────────────────────────────────────────
  const [genPhase,   setGenPhase]   = useState<GenPhase>("idle");
  const [genMessage, setGenMessage] = useState("");
  const [pdfResult,  setPdfResult]  = useState<PdfResult | null>(null);
  const [genError,   setGenError]   = useState<string | null>(null);
  const [sseActive,  setSseActive]  = useState(false);

  // ── 이력 목록 (job 선택기 + 본부명 조회) ─────────────────────────────────────
  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ["report", "history", "all"],
    queryFn:  () =>
      apiClient
        .get<PaginatedResponse<HistoryJob>>("/report/history?limit=50")
        .then((r) => r.data),
  });
  const historyJobs: HistoryJob[] = historyData?.data ?? [];

  // 선택된 job의 상세 (division_name 등)
  const selectedHistoryJob = historyJobs.find((j) => j.id === selectedJobId) ?? null;
  const divisionCode       = selectedDivisionCode ?? selectedHistoryJob?.division_code ?? null;

  // ── 선택된 Job의 상태 + SSE 이벤트 replay ────────────────────────────────────
  const { data: statusData } = useQuery({
    queryKey: ["report", "status", selectedJobId],
    queryFn:  () =>
      apiClient
        .get<{ success: boolean; data: JobStatusResponse }>(`/report/${selectedJobId}/status`)
        .then((r) => r.data.data),
    enabled:         !!selectedJobId,
    refetchInterval: genPhase === "generating" ? false : 10_000,
  });

  // 이미 완료된 보고서 → 즉시 done 상태 전환
  useEffect(() => {
    if (!statusData) return;
    const { job, events } = statusData;

    if (job.status === "COMPLETED" && job.pdf_path && genPhase === "idle") {
      const doneEv = events.find((e) => e.type === "report_done");
      setPdfResult({
        pdfPath:   doneEv?.pdfPath   ?? job.pdf_path,
        pageCount: doneEv?.pageCount ?? 0,
        fileSize:  doneEv?.fileSize  ?? 0,
      });
      setGenPhase("done");
    }
    if (job.status === "FAILED" && genPhase === "idle") {
      const errEv = events.find((e) => e.type === "report_error");
      setGenError(errEv?.error ?? "PDF 생성에 실패했습니다.");
      setGenPhase("error");
    }
  }, [statusData, genPhase]);

  // ── 업로드된 파일 목록 ────────────────────────────────────────────────────────
  const { data: fileRows } = useQuery({
    queryKey: ["files", selectedJobId],
    queryFn:  () =>
      apiClient
        .get<{ success: boolean; data: UploadedFileRow[] }>(`/file/list?jobId=${selectedJobId}`)
        .then((r) => r.data.data ?? []),
    enabled: !!selectedJobId,
  });
  const uploadedFiles = fileRows ?? [];

  // ── 시스템 태스크 재구성 (SSE 이벤트 replay 기반) ────────────────────────────
  const derivedTasks: TaskDerived[] = divisionCode
    ? deriveTasksFromEvents(divisionCode, statusData?.events ?? [])
    : [];

  const completedCount = derivedTasks.filter((t) => t.status === "COMPLETED").length;
  const failedCount    = derivedTasks.filter((t) => t.status === "FAILED").length;

  // ── SSE 구독 (보고서 생성 진행) ───────────────────────────────────────────────
  useEffect(() => {
    if (!selectedJobId || !sseActive) return;

    const token = localStorage.getItem("token");
    const ctrl  = new AbortController();

    (async () => {
      try {
        const res = await fetch(`/api/report/${selectedJobId}/stream`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal:  ctrl.signal,
        });

        if (!res.ok || !res.body) {
          setGenPhase("error");
          setGenError(`SSE 연결 실패 (${res.status})`);
          setSseActive(false);
          return;
        }

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let   buffer  = "";

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const boundary = buffer.lastIndexOf("\n\n");
          if (boundary === -1) continue;

          const chunk = buffer.slice(0, boundary + 2);
          buffer      = buffer.slice(boundary + 2);

          for (const p of parseChunk(chunk)) {
            if (p.type === "report_generating") {
              setGenPhase("generating");
              setGenMessage("HTML 분석 후 Headless Chrome으로 렌더링 중입니다…");
            } else if (p.type === "report_done") {
              setGenPhase("done");
              setPdfResult({
                pdfPath:   p.pdfPath   ?? "",
                pageCount: p.pageCount ?? 0,
                fileSize:  p.fileSize  ?? 0,
              });
              setSseActive(false);
              success("PDF 보고서가 생성되었습니다.");
              void queryClient.invalidateQueries({ queryKey: ["report", "status", selectedJobId] });
              void queryClient.invalidateQueries({ queryKey: ["report", "history"] });
            } else if (p.type === "report_error") {
              setGenPhase("error");
              setGenError(p.error ?? "PDF 생성 중 오류가 발생했습니다.");
              setSseActive(false);
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setGenPhase("error");
        setGenError("SSE 연결이 끊어졌습니다.");
        setSseActive(false);
      }
    })();

    return () => ctrl.abort();
  }, [selectedJobId, sseActive, success, queryClient]);

  // ── 보고서 생성 뮤테이션 ─────────────────────────────────────────────────────
  const generateMutation = useMutation({
    mutationFn: () =>
      apiClient.post("/report/generate", {
        divisionCode,
        jobId: selectedJobId,
        userId: user?.id,
      }),
    onSuccess: () => {
      setGenPhase("generating");
      setGenError(null);
      setPdfResult(null);
      setSseActive(true); // SSE 연결 시작
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? "보고서 생성 요청에 실패했습니다.";
      setGenPhase("error");
      setGenError(msg);
      toastError(msg);
    },
  });

  // ── 다운로드 ─────────────────────────────────────────────────────────────────
  const handleDownload = useCallback(async () => {
    if (!selectedJobId) return;
    try {
      const res = await apiClient.get<Blob>(`/report/${selectedJobId}/download`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data);
      const a   = document.createElement("a");
      a.href     = url;
      a.download = pdfResult?.pdfPath.split("/").pop() ?? `report_${selectedJobId}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toastError("PDF 다운로드에 실패했습니다.");
    }
  }, [selectedJobId, pdfResult, toastError]);

  // ── Job 선택 핸들러 ──────────────────────────────────────────────────────────
  const handleSelectJob = (job: HistoryJob) => {
    setSelectedJobId(job.id);
    setSelectedDivisionCode(job.division_code);
    setGenPhase("idle");
    setPdfResult(null);
    setGenError(null);
    setSseActive(false);
  };

  // ── 재시도 ───────────────────────────────────────────────────────────────────
  const handleRetry = () => {
    setGenPhase("idle");
    setGenError(null);
  };

  // ── 렌더 ─────────────────────────────────────────────────────────────────────
  return (
    <AppLayout title="보고서 생성">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* ── 좌측: Job 선택 + 데이터 요약 ── */}
        <div className="lg:col-span-2 space-y-5">

          {/* 1. Job 선택 / 개요 */}
          {!selectedJobId ? (
            <SectionCard
              title="보고서 작업 선택"
              subtitle="PDF를 생성할 수집 작업(Job)을 선택하세요."
            >
              {historyLoading ? (
                <LoadingSpinner centered size="md" label="이력 불러오는 중…" />
              ) : (
                <JobSelector jobs={historyJobs} onSelect={handleSelectJob} />
              )}
            </SectionCard>
          ) : (
            <SectionCard title="보고서 작업 정보">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <p className="text-base font-bold text-primary">
                    {selectedHistoryJob?.division_name ?? divisionCode ?? "—"}
                  </p>
                  <p className="text-xs font-mono text-gray-400 mt-0.5">{selectedJobId}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <StatusBadge status={selectedHistoryJob?.status ?? "PENDING"} />
                  <button
                    onClick={() => {
                      setSelectedJobId(null);
                      setGenPhase("idle");
                      setPdfResult(null);
                      setGenError(null);
                    }}
                    className="text-xs text-gray-400 hover:text-gray-600 underline"
                  >
                    변경
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-gray-50 rounded-lg px-3 py-2">
                  <p className="text-gray-400 mb-0.5">생성일</p>
                  <p className="font-medium text-gray-700">{fmtDate(selectedHistoryJob?.created_at ?? null)}</p>
                </div>
                <div className="bg-gray-50 rounded-lg px-3 py-2">
                  <p className="text-gray-400 mb-0.5">완료일</p>
                  <p className="font-medium text-gray-700">{fmtDate(selectedHistoryJob?.completed_at ?? null)}</p>
                </div>
              </div>
            </SectionCard>
          )}

          {/* 2. 시스템별 수집 데이터 */}
          {selectedJobId && derivedTasks.length > 0 && (
            <SectionCard
              title="시스템별 수집 현황"
              subtitle={`${completedCount}개 완료 · ${failedCount}개 실패 · ${derivedTasks.length}개 전체`}
            >
              <div className="mb-3">
                <ProgressBar
                  value={derivedTasks.length > 0 ? Math.round((completedCount / derivedTasks.length) * 100) : 0}
                  variant={failedCount > 0 ? "danger" : completedCount === derivedTasks.length ? "success" : "default"}
                  size="sm"
                  label="전체 수집률"
                />
              </div>
              <div className="overflow-x-auto rounded-lg border border-gray-100">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">시스템</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">상태</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">비고</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {derivedTasks.map((task, i) => (
                      <TaskRow key={task.systemName} task={task} idx={i} />
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          {/* 3. 업로드 파일 */}
          {selectedJobId && uploadedFiles.length > 0 && (
            <SectionCard
              title="업로드된 첨부파일"
              subtitle={`${uploadedFiles.length}개 파일`}
            >
              <ul className="divide-y divide-gray-100">
                {uploadedFiles.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 py-2.5">
                    <div className="w-8 h-8 rounded-md bg-gray-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-xs font-bold text-gray-400">
                        {f.file_type.includes("pdf") ? "P" : f.file_type.includes("image") ? "I" : "X"}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-700 truncate">{f.original_name}</p>
                      <p className="text-[11px] text-gray-400">{fmtBytes(f.file_size)}</p>
                    </div>
                    <div className="flex-shrink-0">
                      {(() => {
                        const ar = f.analysis_result;
                        if (!ar)                     return <span className="text-[11px] text-gray-300">분석 없음</span>;
                        if (ar.status === "pending") return <span className="text-[11px] text-amber-500">분석 중</span>;
                        if (ar.status === "failed")  return <span className="text-[11px] text-red-500">분석 실패</span>;
                        if (ar.result?.type === "pdf") return <span className="text-[11px] text-green-600">PDF {ar.result.pageCount}p</span>;
                        if (ar.result?.type === "excel" || ar.result?.type === "csv")
                          return <span className="text-[11px] text-green-600">시트 {ar.result.sheetCount}개</span>;
                        return <span className="text-[11px] text-green-600">분석 완료</span>;
                      })()}
                    </div>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}
        </div>

        {/* ── 우측: PDF 생성 패널 ── */}
        <div className="lg:col-span-1">
          <div className="sticky top-20 space-y-3">
            <SectionCard title="PDF 보고서 생성">
              <GenerationPanel
                phase={genPhase}
                message={genMessage}
                result={pdfResult}
                error={genError}
                onGenerate={() => generateMutation.mutate()}
                onRetry={handleRetry}
                onDownload={() => void handleDownload()}
                isSubmitting={generateMutation.isPending}
                canGenerate={!!selectedJobId && !!divisionCode && genPhase === "idle"}
              />
            </SectionCard>

            {/* 메일 작성 바로가기 */}
            {genPhase === "done" && selectedJobId && (
              <button
                onClick={() => navigate("/mail/compose", {
                  state: { jobId: selectedJobId, divisionCode }
                })}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg
                  border border-secondary text-secondary text-sm font-medium hover:bg-secondary/5 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                메일 초안 작성
              </button>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
