import { useState, useMemo, type ReactNode } from "react";
import { LoadingSpinner } from "./LoadingSpinner";

// ── 타입 ──────────────────────────────────────────────────────────────────────

export interface Column<T> {
  key:       string;
  label:     string;
  sortable?: boolean;
  width?:    string;
  align?:    "left" | "center" | "right";
  render?:   (value: unknown, row: T, index: number) => ReactNode;
}

interface Props<T> {
  columns:      Column<T>[];
  data:         T[];
  rowKey:       (row: T) => string | number;
  isLoading?:   boolean;
  emptyText?:   string;
  /** 기본 페이지당 행 수 (0 = 페이지네이션 없음) */
  pageSize?:    number;
  pageSizeOptions?: number[];
  /** 행 클릭 핸들러 */
  onRowClick?:  (row: T) => void;
  className?:   string;
}

type SortDir = "asc" | "desc";

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

function getValue<T>(row: T, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

function sortRows<T>(rows: T[], key: string, dir: SortDir): T[] {
  return [...rows].sort((a, b) => {
    const av = getValue(a, key);
    const bv = getValue(b, key);
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    const cmp = String(av).localeCompare(String(bv), "ko", { numeric: true });
    return dir === "asc" ? cmp : -cmp;
  });
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export function DataTable<T>({
  columns,
  data,
  rowKey,
  isLoading  = false,
  emptyText  = "데이터가 없습니다.",
  pageSize: defaultPageSize = 10,
  pageSizeOptions = [10, 25, 50],
  onRowClick,
  className  = "",
}: Props<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page,    setPage]    = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  // 정렬
  const sorted = useMemo(() => {
    if (!sortKey) return data;
    return sortRows(data, sortKey, sortDir);
  }, [data, sortKey, sortDir]);

  // 페이지네이션
  const paged = useMemo(() => {
    if (!pageSize) return sorted;
    const start = (page - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, page, pageSize]);

  const totalPages = pageSize ? Math.max(1, Math.ceil(data.length / pageSize)) : 1;

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(1);
  };

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setPage(1);
  };

  const alignClass = { left: "text-left", center: "text-center", right: "text-right" };

  return (
    <div className={`flex flex-col gap-0 ${className}`}>
      {/* 테이블 */}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-primary">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={col.width ? { width: col.width } : undefined}
                  className={`px-4 py-3 text-xs font-semibold text-white tracking-wide
                    ${alignClass[col.align ?? "left"]}
                    ${col.sortable ? "cursor-pointer select-none hover:bg-primary-600 transition-colors" : ""}`}
                  onClick={col.sortable ? () => handleSort(col.key) : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.sortable && (
                      <span className="text-primary-200">
                        {sortKey === col.key ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
                      </span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {isLoading ? (
              <tr>
                <td colSpan={columns.length} className="py-12">
                  <LoadingSpinner centered size="lg" label="불러오는 중..." />
                </td>
              </tr>
            ) : paged.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="py-12 text-center text-sm text-gray-400"
                >
                  {emptyText}
                </td>
              </tr>
            ) : (
              paged.map((row, i) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`transition-colors hover:bg-primary-50
                    ${onRowClick ? "cursor-pointer" : ""}
                    ${i % 2 === 1 ? "bg-gray-50" : ""}`}
                >
                  {columns.map((col) => {
                    const raw = getValue(row, col.key);
                    return (
                      <td
                        key={col.key}
                        className={`px-4 py-3 text-sm text-gray-700 ${alignClass[col.align ?? "left"]}`}
                      >
                        {col.render
                          ? col.render(raw, row, i)
                          : raw !== null && raw !== undefined
                          ? String(raw)
                          : <span className="text-gray-300">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 푸터 */}
      {pageSize > 0 && (
        <div className="flex items-center justify-between px-1 py-3 text-sm text-gray-600">
          <div className="flex items-center gap-2">
            <span>페이지당</span>
            <select
              value={pageSize}
              onChange={(e) => handlePageSizeChange(Number(e.target.value))}
              className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-secondary"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>{n}행</option>
              ))}
            </select>
            <span className="text-gray-400">
              / 총 {data.length.toLocaleString()}건
            </span>
          </div>

          <div className="flex items-center gap-1">
            <PageButton onClick={() => setPage(1)}         disabled={page === 1} label="처음">«</PageButton>
            <PageButton onClick={() => setPage((p) => p - 1)} disabled={page === 1} label="이전">‹</PageButton>
            {pageRange(page, totalPages).map((p) =>
              p === "…" ? (
                <span key={p} className="px-2 py-1 text-gray-400">…</span>
              ) : (
                <PageButton
                  key={p}
                  onClick={() => setPage(p as number)}
                  active={p === page}
                  label={`${p}페이지`}
                >
                  {p}
                </PageButton>
              )
            )}
            <PageButton onClick={() => setPage((p) => p + 1)} disabled={page === totalPages} label="다음">›</PageButton>
            <PageButton onClick={() => setPage(totalPages)}   disabled={page === totalPages} label="마지막">»</PageButton>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 페이지 버튼 ───────────────────────────────────────────────────────────────

function PageButton({
  onClick,
  disabled,
  active,
  label,
  children,
}: {
  onClick:   () => void;
  disabled?: boolean;
  active?:   boolean;
  label:     string;
  children:  ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || active}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={`w-8 h-8 flex items-center justify-center rounded text-sm font-medium transition-colors
        ${active
          ? "bg-secondary text-white"
          : "text-gray-600 hover:bg-gray-100 disabled:text-gray-300 disabled:cursor-not-allowed"}`}
    >
      {children}
    </button>
  );
}

// ── 페이지 범위 계산 ──────────────────────────────────────────────────────────

function pageRange(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages: (number | "…")[] = [1];

  if (current > 3)  pages.push("…");
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
    pages.push(i);
  }
  if (current < total - 2) pages.push("…");
  pages.push(total);

  return pages;
}
