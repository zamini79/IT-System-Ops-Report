/**
 * 대시보드 시각화 토큰
 *
 * 카테고리 팔레트는 흰색 카드 표면(#ffffff)에 대해 검증을 통과한 순서다.
 *   - 명도 밴드 / 채도 하한 / CVD 인접쌍 분리(최악 ΔE 9.1) / 일반시야 하한(19.6) 모두 PASS
 *   - aqua·yellow·magenta 3개 슬롯은 표면 대비 3:1 미달 → **직접 레이블(값 표기)로 완화**
 *     (그래서 단일 시리즈 막대에는 값 레이블을 항상 붙인다)
 *
 * ※ 슬롯 순서는 CVD 안전장치다. 임의로 바꾸거나 색을 순환(cycle)시키지 말 것.
 *   시리즈가 8개를 넘으면 "기타"로 접거나 차트를 분리한다.
 */

/** 카테고리 팔레트 (고정 순서) */
export const SERIES = [
  "#2a78d6", // 1 blue
  "#eb6834", // 2 orange
  "#1baf7a", // 3 aqua
  "#eda100", // 4 yellow
  "#e87ba4", // 5 magenta
  "#008300", // 6 green
  "#4a3aa7", // 7 violet
  "#e34948", // 8 red
] as const;

/** 슬롯 색 (순환 금지 — 인덱스가 범위를 넘으면 마지막 슬롯 고정) */
export function seriesColor(i: number): string {
  return SERIES[Math.min(i, SERIES.length - 1)];
}

/** 차트 크롬·잉크 (텍스트는 절대 시리즈 색을 입지 않는다) */
export const INK = {
  primary:   "#0b0b0b",
  secondary: "#52514e",
  muted:     "#898781",
  grid:      "#e1e0d9",
  baseline:  "#c3c2b7",
  surface:   "#ffffff",
} as const;

/** 상태 색 (시리즈 색으로 재사용 금지 — 항상 아이콘/라벨과 함께) */
export const STATUS = {
  good:     "#0ca30c",
  warning:  "#fab219",
  serious:  "#ec835a",
  critical: "#d03b3b",
} as const;

/** 막대 규격 */
export const BAR = {
  /** 슬롯을 꽉 채우지 않는다 */
  maxSize: 24,
  /** 데이터 끝 4px 라운드, baseline 은 각지게 */
  radiusTop: [4, 4, 0, 0] as [number, number, number, number],
  radiusRight: [0, 4, 4, 0] as [number, number, number, number],
  /** 인접 막대 사이 2px 표면 간격 */
  gap: 2,
  categoryGap: "22%",
} as const;

export const AXIS_TICK = { fill: INK.muted, fontSize: 11 } as const;

/**
 * recharts 콜백은 값 타입이 넓다(ValueType | undefined). 숫자로 안전 변환.
 */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 큰 수 축약 (1,284 / 12.9K / 1.2M) */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000)    return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** 시리즈 라벨을 recharts 가 쓰는 행 배열로 변환 */
export function toRows(
  labels: string[],
  series: { name: string; values: number[] }[]
): Record<string, string | number>[] {
  return labels.map((label, i) => {
    const row: Record<string, string | number> = { label };
    for (const s of series) row[s.name] = s.values[i] ?? 0;
    return row;
  });
}
