export type StatusType =
  | "PENDING"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | string;

interface Props {
  status: StatusType;
  /** 표시할 레이블을 직접 지정 (기본값: 상태 코드를 한국어로 변환) */
  label?: string;
  size?: "sm" | "md";
}

const STATUS_MAP: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  PENDING:   { bg: "bg-gray-100",   text: "text-gray-600",   dot: "bg-gray-400",   label: "대기" },
  QUEUED:    { bg: "bg-gray-100",   text: "text-gray-600",   dot: "bg-gray-400",   label: "큐" },
  RUNNING:   { bg: "bg-blue-100",   text: "text-secondary",  dot: "bg-secondary",  label: "진행 중" },
  COMPLETED: { bg: "bg-green-100",  text: "text-green-700",  dot: "bg-green-500",  label: "완료" },
  FAILED:    { bg: "bg-red-100",    text: "text-red-700",    dot: "bg-red-500",    label: "실패" },
};

const FALLBACK = { bg: "bg-gray-100", text: "text-gray-500", dot: "bg-gray-400", label: "" };

export function StatusBadge({ status, label, size = "md" }: Props) {
  const s     = STATUS_MAP[status] ?? FALLBACK;
  const text  = label ?? (s.label || status);
  const sizeClass = size === "sm"
    ? "text-xs px-2 py-0.5 gap-1"
    : "text-xs px-2.5 py-1 gap-1.5";
  const dotClass = size === "sm" ? "w-1.5 h-1.5" : "w-2 h-2";

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${s.bg} ${s.text} ${sizeClass}`}
    >
      <span className={`rounded-full flex-shrink-0 ${s.dot} ${dotClass}`} />
      {text}
    </span>
  );
}
