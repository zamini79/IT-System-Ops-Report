interface Props {
  size?: "sm" | "md" | "lg" | "xl";
  /** 가운데 정렬 래퍼 포함 여부 */
  centered?: boolean;
  label?: string;
}

const SIZE: Record<string, string> = {
  sm: "w-4 h-4 border-2",
  md: "w-7 h-7 border-2",
  lg: "w-10 h-10 border-[3px]",
  xl: "w-14 h-14 border-4",
};

export function LoadingSpinner({ size = "md", centered = false, label }: Props) {
  const spinner = (
    <div className="flex flex-col items-center gap-2">
      <div
        className={`animate-spin rounded-full border-gray-200 border-t-secondary ${SIZE[size]}`}
        role="status"
        aria-label={label ?? "로딩 중"}
      />
      {label && <p className="text-sm text-gray-500">{label}</p>}
    </div>
  );

  if (centered) {
    return (
      <div className="flex items-center justify-center w-full h-full min-h-[200px]">
        {spinner}
      </div>
    );
  }

  return spinner;
}
