import { useState, useMemo }                    from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { apiClient }                              from "../api/client";
import {
  AppLayout,
  LoadingSpinner,
  useToast,
}                                                 from "../components/common";

// ── 타입 ──────────────────────────────────────────────────────────────────────

interface SavedReportRow {
  id:            string;
  division_code: "BIO" | "DEV" | "LHOUSE";
  report_type:   string;
  year:          number;
  month:         number;
  source_job_id: string | null;
  filename:      string;
  stored_path:   string;
  file_size:     number;
  saved_by:      string | null;
  saved_at:      string;
}

// ── 상수 ──────────────────────────────────────────────────────────────────────

const DIVISIONS = [
  { code: "ALL",    name: "전체",          color: "bg-gray-100  text-gray-700"    },
  { code: "BIO",    name: "Bio연구본부",   color: "bg-blue-100  text-blue-700"    },
  { code: "DEV",    name: "개발본부",      color: "bg-purple-100 text-purple-700" },
  { code: "LHOUSE", name: "L HOUSE 공장",  color: "bg-teal-100  text-teal-700"    },
] as const;

type FilterCode = (typeof DIVISIONS)[number]["code"];

const REPORT_TYPE_LABEL: Record<string, string> = {
  bio_veeva: "Veeva System",
  bio_lims:  "임검분 LIMS",
  bio_eln:   "전자연구노트(ELN)",
  dev:       "시스템 운영 현황",
  lhouse:    "Veeva System",
};

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function downloadSavedPdf(id: string, filename: string) {
  const res = await apiClient.get<Blob>(`/report/saved/${id}/download`, {
    responseType: "blob",
  });
  const url = URL.createObjectURL(res.data);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── 본부별 색상 ──────────────────────────────────────────────────────────────

function divisionColor(code: string): { card: string; badge: string; accent: string } {
  switch (code) {
    case "BIO":
      return { card: "border-blue-200",   badge: "bg-blue-100   text-blue-700",   accent: "text-blue-600"   };
    case "DEV":
      return { card: "border-purple-200", badge: "bg-purple-100 text-purple-700", accent: "text-purple-600" };
    case "LHOUSE":
      return { card: "border-teal-200",   badge: "bg-teal-100   text-teal-700",   accent: "text-teal-600"   };
    default:
      return { card: "border-gray-200",   badge: "bg-gray-100   text-gray-700",   accent: "text-gray-600"   };
  }
}

// ── 메인 컴포넌트 ────────────────────────────────────────────────────────────

export function ReportHistoryPage() {
  const { success, error: toastError } = useToast();
  const queryClient                    = useQueryClient();

  const [divFilter, setDivFilter] = useState<FilterCode>("ALL");

  // 저장된 보고서 목록 조회
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["report-saved", divFilter],
    queryFn:  async () => {
      const params = divFilter === "ALL" ? "" : `?division=${divFilter}`;
      const res = await apiClient.get<{ success: boolean; data: SavedReportRow[] }>(
        `/report/saved${params}`
      );
      return res.data.data;
    },
  });

  // 삭제 mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/report/saved/${id}`),
    onSuccess:  () => {
      success("History 에서 제거되었습니다.");
      void queryClient.invalidateQueries({ queryKey: ["report-saved"] });
    },
    onError: () => toastError("삭제에 실패했습니다."),
  });

  // 월별 그룹화: { "2026-04": { BIO: [...], DEV: [...], LHOUSE: [...] }, ... }
  const grouped = useMemo(() => {
    const map = new Map<string, Record<string, SavedReportRow[]>>();
    for (const item of items) {
      const key = `${item.year}-${String(item.month).padStart(2, "0")}`;
      if (!map.has(key)) map.set(key, { BIO: [], DEV: [], LHOUSE: [] });
      const bucket = map.get(key)!;
      (bucket[item.division_code] ??= []).push(item);
    }
    // 키 (year-month) 내림차순 정렬
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [items]);

  // ── 렌더 ────────────────────────────────────────────────────────────────────

  return (
    <AppLayout>
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">보고서 History</h1>
          <p className="text-sm text-gray-500 mt-1">
            매달 발행된 보고서가 본부별로 저장되어 있습니다. 각 본부 페이지의 “보고서 저장” 버튼으로 추가할 수 있습니다.
          </p>
        </div>

        {/* 필터 — 본부 */}
        <div className="flex items-center gap-2 mb-6">
          <span className="text-sm text-gray-500 mr-2">본부:</span>
          {DIVISIONS.map((d) => (
            <button
              key={d.code}
              onClick={() => setDivFilter(d.code)}
              className={`px-3 py-1.5 text-sm rounded-full transition-all
                ${divFilter === d.code
                  ? "bg-secondary text-white shadow-sm"
                  : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"}`}
            >
              {d.name}
            </button>
          ))}
        </div>

        {/* 본문 */}
        {isLoading ? (
          <div className="py-20 flex justify-center"><LoadingSpinner /></div>
        ) : grouped.length === 0 ? (
          <div className="py-20 text-center text-gray-400 text-sm">
            저장된 보고서가 없습니다. 각 본부 페이지에서 보고서 생성 후 “보고서 저장” 을 눌러 주세요.
          </div>
        ) : (
          <div className="space-y-8">
            {grouped.map(([ym, buckets]) => {
              const [yyyy, mm] = ym.split("-");
              return (
                <section key={ym}>
                  <h2 className="text-lg font-semibold text-gray-900 mb-3 flex items-center gap-2">
                    <span className="px-2 py-0.5 bg-secondary text-white text-sm rounded">{yyyy}-{mm}</span>
                    <span className="text-sm text-gray-500">
                      {Object.values(buckets).reduce((s, arr) => s + arr.length, 0)}건
                    </span>
                  </h2>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    {(["BIO", "DEV", "LHOUSE"] as const).map((divCode) => {
                      const rows = buckets[divCode] ?? [];
                      if (rows.length === 0) return null;
                      const c = divisionColor(divCode);
                      const divName = DIVISIONS.find((d) => d.code === divCode)?.name ?? divCode;
                      return (
                        <div key={divCode} className={`bg-white rounded-lg border ${c.card} p-4`}>
                          <div className={`inline-block px-2 py-0.5 text-xs font-semibold rounded ${c.badge} mb-3`}>
                            {divName}
                          </div>
                          <ul className="space-y-2">
                            {rows.map((row) => (
                              <li key={row.id} className="group">
                                <div className="flex items-start justify-between gap-2 p-2 rounded hover:bg-gray-50">
                                  <div className="flex-1 min-w-0">
                                    <div className={`text-xs font-medium ${c.accent} mb-0.5`}>
                                      {REPORT_TYPE_LABEL[row.report_type] ?? row.report_type}
                                    </div>
                                    <div className="text-sm text-gray-800 truncate" title={row.filename}>
                                      {row.filename}
                                    </div>
                                    <div className="text-xs text-gray-400 mt-0.5">
                                      {fmtBytes(row.file_size)} · {fmtDate(row.saved_at)}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                      onClick={() => void downloadSavedPdf(row.id, row.filename)}
                                      title="다운로드"
                                      className="p-1.5 text-gray-500 hover:text-secondary hover:bg-white rounded"
                                    >
                                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4 4m0 0l-4-4m4 4V4" />
                                      </svg>
                                    </button>
                                    <button
                                      onClick={() => {
                                        if (window.confirm(`'${row.filename}' 을(를) History 에서 삭제하시겠습니까?`)) {
                                          deleteMutation.mutate(row.id);
                                        }
                                      }}
                                      title="삭제"
                                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-white rounded"
                                    >
                                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 3h6a1 1 0 011 1v3H8V4a1 1 0 011-1z" />
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
