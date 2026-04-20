/**
 * DashboardPage
 *
 * ─ 레이아웃 ──────────────────────────────────────────────────────────────────
 *  [요약 카드 ×3]  — 본부별 최근 보고서 생성일 + 상태
 *  [생성 이력 테이블] — DataTable (본부 / 생성일 / 상태 / 시스템 수 / 다운로드)
 *  [빠른 실행 버튼 ×3] — BIO / DEV / LHOUSE 즉시 생성
 *
 * ─ 데이터 ────────────────────────────────────────────────────────────────────
 *  GET /api/report/history  (refetchInterval 30초)
 */

import { useState }                          from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate }                        from "react-router-dom";
import { apiClient }                          from "../api/client";
import { useAuth }                            from "../hooks/useAuth";
import {
  AppLayout,
  StatusBadge,
  DataTable,
  LoadingSpinner,
  useToast,
  type Column,
}                                             from "../components/common";
import type { PaginatedResponse }             from "@skbs/shared";

// ── 타입 ──────────────────────────────────────────────────────────────────────

interface ReportHistoryItem {
  id:            string;
  status:        string;
  pdf_path:      string | null;
  error_message: string | null;
  started_at:    string | null;
  completed_at:  string | null;
  created_at:    string;
  division_code: "BIO" | "DEV" | "LHOUSE";
  division_name: string;
}

type ApiHistory = PaginatedResponse<ReportHistoryItem>;

// ── 상수 ──────────────────────────────────────────────────────────────────────

const DIVISIONS = [
  { code: "BIO"   , name: "Bio연구본부",   systemCount: 3, color: "from-secondary to-secondary-700" },
  { code: "DEV"   , name: "개발본부",      systemCount: 6, color: "from-primary  to-primary-700"   },
  { code: "LHOUSE", name: "L HOUSE 공장", systemCount: 3, color: "from-teal-600 to-teal-800"       },
] as const;

type DivisionCode = (typeof DIVISIONS)[number]["code"];

const SYSTEM_COUNT: Record<DivisionCode, number> = {
  BIO:    3,
  DEV:    6,
  LHOUSE: 3,
};

// ── 날짜 포매터 ───────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDateShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

// ── PDF 다운로드 헬퍼 (apiClient → Blob → <a> 클릭) ───────────────────────────

async function downloadPdf(jobId: string, divisionCode: string) {
  const res = await apiClient.get<Blob>(`/report/${jobId}/download`, {
    responseType: "blob",
  });
  const url = URL.createObjectURL(res.data);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = `SKBS_${divisionCode}_Report_${jobId}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── 요약 카드 ─────────────────────────────────────────────────────────────────

function SummaryCard({
  division,
  latest,
}: {
  division: (typeof DIVISIONS)[number];
  latest:   ReportHistoryItem | undefined;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* 컬러 헤더 */}
      <div className={`bg-gradient-to-r ${division.color} px-5 py-5`}>
        <h3 className="text-white text-base font-bold">{division.name}</h3>
      </div>

      {/* 본문 */}
      <div className="px-5 py-4 space-y-3">
        {latest ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">최근 상태</span>
              <StatusBadge status={latest.status} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">생성일</span>
              <span className="text-xs font-medium text-gray-700">
                {fmtDateShort(latest.created_at)}
              </span>
            </div>
            {latest.error_message && (
              <p className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1 truncate" title={latest.error_message}>
                {latest.error_message}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-gray-400 text-center py-2">생성 이력 없음</p>
        )}

        <div className="flex items-center justify-between pt-1 border-t border-gray-100">
          <span className="text-[11px] text-gray-400">포함 시스템</span>
          <span className="text-[11px] font-semibold text-gray-600">
            {division.systemCount}개
          </span>
        </div>
      </div>
    </div>
  );
}

// ── 빠른 실행 버튼 ────────────────────────────────────────────────────────────

const QUICK_ICONS: Record<DivisionCode, JSX.Element> = {
  BIO: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  ),
  DEV: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
    </svg>
  ),
  LHOUSE: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  ),
};

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { user }       = useAuth();
  const { success, error: toastError } = useToast();
  const queryClient    = useQueryClient();
  const navigate       = useNavigate();

  // 어떤 본부가 "생성 중"인지 추적 (중복 클릭 방지)
  const [generatingCode, setGeneratingCode] = useState<DivisionCode | null>(null);

  // ── 이력 조회 (30초 자동 갱신) ──────────────────────────────────────────────
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["report", "history"],
    queryFn:  () =>
      apiClient
        .get<ApiHistory>("/report/history?limit=100")
        .then((r) => r.data),
    refetchInterval: 30_000,
  });

  const historyItems: ReportHistoryItem[] = data?.data ?? [];

  // 본부별 최신 항목
  const latestByDivision = Object.fromEntries(
    DIVISIONS.map((d) => [
      d.code,
      historyItems.find((h) => h.division_code === d.code),
    ])
  ) as Record<DivisionCode, ReportHistoryItem | undefined>;

  // ── 보고서 생성 뮤테이션 ──────────────────────────────────────────────────────
  const generateMutation = useMutation({
    mutationFn: (divisionCode: DivisionCode) => {
      const jobId = crypto.randomUUID();
      return apiClient.post("/report/generate", {
        jobId,
        divisionCode,
        userId: user?.id,
      });
    },
    onMutate: (code) => setGeneratingCode(code),
    onSuccess: (_, code) => {
      success(`${DIVISIONS.find((d) => d.code === code)?.name} 보고서 생성이 시작되었습니다.`);
      void queryClient.invalidateQueries({ queryKey: ["report", "history"] });
      navigate("/report/generate");
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? "보고서 생성 요청에 실패했습니다.";
      toastError(msg);
    },
    onSettled: () => setGeneratingCode(null),
  });

  // ── DataTable 컬럼 정의 ──────────────────────────────────────────────────────
  const columns: Column<ReportHistoryItem>[] = [
    {
      key:   "division_name",
      label: "본부",
      width: "160px",
      render: (_, row) => (
        <span className="font-medium text-primary">
          {row.division_name}
          <span className="ml-1.5 text-[10px] text-gray-400 font-normal">
            ({row.division_code})
          </span>
        </span>
      ),
    },
    {
      key:      "created_at",
      label:    "생성일",
      sortable: true,
      width:    "160px",
      render:   (v) => (
        <span className="text-gray-600 text-xs">{fmtDate(v as string)}</span>
      ),
    },
    {
      key:    "status",
      label:  "상태",
      width:  "110px",
      align:  "center",
      render: (v) => <StatusBadge status={v as string} />,
    },
    {
      key:    "division_code",
      label:  "포함 시스템",
      width:  "100px",
      align:  "center",
      render: (v) => (
        <span className="text-xs font-semibold text-gray-600">
          {SYSTEM_COUNT[v as DivisionCode] ?? "—"}개
        </span>
      ),
    },
    {
      key:    "id",
      label:  "다운로드",
      width:  "100px",
      align:  "center",
      render: (_, row) =>
        row.status === "COMPLETED" && row.pdf_path ? (
          <DownloadButton
            jobId={row.id}
            divisionCode={row.division_code}
            onError={(msg) => toastError(msg)}
          />
        ) : (
          <span className="text-xs text-gray-300">—</span>
        ),
    },
  ];

  // ── 렌더 ──────────────────────────────────────────────────────────────────────
  return (
    <AppLayout title="대시보드">
      {/* ── 요약 카드 ── */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {DIVISIONS.map((div) => (
          <SummaryCard
            key={div.code}
            division={div}
            latest={latestByDivision[div.code]}
          />
        ))}
      </section>

      {/* ── 이력 테이블 ── */}
      <section className="bg-white rounded-xl border border-gray-200 shadow-sm mb-6">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-sm font-semibold text-gray-800">보고서 생성 이력</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              30초마다 자동 갱신
              {data?.total !== undefined && ` · 총 ${data.total}건`}
            </p>
          </div>
          <button
            onClick={() => void refetch()}
            disabled={isLoading}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-secondary transition-colors disabled:opacity-50"
          >
            <svg className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            새로고침
          </button>
        </div>

        <div className="p-5">
          {isError ? (
            <ErrorState onRetry={() => void refetch()} />
          ) : isLoading ? (
            <LoadingSpinner centered size="lg" label="이력을 불러오는 중..." />
          ) : (
            <DataTable
              columns={columns}
              data={historyItems}
              rowKey={(r) => r.id}
              pageSize={10}
              emptyText="생성된 보고서가 없습니다."
            />
          )}
        </div>
      </section>

      {/* ── 빠른 실행 버튼 ── */}
      <section className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">빠른 실행</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            즉시 보고서 생성을 시작합니다. 진행 상황은 생성 페이지에서 확인하세요.
          </p>
        </div>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {DIVISIONS.map((div) => {
            const isGenerating = generatingCode === div.code;
            return (
              <button
                key={div.code}
                onClick={() => generateMutation.mutate(div.code)}
                disabled={!!generatingCode}
                className={`flex items-center justify-center gap-2.5 px-4 py-3.5 rounded-lg border-2
                  text-sm font-medium transition-all duration-150
                  ${isGenerating
                    ? "border-secondary bg-secondary/10 text-secondary cursor-wait"
                    : "border-gray-200 text-gray-700 hover:border-secondary hover:text-secondary hover:bg-secondary/5 disabled:opacity-50 disabled:cursor-not-allowed"
                  }`}
              >
                {isGenerating ? (
                  <svg className="w-5 h-5 animate-spin text-secondary" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                ) : (
                  QUICK_ICONS[div.code]
                )}
                <span>
                  {isGenerating ? "생성 중..." : `${div.name} 보고서 생성`}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </AppLayout>
  );
}

// ── 서브 컴포넌트 ─────────────────────────────────────────────────────────────

function DownloadButton({
  jobId,
  divisionCode,
  onError,
}: {
  jobId:        string;
  divisionCode: string;
  onError:      (msg: string) => void;
}) {
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    setLoading(true);
    try {
      await downloadPdf(jobId, divisionCode);
    } catch {
      onError("PDF 다운로드에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium
        bg-secondary/10 text-secondary hover:bg-secondary hover:text-white
        transition-colors disabled:opacity-50"
      title="PDF 다운로드"
    >
      {loading ? (
        <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      )}
      PDF
    </button>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3">
      <svg className="w-10 h-10 text-red-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
      <p className="text-sm text-gray-500">데이터를 불러오지 못했습니다.</p>
      <button
        onClick={onRetry}
        className="text-xs text-secondary hover:underline"
      >
        다시 시도
      </button>
    </div>
  );
}
