interface Props {
  /** 0 ~ 100 */
  value: number;
  label?: string;
  showPercent?: boolean;
  /** "default" = secondary 파랑, "success" = 초록, "danger" = 빨강 */
  variant?: "default" | "success" | "danger";
  size?: "sm" | "md" | "lg";
}

const VARIANT_BAR: Record<string, string> = {
  default: "bg-secondary",
  success: "bg-green-500",
  danger:  "bg-red-500",
};

const SIZE_TRACK: Record<string, string> = {
  sm: "h-1.5",
  md: "h-2.5",
  lg: "h-4",
};

export function ProgressBar({
  value,
  label,
  showPercent = true,
  variant = "default",
  size = "md",
}: Props) {
  const clamped = Math.min(100, Math.max(0, value));
  const bar     = VARIANT_BAR[variant];
  const track   = SIZE_TRACK[size];

  return (
    <div className="w-full">
      {(label || showPercent) && (
        <div className="flex justify-between items-center mb-1">
          {label && (
            <span className="text-xs font-medium text-gray-600">{label}</span>
          )}
          {showPercent && (
            <span className="text-xs font-semibold text-gray-700 ml-auto">
              {clamped.toFixed(0)}%
            </span>
          )}
        </div>
      )}
      <div className={`w-full bg-gray-200 rounded-full overflow-hidden ${track}`}>
        <div
          className={`h-full rounded-full transition-all duration-300 ${bar}`}
          style={{ width: `${clamped}%` }}
          role="progressbar"
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}
