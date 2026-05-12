import { useState }                          from "react";
import { useQuery, useQueryClient }          from "@tanstack/react-query";
import { apiClient }                          from "../api/client";
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
  { code: "ALL",    name: "전체" },
  { code: "BIO",    name: "Bio연구본부" },
  { code: "DEV",    name: "개발본부" },
  { code: "LHOUSE", name: "L HOUSE 공장" },
] as const;

type FilterCode = (typeof DIVISIONS)[number]["code"];

const SYSTEM_COUNT: Record<string, number> = {
  BIO:    3,
  DEV:    6,
  LHOUSE: 3,
};

const STATUS_FILTERS = [
  { value: "ALL",       label: "전체" },
  { value: "COMPLETED", label: "완료" },
  { value: "FAILED",    label: "실패" },
  { value: "RUNNING",   label: "진행 중" },
  { value: "PENDING",   label: "대기" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

// ── 날짜 포매터 ───────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── PDF 다운로드 ──────────────────────────────────────────────────────────────

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

// ── DownloadButton ────────────────────────────────────────────────────────────

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

// ── ErrorState ────────────────────────────────────────────────────────────────

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <svg className="w-10 h-10 text-red-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
      <p className="text-sm text-gray-500">데이터를 불러오지 못했습니다.</p>
      <button onClick={onRetry} className="text-xs text-secondary hover:underline">
        다시 시도
      </button>
    </div>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export function ReportHistoryPage() {
  const { error: toastError }  = useToast();
  const queryClient            = useQueryClient();

  const [divFilter,    setDivFilter]    = useState<FilterCode>("ALL");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["report", "history"],
    queryFn:  () =>
      apiClient
        .get<ApiHistory>("/report/history?limit=200")
        .then((r) => r.data),
    refetchInterval: 30_000,
  });

  const allItems: ReportHistoryItem[] = data?.data ?? [];

  const filtered = allItems.filter((item) => {
    if (divFilter    !== "ALL" && item.division_code !== divFilter) return false;
    if (statusFilter !== "ALL" && item.status        !== statusFilter) return false;
    return true;
  });

  // ── DataTable 컬럼 ────────────────────────────────────────────────────────────
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
      width:    "170px",
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
          {SYSTEM_COUNT[v as string] ?? "—"}개
        </span>
      ),
    },
    {
      key:    "error_message",
      label:  "오류",
      render: (v) =>
        v ? (
          <span className="text-[11px] text-red-500 truncate max-w-xs block" title={v as string}>
            {v as string}
          </span>
        ) : (
          <span className="text-xs text-gray-300">—</span>
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

  return (
    <AppLayout title="보고서 History">
      <section className="bg-white rounded-xl border border-gray-200 shadow-sm">
        {/* 헤더 + 필터 */}
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">보고서 생성 이력</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                30초마다 자동 갱신
                {data?.total !== undefined && ` · 총 ${data.total}건`}
                {filtered.length !== allItems.length && ` · 필터 결과 ${filtered.length}건`}
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {/* 본부 필터 */}
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                {DIVISIONS.map((d) => (
                  <button
                    key={d.code}
                    onClick={() => setDivFilter(d.code as FilterCode)}
                    className={`px-3 py-1.5 transition-colors ${
                      divFilter === d.code
                        ? "bg-primary text-white font-medium"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {d.name}
                  </button>
                ))}
              </div>

              {/* 상태 필터 */}
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-600
                  focus:outline-none focus:ring-1 focus:ring-secondary/40 bg-white"
              >
                {STATUS_FILTERS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>

              {/* 새로고침 */}
              <button
                onClick={() => void refetch()}
                disabled={isLoading}
                className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-secondary
                  transition-colors disabled:opacity-50 px-2.5 py-1.5 border border-gray-200
                  rounded-lg hover:border-secondary/40"
              >
                <svg className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                새로고침
              </button>
            </div>
          </div>
        </div>

        {/* 테이블 */}
        <div className="p-5">
          {isError ? (
            <ErrorState onRetry={() => void refetch()} />
          ) : isLoading ? (
            <LoadingSpinner centered size="lg" label="이력을 불러오는 중..." />
          ) : (
            <DataTable
              columns={columns}
              data={filtered}
              rowKey={(r) => r.id}
              pageSize={15}
              emptyText="조건에 맞는 보고서 이력이 없습니다."
            />
          )}
        </div>
      </section>
    </AppLayout>
  );
}
