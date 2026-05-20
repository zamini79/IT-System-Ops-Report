/**
 * DivisionReportPage — 본부 공통 보고서 페이지
 *
 * Props:
 *   divisionCode  "BIO" | "DEV" | "LHOUSE"
 *   divisionName  "Bio연구본부" 등
 *   systems       [{ code, label }]
 *
 * 구성:
 *   1. 페이지 헤더 — 본부명 + 보고서 생성 버튼
 *   2. 시스템 카드 그리드 — 상태·진행률 실시간 반영
 *   3. 파일 업로드 드롭존 (react-dropzone)
 *   4. 데이터 미리보기 슬라이드 패널
 *   5. 하단 액션 바 — PDF 생성 / 메일 작성
 */

import {
  useState, useCallback, useRef, useEffect, type ReactNode,
}                                         from "react";
import { useNavigate }                    from "react-router-dom";
import { useDropzone }                    from "react-dropzone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient }                      from "../../api/client";
import { useAuth }                        from "../../hooks/useAuth";
import { useCrawlSSE }                    from "../../hooks/useCrawlSSE";
import type { TaskState, LogEntry }       from "../../hooks/useCrawlSSE";
import {
  AppLayout,
  StatusBadge,
  ProgressBar,
  LoadingSpinner,
  useToast,
}                                         from "../common";

// ── 공개 타입 ─────────────────────────────────────────────────────────────────

export interface SystemConfig {
  code:  string;
  label: string;
}

export interface DivisionReportPageProps {
  divisionCode: "BIO" | "DEV" | "LHOUSE";
  divisionName: string;
  systems:      SystemConfig[];
  /** true: 시스템 카드(좌) + 파일 업로드(우) 나란히 배치 */
  sideLayout?:  boolean;
}

// ── 업로드 파일 타입 ──────────────────────────────────────────────────────────

interface UploadedFileRow {
  id:              string;
  original_name:   string;
  file_type:       string;
  file_size:       number;
  analysis_result: {
    status: "pending" | "completed" | "failed";
    error?: string;
    result?: { type: string; [k: string]: unknown };
  } | null;
  created_at:      string;
}

// ── 상수 ──────────────────────────────────────────────────────────────────────

const ACCEPTED_MIME = {
  "application/vnd.ms-excel":
    [".xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    [".xlsx"],
  "text/csv":        [".csv"],
  "application/pdf": [".pdf"],
  "image/png":       [".png"],
  "image/jpeg":      [".jpg", ".jpeg"],
};

const MAX_SIZE_BYTES  = 50 * 1024 * 1024; // 50 MB
const MAX_FILE_COUNT  = 10;

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b < 1024)        return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDatetime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 백엔드 절대 경로(Windows/Unix 모두)를 /uploads/... URL로 변환 */
function toUploadUrl(absPath: string): string {
  const fwd = absPath.replace(/\\/g, "/");
  const rel = fwd.replace(/^.*\/uploads\//, "");
  return `/uploads/${rel}`;
}

function progressVariant(s: TaskState) {
  if (s.status === "FAILED")    return "danger"  as const;
  if (s.status === "COMPLETED") return "success" as const;
  return "default" as const;
}

function analysisBadge(row: UploadedFileRow): ReactNode {
  const ar = row.analysis_result;
  if (!ar)                      return <span className="text-xs text-gray-300">분석 없음</span>;
  if (ar.status === "pending")  return <span className="text-xs text-amber-500 animate-pulse">분석 중…</span>;
  if (ar.status === "failed")   return <span className="text-xs text-red-500">분석 실패</span>;
  if (ar.result?.type === "excel" || ar.result?.type === "csv") {
    const r = ar.result as { type: string; sheetCount: number };
    return <span className="text-xs text-green-600">시트 {r.sheetCount}개</span>;
  }
  if (ar.result?.type === "pdf") {
    const r = ar.result as { type: string; pageCount: number };
    return <span className="text-xs text-green-600">PDF {r.pageCount}p</span>;
  }
  if (ar.result?.type === "image") {
    return <span className="text-xs text-green-600">이미지</span>;
  }
  return <span className="text-xs text-green-600">분석 완료</span>;
}

// ── 시스템 아이콘 맵 ──────────────────────────────────────────────────────────

const SYSTEM_ICONS: Record<string, ReactNode> = {
  EDMS: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
  ELN: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
    </svg>
  ),
  GCLP_LIMS: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  ),
  EQMS: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  ),
  ELMS: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M12 14l9-5-9-5-9 5 9 5zm0 0l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z" />
    </svg>
  ),
  CTMS: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  ),
  ETMF: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  ),
  MEDCOMMS: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
};

const DEFAULT_ICON = (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
      d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// 서브 컴포넌트 1: SystemCard
// ─────────────────────────────────────────────────────────────────────────────

function SystemCard({
  config,
  task,
  onPreview,
  onCrawl,
  crawlActive,
  onDashboardCapture,
  dashboardCapturing,
  dashboardTask,
}: {
  config:       SystemConfig;
  task:         TaskState;
  onPreview:    (code: string) => void;
  /** LHOUSE 전용: 카드 내 "시스템 조회" 버튼 클릭 핸들러 */
  onCrawl?:             () => void;
  crawlActive?:         boolean;
  /** LHOUSE VEEVA 전용: 대시보드 캡처 버튼 */
  onDashboardCapture?:  () => void;
  dashboardCapturing?:  boolean;
  dashboardTask?:       TaskState | null;
}) {
  const icon = SYSTEM_ICONS[config.code] ?? DEFAULT_ICON;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-3 shadow-sm hover:shadow-md transition-shadow">
      {/* 헤더 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center text-primary flex-shrink-0">
            {icon}
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800">{config.label}</p>
            <p className="text-[11px] text-gray-400">{config.code}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={task.status} size="sm" />
          {onCrawl && (
            <button
              onClick={onCrawl}
              disabled={crawlActive}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all
                ${crawlActive
                  ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                  : "bg-primary text-white hover:bg-primary-600 shadow-sm"}`}
            >
              {crawlActive ? (
                <>
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  조회 중
                </>
              ) : (
                <>
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  시스템 조회
                </>
              )}
            </button>
          )}
          {onDashboardCapture && (
            <button
              onClick={onDashboardCapture}
              disabled={dashboardCapturing}
              title="로그인 후 Veeva 대시보드 6개 차트를 1장 이미지로 캡처합니다"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border
                ${dashboardCapturing
                  ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                  : "bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100 shadow-sm"}`}
            >
              {dashboardCapturing ? (
                <>
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  캡처 중
                </>
              ) : (
                <>
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  대시보드 캡처
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* 진행률 */}
      <ProgressBar
        value={task.progress}
        variant={progressVariant(task)}
        size="sm"
        showPercent={task.status === "RUNNING"}
      />

      {/* 오류 메시지 */}
      {task.error && (
        <p className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1 truncate" title={task.error}>
          {task.error}
        </p>
      )}

      {/* 마지막 수집일시 + 미리보기 */}
      <div className="flex items-center justify-between pt-1 border-t border-gray-100 mt-auto">
        <span className="text-[11px] text-gray-400">
          {task.updatedAt ? fmtDatetime(task.updatedAt) : "수집 전"}
        </span>
        {task.status === "COMPLETED" && (
          <button
            onClick={() => onPreview(config.code)}
            className="text-[11px] text-secondary hover:underline font-medium"
          >
            미리보기 →
          </button>
        )}
      </div>

      {/* 대시보드 캡처 결과 다운로드 */}
      {dashboardTask?.status === "COMPLETED" && dashboardTask.filePaths.length > 0 && (
        <div className="flex items-center justify-between pt-1 border-t border-amber-100 bg-amber-50/60 -mx-4 px-4 pb-1 rounded-b-xl mt-1">
          <span className="text-[11px] text-amber-700 font-medium">대시보드 캡처 완료</span>
          <a
            href={toUploadUrl(dashboardTask.filePaths[0])}
            download="Systemusage_LHOUSE.jpg"
            className="text-[11px] text-amber-600 hover:text-amber-800 hover:underline font-semibold flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            이미지 다운로드
          </a>
        </div>
      )}
      {dashboardTask?.status === "FAILED" && dashboardTask.error && (
        <p className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1 truncate mt-1" title={dashboardTask.error}>
          캡처 실패: {dashboardTask.error}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 서브 컴포넌트 2: FileDropzonePanel
// ─────────────────────────────────────────────────────────────────────────────

function FileDropzonePanel({
  jobId,
  divisionCode,
  onUploadDone,
  onLog,
}: {
  jobId:        string;
  divisionCode: string;
  onUploadDone: () => void;
  onLog?:       (systemName: string, msg: string, kind: LogEntry["kind"]) => void;
}) {
  const { success, error: toastError } = useToast();
  const [uploading, setUploading] = useState(false);

  // 업로드된 파일 목록 (5초 폴링 — 분석 완료 여부 반영)
  const { data: fileListData, refetch: refetchFiles } = useQuery({
    queryKey: ["files", jobId],
    queryFn:  () =>
      apiClient
        .get<{ success: boolean; data: { files: UploadedFileRow[]; count: number } }>(`/file/list?jobId=${jobId}`)
        .then((r) => r.data.data?.files ?? []),
    refetchInterval: 5_000,
  });

  const files = fileListData ?? [];

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (!acceptedFiles.length) return;
      setUploading(true);
      onLog?.("파일 업로드", `${acceptedFiles.length}개 파일 업로드 시작…`, "info");
      try {
        const formData = new FormData();
        formData.append("jobId", jobId);
        formData.append("divisionCode", divisionCode);
        acceptedFiles.forEach((f) => formData.append("files", f));
        await apiClient.post("/file/upload", formData);
        success(`${acceptedFiles.length}개 파일이 업로드되었습니다.`);
        onLog?.("파일 업로드", `${acceptedFiles.length}개 파일 업로드 완료`, "success");
        void refetchFiles();
        onUploadDone();
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { error?: string } } })
            ?.response?.data?.error ?? "파일 업로드에 실패했습니다.";
        toastError(msg);
        onLog?.("파일 업로드", `업로드 실패: ${msg}`, "error");
      } finally {
        setUploading(false);
      }
    },
    [jobId, success, toastError, refetchFiles, onUploadDone, onLog]
  );

  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({
    onDrop,
    accept:   ACCEPTED_MIME,
    maxSize:  MAX_SIZE_BYTES,
    maxFiles: MAX_FILE_COUNT,
    disabled: uploading,
  });

  const handleDeleteFile = async (fileId: string) => {
    try {
      await apiClient.delete(`/file/${fileId}`);
      void refetchFiles();
    } catch {
      toastError("파일 삭제에 실패했습니다.");
    }
  };

  return (
    <section className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-800">파일 업로드</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          xlsx · xls · csv · pdf · png · jpg · jpeg / 최대 50 MB · 10개
        </p>
      </div>

      <div className="p-5 space-y-4">
        {/* 업로드된 파일 목록 */}
        {files.length > 0 && (
          <div className="rounded-lg border border-gray-100 overflow-hidden">
            {/* 헤더 */}
            <div className="grid grid-cols-[auto_1fr_100px_150px_36px] items-center gap-3 px-3 py-2 bg-gray-50 border-b border-gray-100">
              <span />
              <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">파일명</span>
              <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide text-right">용량</span>
              <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">업로드 일시</span>
              <span />
            </div>
            {/* 행 */}
            <ul className="divide-y divide-gray-50">
              {files.map((f) => (
                <li key={f.id}
                  className="grid grid-cols-[auto_1fr_100px_150px_36px] items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors"
                >
                  <FileTypeIcon mimeType={f.file_type} />

                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-700 truncate" title={f.original_name}>
                      {f.original_name}
                    </p>
                    <div className="mt-0.5">{analysisBadge(f)}</div>
                  </div>

                  <p className="text-xs text-gray-500 text-right tabular-nums">
                    {fmtBytes(f.file_size)}
                  </p>

                  <p className="text-[11px] text-gray-400 tabular-nums whitespace-nowrap">
                    {fmtDatetime(f.created_at)}
                  </p>

                  <button
                    onClick={() => void handleDeleteFile(f.id)}
                    className="flex items-center justify-center text-gray-300 hover:text-red-400 transition-colors"
                    title="삭제"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
            {/* 푸터 요약 */}
            <div className="px-3 py-2 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
              <span className="text-[11px] text-gray-400">
                총 {files.length}개 파일
              </span>
              <span className="text-[11px] text-gray-500 font-medium tabular-nums">
                {fmtBytes(files.reduce((s, f) => s + f.file_size, 0))}
              </span>
            </div>
          </div>
        )}

        {/* 드롭존 */}
        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-xl py-4 px-6 text-center cursor-pointer transition-colors
            ${isDragActive
              ? "border-secondary bg-secondary/5"
              : "border-gray-200 hover:border-secondary/60 hover:bg-gray-50"}
            ${uploading ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <input {...getInputProps()} />

          {uploading ? (
            <LoadingSpinner centered size="sm" label="업로드 중…" />
          ) : (
            <div className="flex items-center justify-center gap-3">
              <svg
                className={`w-6 h-6 flex-shrink-0 ${isDragActive ? "text-secondary" : "text-gray-300"}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <div>
                <p className="text-sm font-medium text-gray-600">
                  {isDragActive ? "여기에 놓으세요" : "파일을 드래그하거나 클릭하여 업로드"}
                </p>
                <p className="text-xs text-gray-400">Excel · CSV · PDF · 이미지 지원</p>
              </div>
            </div>
          )}
        </div>

        {/* 거부된 파일 오류 */}
        {fileRejections.length > 0 && (
          <div className="space-y-1">
            {fileRejections.map(({ file, errors }) => (
              <p key={file.name} className="text-xs text-red-500">
                {file.name}: {errors.map((e) => e.message).join(", ")}
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 서브 컴포넌트 2-B: LhouseNamedUploadPanel (LHOUSE 전용 고정명 2-슬롯 업로드)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 세 본부 공유 Timesheet 파일 슬롯 설정.
 * 로컬스토리지 키 "shared_timesheet_jobId" 로 관리하는 공유 jobId 와 함께 사용합니다.
 */
const SHARED_TIMESHEET_JOB_KEY = "shared_timesheet_jobId";

const TIMESHEET_SLOT: {
  slot:      string;
  label:     string;
  savedAs:   string;
  accept:    Record<string, string[]>;
  hint:      string;
  icon:      string;
  iconColor: string;
} = {
  slot:    "timesheet",
  label:   "Veeva MS Timesheet",
  savedAs: "SKB_Quallity_MS_Timesheet.xlsx",
  accept:  {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    "application/vnd.ms-excel": [".xls"],
    "application/zip":              [".xlsx"],
    "application/x-zip-compressed": [".xlsx"],
    "application/octet-stream":     [".xlsx", ".xls"],
  },
  hint:    "Excel 파일 1개 (.xlsx / .xls)",
  icon:    "T",
  iconColor: "text-indigo-600",
};

const LHOUSE_SLOTS: Array<{
  slot:      string;
  label:     string;
  savedAs:   string;
  accept:    Record<string, string[]>;
  hint:      string;
  icon:      string;
  iconColor: string;
}> = [
  {
    slot:    "activity",
    label:   "Activity (Task) Count",
    savedAs: "Activity_LHOUSE.xlsx",
    accept:  {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.ms-excel": [".xls"],
      "application/zip":              [".xlsx"],
      "application/x-zip-compressed": [".xlsx"],
      "application/octet-stream":     [".xlsx", ".xls"],
    },
    hint:    "Excel 파일 1개 (.xlsx / .xls)",
    icon:    "X",
    iconColor: "text-green-600",
  },
];

function SingleNamedDropzone({
  slot, label, savedAs, accept, hint, icon, iconColor, jobId, divisionCode, onUploadDone, serverFile, onLog,
}: {
  slot:         string;
  label:        string;
  savedAs:      string;
  accept:       Record<string, string[]>;
  hint:         string;
  icon:         string;
  iconColor:    string;
  jobId:        string;
  divisionCode: string;
  onUploadDone: () => void;
  /** 서버에서 조회된 기존 파일 정보 (페이지 새로고침 후에도 표시) */
  serverFile?:  UploadedFileRow | null;
  /** 진행 로그 콜백 (선택) */
  onLog?:       (systemName: string, msg: string, kind: LogEntry["kind"]) => void;
}) {
  const { success, error: toastError } = useToast();
  const [uploading,  setUploading]  = useState(false);
  const [deleting,   setDeleting]   = useState(false);
  const [currentFile, setCurrentFile] = useState<{ name: string; size: number; updatedAt: string } | null>(null);

  // 서버 파일 정보를 로컬 상태로 반영 (새로고침 후 복원)
  const displayFile = currentFile ?? (serverFile
    ? { name: serverFile.original_name, size: serverFile.file_size, updatedAt: serverFile.created_at }
    : null);

  const handleDelete = useCallback(async () => {
    if (!serverFile?.id) {
      // 로컬 상태만 있는 경우 (업로드 직후, serverFile 갱신 전)
      setCurrentFile(null);
      onUploadDone();
      return;
    }
    setDeleting(true);
    try {
      await apiClient.delete(`/file/${serverFile.id}`);
      setCurrentFile(null);
      success(`${displayFile?.name ?? savedAs} 파일이 삭제되었습니다.`);
      onLog?.(label, `${savedAs} 파일 삭제됨`, "warn");
      onUploadDone();
    } catch {
      toastError("파일 삭제에 실패했습니다.");
      onLog?.(label, "파일 삭제 실패", "error");
    } finally {
      setDeleting(false);
    }
  }, [serverFile, displayFile, savedAs, label, success, toastError, onUploadDone, onLog]);

  const onDrop = useCallback(
    async (accepted: File[]) => {
      if (!accepted.length) return;
      setUploading(true);
      onLog?.(label, `${accepted[0].name} 업로드 시작…`, "info");
      try {
        const fd = new FormData();
        fd.append("jobId",        jobId);
        fd.append("divisionCode", divisionCode);
        fd.append("slot",         slot);
        fd.append("file",         accepted[0]);
        await apiClient.post("/file/upload-named", fd);
        setCurrentFile({ name: savedAs, size: accepted[0].size, updatedAt: new Date().toISOString() });
        success(`${savedAs} 로 저장되었습니다.`);
        onLog?.(label, `${savedAs} 저장 완료 (${(accepted[0].size / 1024).toFixed(1)} KB)`, "success");
        onUploadDone();
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { error?: string } } })
            ?.response?.data?.error ?? "업로드에 실패했습니다.";
        toastError(msg);
        onLog?.(label, `업로드 실패: ${msg}`, "error");
      } finally {
        setUploading(false);
      }
    },
    [jobId, divisionCode, slot, savedAs, label, success, toastError, onUploadDone, onLog]
  );

  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({
    onDrop,
    accept,
    maxSize:  50 * 1024 * 1024,
    maxFiles: 1,
    multiple: false,
    disabled: uploading,
  });

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-gray-50">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">{label}</h3>
          <p className="text-xs text-gray-400">{hint}</p>
        </div>
        {displayFile && (
          <span className="text-xs text-green-600 font-medium">{fmtDatetime(displayFile.updatedAt)} 업로드</span>
        )}
      </div>

      <div className="p-4 space-y-3">
        {/* 현재 저장된 파일 표시 */}
        {displayFile && (
          <div className="flex items-center gap-3 px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
            <div className={`w-8 h-8 rounded-md bg-gray-100 flex items-center justify-center flex-shrink-0 text-xs font-bold ${iconColor}`}>
              {icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-700 truncate">{displayFile.name}</p>
              <p className="text-[11px] text-gray-400">{fmtBytes(displayFile.size)}</p>
            </div>
            <span className="text-[10px] text-green-600 font-semibold bg-green-50 px-2 py-0.5 rounded">저장됨</span>
            <button
              onClick={() => void handleDelete()}
              disabled={deleting || uploading}
              className="flex items-center justify-center w-6 h-6 rounded text-gray-300 hover:text-red-400 hover:bg-red-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="파일 삭제"
            >
              {deleting ? (
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              )}
            </button>
          </div>
        )}

        {/* 드롭존 */}
        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-xl py-4 px-6 text-center cursor-pointer transition-colors
            ${isDragActive
              ? "border-secondary bg-secondary/5"
              : "border-gray-200 hover:border-secondary/60 hover:bg-gray-50"}
            ${uploading ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <input {...getInputProps()} />
          {uploading ? (
            <LoadingSpinner centered size="sm" label="업로드 중…" />
          ) : (
            <div className="flex items-center justify-center gap-3">
              <svg
                className={`w-6 h-6 flex-shrink-0 ${isDragActive ? "text-secondary" : "text-gray-300"}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <div>
                <p className="text-sm font-medium text-gray-600">
                  {isDragActive ? "여기에 놓으세요" : displayFile ? "파일을 교체하려면 클릭 또는 드래그" : "파일을 드래그하거나 클릭하여 업로드"}
                </p>
                <p className="text-xs text-gray-400">{hint} · {savedAs} 로 저장</p>
              </div>
            </div>
          )}
        </div>

        {/* 거부된 파일 오류 */}
        {fileRejections.length > 0 && (
          <p className="text-xs text-red-500">
            {fileRejections[0].file.name}: {fileRejections[0].errors.map((e) => e.message).join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

function LhouseNamedUploadPanel({
  jobId,
  divisionCode,
  onUploadDone,
  fileList,
  onLog,
}: {
  jobId:        string;
  divisionCode: string;
  onUploadDone: () => void;
  fileList:     UploadedFileRow[];
  onLog?:       (systemName: string, msg: string, kind: LogEntry["kind"]) => void;
}) {
  return (
    <section className="space-y-4">
      {LHOUSE_SLOTS.map((s) => (
        <SingleNamedDropzone
          key={s.slot}
          {...s}
          jobId={jobId}
          divisionCode={divisionCode}
          onUploadDone={onUploadDone}
          serverFile={fileList.find((f) => f.original_name === s.savedAs) ?? null}
          onLog={onLog}
        />
      ))}
    </section>
  );
}

// ── DEV 슬롯 그룹 정의 ────────────────────────────────────────────────────────

const IMG_ACCEPT = { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"] };
const IMG_HINT   = "JPG / PNG 파일 1개 (.jpg / .jpeg / .png) — 서버에서 자동 분할";

interface DevSlotGroup {
  groupLabel: string;
  subLabel:   string;
  color:      string;
  slot:       string;
  savedAs:    string;
  chartCount: number;
  chartLayout: string;
}

const DEV_SLOT_GROUPS: DevSlotGroup[] = [];

/** 이미지 슬롯은 .jpg / .png 두 가지 이름으로 저장될 수 있어 양쪽을 탐색 */
function findDevServerFile(fileList: UploadedFileRow[], savedAs: string): UploadedFileRow | null {
  return (
    fileList.find((f) =>
      f.original_name === savedAs ||
      (savedAs.endsWith(".jpg") &&
        f.original_name === savedAs.replace(/\.jpg$/, ".png"))
    ) ?? null
  );
}

const EXCEL_ACCEPT = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-excel": [".xls"],
  "application/zip":              [".xlsx"],
  "application/x-zip-compressed": [".xlsx"],
  "application/octet-stream":     [".xlsx", ".xls"],
};

function DevNamedUploadPanel({
  jobId,
  divisionCode,
  onUploadDone,
  fileList,
  onLog,
}: {
  jobId:        string;
  divisionCode: string;
  onUploadDone: () => void;
  fileList:     UploadedFileRow[];
  onLog?:       (systemName: string, msg: string, kind: LogEntry["kind"]) => void;
}) {
  return (
    <section className="space-y-4">
      {/* Activity (Task) Count — Excel */}
      <SingleNamedDropzone
        slot="activity_gcp"
        label="Activity (Task) Count - GCP Quality System"
        savedAs="Activity_GCP.xlsx"
        accept={EXCEL_ACCEPT}
        hint="Excel 파일 1개 (.xlsx / .xls)"
        icon="X"
        iconColor="text-green-600"
        jobId={jobId}
        divisionCode={divisionCode}
        onUploadDone={onUploadDone}
        serverFile={fileList.find((f) => f.original_name === "Activity_GCP.xlsx") ?? null}
        onLog={onLog}
      />

      {/* 시스템별 대시보드 이미지 (3개) */}
      {DEV_SLOT_GROUPS.map((group) => (
        <div key={group.slot}>
          {/* 그룹 헤더 */}
          <div className={`flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg border ${group.color}`}>
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M14 8h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold block">{group.groupLabel}</span>
              <span className="text-[10px] opacity-60">{group.subLabel}</span>
            </div>
          </div>
          {/* 단일 이미지 슬롯 */}
          <SingleNamedDropzone
            slot={group.slot}
            label={group.groupLabel}
            savedAs={group.savedAs}
            accept={IMG_ACCEPT}
            hint={IMG_HINT}
            icon="I"
            iconColor="text-indigo-500"
            jobId={jobId}
            divisionCode={divisionCode}
            onUploadDone={onUploadDone}
            serverFile={findDevServerFile(fileList, group.savedAs)}
            onLog={onLog}
          />
        </div>
      ))}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 서브 컴포넌트 2-C: BioNamedUploadPanel (BIO 전용 3개 보고서 업로드 + 생성)
// ─────────────────────────────────────────────────────────────────────────────

interface BioFileConfig {
  slot:      string;
  label:     string;
  savedAs:   string;
  accept:    Record<string, string[]>;
  hint:      string;
  icon:      string;
  iconColor: string;
}

interface BioReportSection {
  /** 보고서 섹션 제목 (e.g. "1. Veeva System") */
  sectionTitle: string;
  /** 보고서 생성 API 엔드포인트 */
  endpoint:     string;
  /** 다운로드 파일명 */
  filename:     string;
  /** 업로드 파일 목록 (1개 이상) */
  files:        BioFileConfig[];
  /** 색상 테마 */
  color:        string;
}

const BIO_REPORT_SECTIONS: BioReportSection[] = [
  {
    sectionTitle: "1. Veeva System",
    endpoint:     "/report/generate-bio",
    filename:     "Bio연구본부 Veeva System Report.pdf",
    color:        "border-blue-400 text-blue-700 bg-blue-50",
    files: [
      {
        slot:      "systemusage_rd",
        label:     "System Usage (DX)",
        savedAs:   "Systemusage_RD.jpg",
        accept:    { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"] },
        hint:      "JPG / PNG 파일 1개 (.jpg / .jpeg / .png)",
        icon:      "I",
        iconColor: "text-indigo-500",
      },
    ],
  },
  {
    sectionTitle: "2. 임검분 LIMS",
    endpoint:     "/report/generate-bio-lims",
    filename:     "Bio연구본부 임검분 LIMS Report.pdf",
    color:        "border-emerald-400 text-emerald-700 bg-emerald-50",
    files: [
      {
        slot:      "lims",
        label:     "LIMS 데이터",
        savedAs:   "LIMS.xlsx",
        accept:    {
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
          "application/vnd.ms-excel": [".xls"],
          "application/zip":              [".xlsx"],
          "application/x-zip-compressed": [".xlsx"],
          "application/octet-stream":     [".xlsx", ".xls"],
        },
        hint:      "LIMS.xlsx (.xlsx / .xls)",
        icon:      "X",
        iconColor: "text-green-600",
      },
      {
        slot:      "lims_image",
        label:     "LIMS 사용 현황 이미지",
        savedAs:   "LIMS.png",
        accept:    { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"] },
        hint:      "LIMS.png (.jpg / .jpeg / .png)",
        icon:      "I",
        iconColor: "text-emerald-600",
      },
    ],
  },
  {
    sectionTitle: "3. 전자연구노트(ELN)",
    endpoint:     "/report/generate-bio-eln",
    filename:     "Bio연구본부 전자연구노트(ELN) Report.pdf",
    color:        "border-purple-400 text-purple-700 bg-purple-50",
    files: [
      {
        slot:      "eln_report",
        label:     "ELN Report",
        savedAs:   "ELN_report.xlsx",
        accept:    {
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
          "application/vnd.ms-excel": [".xls"],
          "application/zip":              [".xlsx"],
          "application/x-zip-compressed": [".xlsx"],
          "application/octet-stream":     [".xlsx", ".xls"],
        },
        hint:      "ELN_report.xlsx (.xlsx / .xls)",
        icon:      "X",
        iconColor: "text-green-600",
      },
      {
        slot:      "eln_service",
        label:     "ELN Service",
        savedAs:   "ELN_service.xlsx",
        accept:    {
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
          "application/vnd.ms-excel": [".xls"],
          "application/zip":              [".xlsx"],
          "application/x-zip-compressed": [".xlsx"],
          "application/octet-stream":     [".xlsx", ".xls"],
        },
        hint:      "ELN_service.xlsx (.xlsx / .xls)",
        icon:      "X",
        iconColor: "text-purple-600",
      },
    ],
  },
];

function BioNamedUploadPanel({
  jobId,
  divisionCode,
  onUploadDone,
  fileList,
  onLog,
}: {
  jobId:        string;
  divisionCode: string;
  onUploadDone: () => void;
  fileList:     UploadedFileRow[];
  onLog?:       (systemName: string, msg: string, kind: LogEntry["kind"]) => void;
}) {
  const { success, error: toastError } = useToast();

  // 각 섹션마다 독립적인 generating 상태
  const [generating, setGenerating] = useState<Record<string, boolean>>({});

  function prevMonth() {
    const now = new Date();
    const m   = now.getMonth() === 0 ? 12 : now.getMonth();
    const y   = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    return { y, m };
  }

  // 섹션 고유 키: endpoint URL 사용 (section.slot 이 없어졌으므로)
  async function handleGenerate(section: BioReportSection) {
    const key = section.endpoint;
    if (generating[key]) return;
    setGenerating((prev) => ({ ...prev, [key]: true }));
    onLog?.(section.sectionTitle, "PDF 보고서 생성 시작…", "info");
    try {
      const { y, m } = prevMonth();
      const mm = String(m).padStart(2, "0");
      const filename = `${y}.${mm} ${section.filename}`;
      const res = await apiClient.post(section.endpoint, { jobId }, { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: "application/pdf" }));
      const a   = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      success("보고서 PDF가 다운로드되었습니다.");
      onLog?.(section.sectionTitle, `${filename} 다운로드 완료`, "success");
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? "보고서 생성에 실패했습니다.";
      toastError(msg);
      onLog?.(section.sectionTitle, `PDF 생성 실패: ${msg}`, "error");
    } finally {
      setGenerating((prev) => ({ ...prev, [key]: false }));
    }
  }

  function findServerFile(savedAs: string): UploadedFileRow | null {
    return (
      fileList.find((f) =>
        f.original_name === savedAs ||
        (savedAs.endsWith(".jpg") &&
          f.original_name === savedAs.replace(/\.jpg$/, ".png"))
      ) ?? null
    );
  }

  return (
    <section className="space-y-5">
      {BIO_REPORT_SECTIONS.map((section) => {
        const key          = section.endpoint;
        const isGenerating = generating[key] ?? false;
        return (
          <div key={key} className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            {/* 섹션 헤더 */}
            <div className={`flex items-center justify-between px-5 py-3 border-b border-gray-200 ${section.color}`}>
              <div>
                <h3 className="text-sm font-bold">{section.sectionTitle}</h3>
              </div>
              {/* 보고서 생성 버튼 */}
              <button
                onClick={() => void handleGenerate(section)}
                disabled={isGenerating}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all
                  ${!isGenerating
                    ? "bg-secondary text-white hover:bg-secondary-600 shadow-sm"
                    : "bg-white/60 text-gray-400 cursor-not-allowed"}`}
              >
                {isGenerating ? (
                  <>
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                    생성 중…
                  </>
                ) : (
                  <>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    보고서 생성
                  </>
                )}
              </button>
            </div>
            {/* 업로드 드롭존 — files 배열의 각 파일마다 드롭존 렌더링 */}
            <div className="p-4 space-y-3">
              {section.files.map((fileConf) => (
                <SingleNamedDropzone
                  key={fileConf.slot}
                  slot={fileConf.slot}
                  label={fileConf.label}
                  savedAs={fileConf.savedAs}
                  accept={fileConf.accept}
                  hint={fileConf.hint}
                  icon={fileConf.icon}
                  iconColor={fileConf.iconColor}
                  jobId={jobId}
                  divisionCode={divisionCode}
                  onUploadDone={onUploadDone}
                  serverFile={findServerFile(fileConf.savedAs)}
                  onLog={onLog}
                />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 서브 컴포넌트 2-D: SharedTimesheetPanel (L HOUSE·Bio·Dev 3본부 공유 업로드)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Veeva MS Timesheet 공유 업로드 패널.
 *
 * ─ 공유 원리 ───────────────────────────────────────────────────────────────
 *  로컬스토리지 키 "shared_timesheet_jobId" 에 저장된 UUID 를 모든 본부 페이지가
 *  공통으로 사용합니다. 어느 페이지에서 업로드해도 동일한 jobId 아래 파일이
 *  저장되므로, 다른 본부 페이지에서도 같은 업로드 상태를 확인할 수 있습니다.
 *
 *  divisionCode 는 최초 report_jobs 행 생성 시에만 필요하며 "LHOUSE" 를 사용합니다.
 */
function SharedTimesheetPanel() {
  const [sharedJobId] = useState<string>(() => {
    const stored = localStorage.getItem(SHARED_TIMESHEET_JOB_KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(SHARED_TIMESHEET_JOB_KEY, id);
    return id;
  });

  const { data: fileList = [], refetch } = useQuery({
    queryKey:        ["timesheet-shared", sharedJobId],
    queryFn:         () =>
      apiClient
        .get<{ success: boolean; data: { files: UploadedFileRow[] } }>(`/file/list?jobId=${sharedJobId}`)
        .then((r) => r.data.data?.files ?? []),
    refetchInterval: 5_000,
  });

  const serverFile = fileList.find((f) => f.original_name === TIMESHEET_SLOT.savedAs) ?? null;

  return (
    <section className="space-y-2">
      {/* 섹션 헤더 */}
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-700">공유 파일</h2>
        <span className="inline-flex items-center gap-1 text-[10px] text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full font-medium">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
          </svg>
          L HOUSE · Bio연구본부 · 개발본부 공유
        </span>
      </div>
      <SingleNamedDropzone
        {...TIMESHEET_SLOT}
        jobId={sharedJobId}
        divisionCode="LHOUSE"
        onUploadDone={() => void refetch()}
        serverFile={serverFile}
      />
    </section>
  );
}

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  let color = "text-gray-400";
  let letter = "F";

  if (mimeType.includes("excel") || mimeType.includes("spreadsheet")) { color = "text-green-600"; letter = "X"; }
  else if (mimeType.includes("csv"))  { color = "text-blue-500";  letter = "C"; }
  else if (mimeType.includes("pdf"))  { color = "text-red-500";   letter = "P"; }
  else if (mimeType.includes("image")) { color = "text-purple-500"; letter = "I"; }

  return (
    <div className={`w-8 h-8 rounded-md bg-gray-100 flex items-center justify-center flex-shrink-0 text-xs font-bold ${color}`}>
      {letter}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 서브 컴포넌트 3: CrawlLogPanel (우측 진행 로그 패널)
// ─────────────────────────────────────────────────────────────────────────────

const LOG_KIND_STYLE: Record<LogEntry["kind"], { dot: string; text: string; icon: string }> = {
  info:    { dot: "bg-blue-400",  text: "text-gray-700",  icon: "→" },
  success: { dot: "bg-green-500", text: "text-green-700", icon: "✓" },
  error:   { dot: "bg-red-500",   text: "text-red-700",   icon: "✕" },
  warn:    { dot: "bg-amber-400", text: "text-amber-700", icon: "!" },
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function CrawlLogPanel({ logs, isConnected }: { logs: LogEntry[]; isConnected: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  // 새 로그 추가 시 패널 내부만 스크롤 (페이지 스크롤 방지)
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <aside className="w-72 flex-shrink-0 flex flex-col bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden sticky top-0 self-start max-h-[calc(100vh-200px)]">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isConnected ? "bg-green-500 animate-pulse" : "bg-gray-300"}`} />
          <h3 className="text-xs font-semibold text-gray-700 tracking-wide">진행 로그</h3>
        </div>
        <span className="text-[10px] text-gray-400">{logs.length}건</span>
      </div>

      {/* 로그 목록 */}
      <div ref={containerRef} className="flex-1 overflow-y-auto min-h-0 p-3 space-y-1.5">
        {logs.length === 0 ? (
          <p className="text-[11px] text-gray-300 text-center pt-8">
            파일 업로드 또는 보고서 생성 시<br />진행 상황이 표시됩니다.
          </p>
        ) : (
          logs.map((log, i) => {
            const style = LOG_KIND_STYLE[log.kind];
            return (
              <div key={i} className="flex items-start gap-2 group">
                {/* 시간 */}
                <span className="text-[10px] text-gray-300 tabular-nums flex-shrink-0 pt-0.5 w-14">
                  {fmtTime(log.time)}
                </span>
                {/* 아이콘 */}
                <span className={`text-[10px] font-bold flex-shrink-0 pt-0.5 w-3 ${style.text}`}>
                  {style.icon}
                </span>
                {/* 메시지 */}
                <div className="flex-1 min-w-0">
                  <p className={`text-[11px] leading-relaxed break-words ${style.text}`}>
                    {log.message}
                  </p>
                  <p className="text-[10px] text-gray-300">{log.systemName}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 서브 컴포넌트 4: DataPreviewPanel (슬라이드 사이드 패널)
// ─────────────────────────────────────────────────────────────────────────────

function DataPreviewPanel({
  open,
  onClose,
  systemCode,
  systemLabel,
  task,
}: {
  open:        boolean;
  onClose:     () => void;
  systemCode:  string;
  systemLabel: string;
  task:        TaskState | null;
}) {
  return (
    <>
      {/* 오버레이 */}
      <div
        className={`fixed inset-0 bg-black/30 z-40 transition-opacity duration-200
          ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />

      {/* 패널 */}
      <aside
        className={`fixed right-0 top-0 h-full w-96 max-w-[90vw] bg-white shadow-2xl z-50
          flex flex-col transition-transform duration-300 ease-in-out
          ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-primary">
          <div>
            <p className="text-white/60 text-[11px] font-semibold tracking-widest uppercase">{systemCode}</p>
            <h3 className="text-white text-sm font-bold">{systemLabel} 수집 결과</h3>
          </div>
          <button
            onClick={onClose}
            className="text-white/60 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 본문 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {!task ? (
            <p className="text-sm text-gray-400 text-center py-12">데이터 없음</p>
          ) : (
            <>
              {/* 상태 요약 */}
              <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                <InfoRow label="수집 상태">
                  <StatusBadge status={task.status} />
                </InfoRow>
                <InfoRow label="마지막 수집">
                  <span className="text-xs text-gray-700">{fmtDatetime(task.updatedAt)}</span>
                </InfoRow>
                {task.filePaths.length > 0 && (
                  <InfoRow label="수집 파일">
                    <span className="text-xs text-gray-700">{task.filePaths.length}개</span>
                  </InfoRow>
                )}
              </div>

              {/* 오류 */}
              {task.error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-xs font-semibold text-red-600 mb-1">오류 내용</p>
                  <p className="text-xs text-red-700 break-words">{task.error}</p>
                </div>
              )}

              {/* 스크린샷 */}
              {task.screenshot && (
                <div>
                  <p className="text-xs font-semibold text-gray-600 mb-2">스크린샷</p>
                  <div className="bg-gray-100 rounded-lg p-2">
                    <img
                      src={toUploadUrl(task.screenshot.path)}
                      alt={`${systemLabel} 스크린샷`}
                      className="w-full rounded object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    <p className="text-[11px] text-gray-400 mt-1 text-right">
                      {task.screenshot.width}×{task.screenshot.height}px ·{" "}
                      {fmtDatetime(task.screenshot.capturedAt)}
                    </p>
                  </div>
                </div>
              )}

              {/* 수집 파일 경로 목록 */}
              {task.filePaths.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-600 mb-2">수집된 파일</p>
                  <ul className="space-y-1">
                    {task.filePaths.map((fp) => (
                      <li key={fp} className="text-[11px] text-gray-500 bg-gray-50 rounded px-2 py-1 truncate" title={fp}>
                        {fp.split("/").pop()}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {task.status === "COMPLETED" && (
                <p className="text-[11px] text-gray-400 bg-blue-50 rounded px-3 py-2">
                  전체 분석 내용은 PDF 보고서에서 확인할 수 있습니다.
                </p>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-gray-500 font-medium">{label}</span>
      <div>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 메인 컴포넌트
// ─────────────────────────────────────────────────────────────────────────────

export function DivisionReportPage({
  divisionCode,
  divisionName,
  systems,
  sideLayout = false,
}: DivisionReportPageProps) {
  const { user }       = useAuth();
  const navigate       = useNavigate();
  const queryClient    = useQueryClient();
  const { success, error: toastError } = useToast();

  // ── jobId: localStorage에서 복원하거나 새로 생성 (새로고침 후에도 유지) ────────
  const JOB_STORAGE_KEY = `report_jobId_${divisionCode}`;
  const [jobId] = useState<string>(() => {
    const stored = localStorage.getItem(JOB_STORAGE_KEY);
    if (stored) return stored;
    const newId = crypto.randomUUID();
    localStorage.setItem(JOB_STORAGE_KEY, newId);
    return newId;
  });

  // ── 크롤 활성 상태 (버튼 클릭 후 SSE 연결) ──────────────────────────────────
  const [crawlActive, setCrawlActive] = useState(false);

  // ── LHOUSE VEEVA 전용: 대시보드 캡처 상태 (시스템 조회와 독립) ─────────────────
  const [dashboardCapturing, setDashboardCapturing] = useState(false);
  const [dashboardActive,    setDashboardActive]    = useState(false);

  // ── DEV GCP 전용: 대시보드 캡처 상태 ──────────────────────────────────────────
  const [gcpDashboardCapturing, setGcpDashboardCapturing] = useState(false);
  const [gcpDashboardActive,    setGcpDashboardActive]    = useState(false);

  // ── DEV Medcomms 전용: 대시보드 캡처 상태 ─────────────────────────────────────
  const [medcommsDashboardCapturing, setMedcommsDashboardCapturing] = useState(false);
  const [medcommsDashboardActive,    setMedcommsDashboardActive]    = useState(false);

  // ── DEV Clinical(CTMS) 전용: 대시보드 캡처 상태 ───────────────────────────────
  const [clinicalDashboardCapturing, setClinicalDashboardCapturing] = useState(false);
  const [clinicalDashboardActive,    setClinicalDashboardActive]    = useState(false);

  // ── SSE ──────────────────────────────────────────────────────────────────────
  const systemCodes = systems.map((s) => s.code);
  const sse = useCrawlSSE(jobId, systemCodes, crawlActive || dashboardActive || gcpDashboardActive || medcommsDashboardActive || clinicalDashboardActive);

  // ── 로컬 진행 로그 (업로드·PDF생성 이벤트) ────────────────────────────────────
  const [localLogs, setLocalLogs] = useState<LogEntry[]>([]);

  const addLocalLog = useCallback(
    (systemName: string, msg: string, kind: LogEntry["kind"] = "info") => {
      setLocalLogs((prev) => [
        ...prev,
        { time: new Date().toISOString(), systemName, message: msg, kind },
      ]);
    },
    []
  );

  // SSE 로그와 로컬 로그를 시간순으로 합산
  const allLogs = [...sse.logs, ...localLogs].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );

  // ── 미리보기 패널 상태 ────────────────────────────────────────────────────────
  const [previewCode, setPreviewCode] = useState<string | null>(null);
  const previewSystem = systems.find((s) => s.code === previewCode) ?? null;

  // ── 크롤 시작 뮤테이션 ────────────────────────────────────────────────────────
  const startCrawl = useMutation({
    mutationFn: () =>
      apiClient.post("/crawl/start", {
        divisionCode,
        jobId,
        userId: user?.id,
      }),
    onSuccess: () => {
      setCrawlActive(true);
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? "수집 시작에 실패했습니다.";
      toastError(msg);
    },
  });

  // ── LHOUSE 전용: Veeva 대시보드 캡처 ─────────────────────────────────────────
  const handleDashboardCapture = useCallback(async () => {
    if (dashboardCapturing) return;
    sse.resetTask("VEEVA_DASHBOARD");
    setDashboardCapturing(true);
    setDashboardActive(true);
    addLocalLog("VEEVA Dashboard", "대시보드 캡처 시작 (로그인 중…)", "info");
    try {
      await apiClient.post("/crawl/veeva-dashboard", {
        jobId,
        userId: user?.id,
      });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? "대시보드 캡처 요청에 실패했습니다.";
      toastError(msg);
      addLocalLog("VEEVA Dashboard", `캡처 요청 실패: ${msg}`, "error");
      setDashboardCapturing(false);
      setDashboardActive(false);
    }
  }, [dashboardCapturing, addLocalLog, jobId, user, toastError]); // eslint-disable-line react-hooks/exhaustive-deps

  // VEEVA_DASHBOARD 태스크 완료/실패 시 dashboardCapturing · dashboardActive 해제
  useEffect(() => {
    if (!dashboardCapturing) return;
    const dashTask = sse.taskMap["VEEVA_DASHBOARD"];
    if (dashTask?.status === "COMPLETED" || dashTask?.status === "FAILED") {
      setDashboardCapturing(false);
      setDashboardActive(false);
      if (dashTask.status === "COMPLETED") {
        addLocalLog("VEEVA Dashboard", "대시보드 캡처 완료 — 이미지 다운로드 버튼을 확인하세요.", "success");
      }
    }
  }, [sse.taskMap, dashboardCapturing, addLocalLog]);

  // ── DEV GCP 전용: GCP Quality System 대시보드 캡처 ───────────────────────────
  const handleGcpDashboardCapture = useCallback(async () => {
    if (gcpDashboardCapturing) return;
    sse.resetTask("GCP_DASHBOARD");
    setGcpDashboardCapturing(true);
    setGcpDashboardActive(true);
    addLocalLog("GCP Dashboard", "GCP 대시보드 캡처 시작 (로그인 중…)", "info");
    try {
      await apiClient.post("/crawl/gcp-dashboard", {
        jobId,
        userId: user?.id,
      });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? "GCP 대시보드 캡처 요청에 실패했습니다.";
      toastError(msg);
      addLocalLog("GCP Dashboard", `캡처 요청 실패: ${msg}`, "error");
      setGcpDashboardCapturing(false);
      setGcpDashboardActive(false);
    }
  }, [gcpDashboardCapturing, addLocalLog, jobId, user, toastError]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── DEV Medcomms 전용: Medcomms 대시보드 캡처 ─────────────────────────────────
  const handleMedcommsDashboardCapture = useCallback(async () => {
    if (medcommsDashboardCapturing) return;
    sse.resetTask("MEDCOMMS_DASHBOARD");
    setMedcommsDashboardCapturing(true);
    setMedcommsDashboardActive(true);
    addLocalLog("Medcomms Dashboard", "Medcomms 대시보드 캡처 시작 (로그인 중…)", "info");
    try {
      await apiClient.post("/crawl/medcomms-dashboard", {
        jobId,
        userId: user?.id,
      });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? "Medcomms 대시보드 캡처 요청에 실패했습니다.";
      toastError(msg);
      addLocalLog("Medcomms Dashboard", `캡처 요청 실패: ${msg}`, "error");
      setMedcommsDashboardCapturing(false);
      setMedcommsDashboardActive(false);
    }
  }, [medcommsDashboardCapturing, addLocalLog, jobId, user, toastError]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── DEV Clinical(CTMS) 전용: Clinical 대시보드 캡처 ───────────────────────────
  const handleClinicalDashboardCapture = useCallback(async () => {
    if (clinicalDashboardCapturing) return;
    sse.resetTask("CLINICAL_DASHBOARD");
    setClinicalDashboardCapturing(true);
    setClinicalDashboardActive(true);
    addLocalLog("Clinical Dashboard", "Clinical 대시보드 캡처 시작 (로그인 중…)", "info");
    try {
      await apiClient.post("/crawl/clinical-dashboard", {
        jobId,
        userId: user?.id,
      });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? "Clinical 대시보드 캡처 요청에 실패했습니다.";
      toastError(msg);
      addLocalLog("Clinical Dashboard", `캡처 요청 실패: ${msg}`, "error");
      setClinicalDashboardCapturing(false);
      setClinicalDashboardActive(false);
    }
  }, [clinicalDashboardCapturing, addLocalLog, jobId, user, toastError]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── PDF 생성 뮤테이션 (BIO / DEV 공용) ──────────────────────────────────────
  const generatePdf = useMutation({
    mutationFn: () =>
      apiClient.post("/report/generate", { divisionCode, jobId }),
    onMutate:  () => { /* PDF 생성 시작 — 별도 로그 없음 */ },
    onSuccess: () => {
      success("PDF 생성 요청이 접수되었습니다. 완료 시 알림이 표시됩니다.");
      void queryClient.invalidateQueries({ queryKey: ["report", "history"] });
      navigate("/report/generate", { state: { jobId, divisionCode } });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? "PDF 생성에 실패했습니다.";
      toastError(msg);
    },
  });

  // ── LHOUSE 전용: 업로드 파일 목록 조회 (5초 폴링) ────────────────────────────
  const { data: lhouseFileList = [], refetch: refetchLhouseFiles } = useQuery({
    queryKey:        ["files", jobId],
    queryFn:         () =>
      apiClient
        .get<{ success: boolean; data: { files: UploadedFileRow[] } }>(`/file/list?jobId=${jobId}`)
        .then((r) => r.data.data?.files ?? []),
    enabled:         divisionCode === "LHOUSE",
    refetchInterval: 5_000,
  });

  // ── DEV 전용: 업로드 파일 목록 조회 (5초 폴링) ───────────────────────────────
  const { data: devFileList = [], refetch: refetchDevFiles } = useQuery({
    queryKey:        ["files", jobId, "dev"],
    queryFn:         () =>
      apiClient
        .get<{ success: boolean; data: { files: UploadedFileRow[] } }>(`/file/list?jobId=${jobId}`)
        .then((r) => r.data.data?.files ?? []),
    enabled:         divisionCode === "DEV",
    refetchInterval: 5_000,
  });

  // GCP_DASHBOARD 태스크 완료/실패 시 상태 해제 + 파일 목록 즉시 갱신
  useEffect(() => {
    if (!gcpDashboardCapturing) return;
    const gcpTask = sse.taskMap["GCP_DASHBOARD"];
    if (gcpTask?.status === "COMPLETED" || gcpTask?.status === "FAILED") {
      setGcpDashboardCapturing(false);
      setGcpDashboardActive(false);
      if (gcpTask.status === "COMPLETED") {
        addLocalLog("GCP Dashboard", "대시보드 캡처 완료 — Systemusage_GCP.png 로 저장되었습니다.", "success");
        void refetchDevFiles();
      }
    }
  }, [sse.taskMap, gcpDashboardCapturing, addLocalLog, refetchDevFiles]);

  // MEDCOMMS_DASHBOARD 태스크 완료/실패 시 상태 해제 + 파일 목록 즉시 갱신
  useEffect(() => {
    if (!medcommsDashboardCapturing) return;
    const medcommsTask = sse.taskMap["MEDCOMMS_DASHBOARD"];
    if (medcommsTask?.status === "COMPLETED" || medcommsTask?.status === "FAILED") {
      setMedcommsDashboardCapturing(false);
      setMedcommsDashboardActive(false);
      if (medcommsTask.status === "COMPLETED") {
        addLocalLog("Medcomms Dashboard", "대시보드 캡처 완료 — Systemusage_Medcomms.png 로 저장되었습니다.", "success");
        void refetchDevFiles();
      }
    }
  }, [sse.taskMap, medcommsDashboardCapturing, addLocalLog, refetchDevFiles]);

  // CLINICAL_DASHBOARD 태스크 완료/실패 시 상태 해제 + 파일 목록 즉시 갱신
  useEffect(() => {
    if (!clinicalDashboardCapturing) return;
    const clinicalTask = sse.taskMap["CLINICAL_DASHBOARD"];
    if (clinicalTask?.status === "COMPLETED" || clinicalTask?.status === "FAILED") {
      setClinicalDashboardCapturing(false);
      setClinicalDashboardActive(false);
      if (clinicalTask.status === "COMPLETED") {
        addLocalLog("Clinical Dashboard", "대시보드 캡처 완료 — Systemusage_Clinical1.png / Systemusage_Clinical2.png 로 저장되었습니다.", "success");
        void refetchDevFiles();
      }
    }
  }, [sse.taskMap, clinicalDashboardCapturing, addLocalLog, refetchDevFiles]);

  // ── BIO 전용: 업로드 파일 목록 조회 (5초 폴링) ───────────────────────────────
  const { data: bioFileList = [], refetch: refetchBioFiles } = useQuery({
    queryKey:        ["files", jobId, "bio"],
    queryFn:         () =>
      apiClient
        .get<{ success: boolean; data: { files: UploadedFileRow[] } }>(`/file/list?jobId=${jobId}`)
        .then((r) => r.data.data?.files ?? []),
    enabled:         divisionCode === "BIO",
    refetchInterval: 5_000,
  });

  const hasActivityFile      = lhouseFileList.some((f) => f.original_name === "Activity_LHOUSE.xlsx");
  const hasSystemusageFile   = lhouseFileList.some(
    (f) => f.original_name === "Systemusage_LHOUSE.jpg" || f.original_name === "Systemusage_LHOUSE.png"
  );
  const canGenerateLhousePdf = hasActivityFile && hasSystemusageFile;

  // ── 직접 다운로드 공통 헬퍼 ──────────────────────────────────────────────────
  function prevMonth() {
    const now = new Date();
    const m   = now.getMonth() === 0 ? 12 : now.getMonth();
    const y   = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    return { y, m };
  }

  async function downloadPdfBlob(endpoint: string, filename: string): Promise<void> {
    let res;
    try {
      res = await apiClient.post(endpoint, { jobId }, { responseType: "blob" });
    } catch (err: unknown) {
      // responseType:"blob" 이면 에러 응답 바디도 Blob → JSON 으로 파싱해서 재throw
      const axiosErr = err as { response?: { data?: unknown } };
      if (axiosErr?.response?.data instanceof Blob) {
        try {
          const text = await (axiosErr.response.data as Blob).text();
          const json = JSON.parse(text) as { error?: string };
          (axiosErr.response as Record<string, unknown>).data = json;
        } catch { /* JSON 파싱 실패 시 원본 오류 유지 */ }
      }
      throw err;
    }
    const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: "application/pdf" }));
    const a   = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ── LHOUSE 전용: 보고서 생성 (직접 다운로드) ─────────────────────────────────
  const [lhouseGenerating, setLhouseGenerating] = useState(false);

  const handleLhouseGenerate = useCallback(async () => {
    if (!canGenerateLhousePdf || lhouseGenerating) return;
    setLhouseGenerating(true);
    addLocalLog("보고서", "PDF 보고서 생성 시작…", "info");
    try {
      const { y, m } = prevMonth();
      const filename = `${y}.${String(m).padStart(2, "0")} L HOUSE Veeva System Report.pdf`;
      await downloadPdfBlob("/report/generate-lhouse", filename);
      success("보고서 PDF가 다운로드되었습니다.");
      addLocalLog("보고서", `${filename} 다운로드 완료`, "success");
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? "보고서 생성에 실패했습니다.";
      toastError(msg);
      addLocalLog("보고서", `PDF 생성 실패: ${msg}`, "error");
    } finally {
      setLhouseGenerating(false);
    }
  }, [canGenerateLhousePdf, lhouseGenerating, addLocalLog, jobId, success, toastError]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── DEV 전용: 보고서 생성 (직접 다운로드) ────────────────────────────────────
  const [devGenerating, setDevGenerating] = useState(false);

  const handleDevGenerate = useCallback(async () => {
    if (devGenerating) return;
    setDevGenerating(true);
    addLocalLog("보고서", "PDF 보고서 생성 시작…", "info");
    try {
      const { y, m } = prevMonth();
      const filename = `${y}.${String(m).padStart(2, "0")} 개발본부 시스템 운영 현황 Report.pdf`;
      await downloadPdfBlob("/report/generate-dev", filename);
      success("보고서 PDF가 다운로드되었습니다.");
      addLocalLog("보고서", `${filename} 다운로드 완료`, "success");
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? "보고서 생성에 실패했습니다.";
      toastError(msg);
      addLocalLog("보고서", `PDF 생성 실패: ${msg}`, "error");
    } finally {
      setDevGenerating(false);
    }
  }, [devGenerating, addLocalLog, jobId, success, toastError]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 진행 현황 집계 ────────────────────────────────────────────────────────────
  const totalCount     = systems.length;
  const completedCount = Object.values(sse.taskMap).filter((t) => t.status === "COMPLETED").length;
  const failedCount    = Object.values(sse.taskMap).filter((t) => t.status === "FAILED").length;
  const overallPct     = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const canStartCrawl  = !crawlActive && sse.phase === "idle" && !startCrawl.isPending;
  const canGeneratePdf = sse.phase === "done" && !generatePdf.isPending;

  // 수집 미완료 시스템 목록 (PDF 생성 전 경고용)
  const unfinishedSystems = systems.filter((s) => {
    const task = sse.taskMap[s.code];
    return !task || task.status !== "COMPLETED";
  });

  // ── 렌더 ──────────────────────────────────────────────────────────────────────
  return (
    <AppLayout title={divisionName} scroll={false}>
      <div className="h-full flex flex-col overflow-hidden">

      {/* ── 고정 영역: 페이지 헤더 + 진행률 바 ── */}
      <div className="flex-shrink-0 px-6 pt-5 pb-4 bg-gray-50 border-b border-gray-200/60">
        <div className="max-w-screen-xl mx-auto">

      {/* ── 1. 페이지 헤더 ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-primary">{divisionName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {systems.map((s) => s.label).join(" · ")} — {systems.length}개 시스템
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* 연결 상태 인디케이터 */}
          {crawlActive && (
            <span className="flex items-center gap-1.5 text-xs text-secondary font-medium">
              <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
              {sse.isConnected ? "실시간 수집 중" : "연결 중…"}
            </span>
          )}

          {divisionCode === "LHOUSE" ? (
            /* LHOUSE: 업로드된 파일로 보고서 생성 */
            <button
              onClick={() => void handleLhouseGenerate()}
              disabled={!canGenerateLhousePdf || lhouseGenerating}
              title={
                !hasActivityFile    ? "Activity_LHOUSE.xlsx 를 업로드해야 합니다." :
                !hasSystemusageFile ? "대시보드 캡처를 먼저 수행해야 합니다." :
                ""
              }
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all
                ${canGenerateLhousePdf && !lhouseGenerating
                  ? "bg-secondary text-white hover:bg-secondary-600 shadow-sm"
                  : "bg-gray-100 text-gray-400 cursor-not-allowed"}`}
            >
              {lhouseGenerating ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              )}
              {lhouseGenerating ? "생성 중…" : "보고서 생성"}
            </button>
          ) : divisionCode === "DEV" ? (
            /* DEV: 업로드된 파일로 보고서 생성 */
            <button
              onClick={() => void handleDevGenerate()}
              disabled={devGenerating}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all
                ${!devGenerating
                  ? "bg-secondary text-white hover:bg-secondary-600 shadow-sm"
                  : "bg-gray-100 text-gray-400 cursor-not-allowed"}`}
            >
              {devGenerating ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              )}
              {devGenerating ? "생성 중…" : "보고서 생성"}
            </button>
          ) : null}
        </div>
      </div>

      {/* ── 전체 진행률 바 (수집 중에만 표시) ── */}
      {crawlActive && sse.phase !== "idle" && (
        <div className="mb-5 bg-white rounded-xl border border-gray-200 px-5 py-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-gray-600">전체 수집 진행률</p>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              {completedCount > 0 && <span className="text-green-600 font-medium">완료 {completedCount}</span>}
              {failedCount > 0    && <span className="text-red-500  font-medium">실패 {failedCount}</span>}
              <span>{totalCount}개 시스템</span>
            </div>
          </div>
          <ProgressBar
            value={overallPct}
            variant={sse.phase === "error" ? "danger" : sse.phase === "done" ? "success" : "default"}
            size="lg"
            showPercent
          />
          {sse.globalError && (
            <p className="text-xs text-red-500 mt-2">{sse.globalError}</p>
          )}
        </div>
      )}
        </div>{/* end max-w */}
      </div>{/* end 고정 영역 */}

      {/* ── 스크롤 영역: 메인 콘텐츠 + 로그 패널 ── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-6 pt-4 pb-6 max-w-screen-xl mx-auto">
          <div className="flex gap-5 items-start">
          {/* ── 좌측: 메인 콘텐츠 ── */}
          <div className="flex-1 min-w-0">

      {/* ── 2 + 3. 시스템 카드 + 파일 업로드 (sideLayout 이면 좌우 분할) ── */}
      {sideLayout ? (
        <div className="flex gap-5 mb-6 items-start">
          {/* 좌: 시스템별 수집 상태 */}
          <section className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">시스템별 수집 상태</h2>
            <div className="flex flex-col gap-4">
              {systems.map((sys) => (
                <SystemCard
                  key={sys.code}
                  config={sys}
                  task={sse.taskMap[sys.code] ?? {
                    status: "PENDING", progress: 0, error: null,
                    updatedAt: null, screenshot: null, filePaths: [],
                  }}
                  onPreview={setPreviewCode}
                  onCrawl={divisionCode === "LHOUSE" || divisionCode === "DEV" ? () => startCrawl.mutate() : undefined}
                  crawlActive={crawlActive || startCrawl.isPending}
                  onDashboardCapture={
                    (divisionCode === "LHOUSE" && sys.code === "VEEVA")         ? handleDashboardCapture :
                    (divisionCode === "DEV"    && sys.code === "GCP_QUALITY")   ? handleGcpDashboardCapture :
                    (divisionCode === "DEV"    && sys.code === "MEDCOMMS")      ? handleMedcommsDashboardCapture :
                    (divisionCode === "DEV"    && sys.code === "CTMS")          ? handleClinicalDashboardCapture :
                    undefined
                  }
                  dashboardCapturing={
                    (divisionCode === "LHOUSE" && sys.code === "VEEVA")         ? dashboardCapturing :
                    (divisionCode === "DEV"    && sys.code === "GCP_QUALITY")   ? gcpDashboardCapturing :
                    (divisionCode === "DEV"    && sys.code === "MEDCOMMS")      ? medcommsDashboardCapturing :
                    (divisionCode === "DEV"    && sys.code === "CTMS")          ? clinicalDashboardCapturing :
                    undefined
                  }
                  dashboardTask={
                    (divisionCode === "LHOUSE" && sys.code === "VEEVA")         ? (sse.taskMap["VEEVA_DASHBOARD"]    ?? null) :
                    (divisionCode === "DEV"    && sys.code === "GCP_QUALITY")   ? (sse.taskMap["GCP_DASHBOARD"]      ?? null) :
                    (divisionCode === "DEV"    && sys.code === "MEDCOMMS")      ? (sse.taskMap["MEDCOMMS_DASHBOARD"] ?? null) :
                    (divisionCode === "DEV"    && sys.code === "CTMS")          ? (sse.taskMap["CLINICAL_DASHBOARD"] ?? null) :
                    undefined
                  }
                />
              ))}
            </div>
          </section>

          {/* 우: 파일 업로드 */}
          <div className="w-[420px] flex-shrink-0 space-y-4">
            {divisionCode === "LHOUSE" ? (
              <LhouseNamedUploadPanel
                jobId={jobId}
                divisionCode={divisionCode}
                fileList={lhouseFileList}
                onUploadDone={() => void refetchLhouseFiles()}
                onLog={addLocalLog}
              />
            ) : divisionCode === "DEV" ? (
              <DevNamedUploadPanel
                jobId={jobId}
                divisionCode={divisionCode}
                fileList={devFileList}
                onUploadDone={() => void refetchDevFiles()}
                onLog={addLocalLog}
              />
            ) : divisionCode === "BIO" ? (
              <BioNamedUploadPanel
                jobId={jobId}
                divisionCode={divisionCode}
                fileList={bioFileList}
                onUploadDone={() => void refetchBioFiles()}
                onLog={addLocalLog}
              />
            ) : (
              <FileDropzonePanel
                jobId={jobId}
                divisionCode={divisionCode}
                onUploadDone={() => void queryClient.invalidateQueries({ queryKey: ["files", jobId] })}
                onLog={addLocalLog}
              />
            )}
            <SharedTimesheetPanel />
          </div>
        </div>
      ) : (
        <>
          {/* 기본: 위아래 배치 */}
          <section className="mb-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">시스템별 수집 상태</h2>
            <div className={`grid gap-4 ${
              systems.length === 1 ? "grid-cols-1" :
              systems.length === 2 ? "grid-cols-1 sm:grid-cols-2" :
                                     "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
            }`}>
              {systems.map((sys) => (
                <SystemCard
                  key={sys.code}
                  config={sys}
                  task={sse.taskMap[sys.code] ?? {
                    status: "PENDING", progress: 0, error: null,
                    updatedAt: null, screenshot: null, filePaths: [],
                  }}
                  onPreview={setPreviewCode}
                />
              ))}
            </div>
          </section>

          <div className="mb-6">
            {divisionCode === "LHOUSE" ? (
              <LhouseNamedUploadPanel
                jobId={jobId}
                divisionCode={divisionCode}
                fileList={lhouseFileList}
                onUploadDone={() => void refetchLhouseFiles()}
                onLog={addLocalLog}
              />
            ) : divisionCode === "DEV" ? (
              <DevNamedUploadPanel
                jobId={jobId}
                divisionCode={divisionCode}
                fileList={devFileList}
                onUploadDone={() => void refetchDevFiles()}
                onLog={addLocalLog}
              />
            ) : divisionCode === "BIO" ? (
              <BioNamedUploadPanel
                jobId={jobId}
                divisionCode={divisionCode}
                fileList={bioFileList}
                onUploadDone={() => void refetchBioFiles()}
                onLog={addLocalLog}
              />
            ) : (
              <FileDropzonePanel
                jobId={jobId}
                divisionCode={divisionCode}
                onUploadDone={() => void queryClient.invalidateQueries({ queryKey: ["files", jobId] })}
                onLog={addLocalLog}
              />
            )}
          </div>

          {/* 공유 타임시트 — 세 본부 모두 표시 */}
          <div className="mb-6">
            <SharedTimesheetPanel />
          </div>
        </>
      )}

      {/* ── 5. 하단 액션 바 ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-gray-700">
              {sse.phase === "done"
                ? "수집 완료 — 보고서를 생성하거나 메일을 작성하세요."
                : sse.phase === "crawling"
                ? "데이터 수집 중입니다…"
                : "보고서 생성 버튼을 눌러 데이터 수집을 시작하세요."}
            </p>
            {sse.pdfReady && sse.pdfInfo && (
              <div className="flex items-center gap-3 mt-0.5">
                <p className="text-xs text-green-600">
                  PDF 생성 완료 — {sse.pdfInfo.pageCount}페이지,{" "}
                  {fmtBytes(sse.pdfInfo.fileSize)}
                </p>
                <a
                  href={`/api/report/${jobId}/download`}
                  download
                  onClick={() => {
                    // 다운로드 후 새 사이클을 위해 jobId 초기화
                    const newId = crypto.randomUUID();
                    localStorage.setItem(JOB_STORAGE_KEY, newId);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold bg-green-600 text-white hover:bg-green-700 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  PDF 다운로드
                </a>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* PDF 생성 */}
            <button
              onClick={() => {
                if (unfinishedSystems.length > 0) {
                  toastError(
                    `수집이 완료되지 않은 시스템이 있습니다: ${unfinishedSystems.map((s) => s.label).join(", ")}`
                  );
                  return;
                }
                generatePdf.mutate();
              }}
              disabled={!canGeneratePdf}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all
                ${canGeneratePdf
                  ? "bg-secondary text-white hover:bg-secondary-600 shadow-sm"
                  : "bg-gray-100 text-gray-400 cursor-not-allowed"}`}
            >
              {generatePdf.isPending ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              )}
              PDF 생성
            </button>

            {/* 메일 작성 */}
            <button
              onClick={() => navigate("/mail/compose", { state: { jobId, divisionCode } })}
              disabled={sse.phase === "idle"}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border transition-all
                ${sse.phase !== "idle"
                  ? "border-secondary text-secondary hover:bg-secondary/5"
                  : "border-gray-200 text-gray-400 cursor-not-allowed"}`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              메일 작성
            </button>
          </div>
        </div>
      </div>

          </div>{/* end 좌측 콘텐츠 */}

          {/* ── 우측: 진행 로그 패널 (항상 표시) ── */}
          <CrawlLogPanel
            logs={allLogs}
            isConnected={sse.isConnected || lhouseGenerating || devGenerating}
          />

          </div>{/* end 2열 flex */}
        </div>{/* end max-w */}
      </div>{/* end 스크롤 영역 */}
      </div>{/* end h-full flex-col */}

      {/* ── 5. 데이터 미리보기 슬라이드 패널 ── */}
      <DataPreviewPanel
        open={!!previewCode}
        onClose={() => setPreviewCode(null)}
        systemCode={previewCode ?? ""}
        systemLabel={previewSystem?.label ?? ""}
        task={previewCode ? (sse.taskMap[previewCode] ?? null) : null}
      />
    </AppLayout>
  );
}
