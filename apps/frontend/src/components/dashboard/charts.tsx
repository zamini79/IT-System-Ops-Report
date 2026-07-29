/**
 * 대시보드 차트 컴포넌트
 *
 * 규격(전 차트 공통):
 *  - 막대 ≤24px, 데이터 끝 4px 라운드, 인접 막대 2px 표면 간격
 *  - 격자 hairline 1px 실선(점선 금지), 축·라벨은 muted 잉크
 *  - 시리즈 2개 이상 → 범례 항상 표시 / 단일 시리즈 → 범례 없음(제목이 대신)
 *  - 단일 시리즈 막대는 값 직접 레이블 (대비 완화 규칙 충족)
 *  - **이중축 금지** — 스케일이 다른 두 측정치는 차트를 나눈다
 */

import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis, LabelList,
} from "recharts";

import type {
  DashboardCategoryItem,
  DashboardGroupedSeries,
  DashboardKpi,
  DashboardSeries,
} from "@skbs/shared";
import { AXIS_TICK, BAR, INK, STATUS, compact, num, seriesColor, toRows } from "./viz";

// ── 0. KPI 스탯 타일 ──────────────────────────────────────────────────────────

/**
 * label · value · delta 계약.
 * delta 색은 방향 × "증가가 좋은지" 로 정하고, 부호와 화살표를 함께 표기한다
 * (색만으로 의미를 전달하지 않는다).
 */
export function KpiTile({ kpi }: { kpi: DashboardKpi }) {
  const d       = kpi.delta;
  const hasDelta = d !== null && d !== undefined && d !== 0;
  const up      = (d ?? 0) > 0;
  const color   = !hasDelta ? INK.muted : up ? STATUS.good : STATUS.critical;

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm px-4 py-3">
      <p className="text-xs" style={{ color: INK.secondary }}>{kpi.label}</p>
      <div className="flex items-baseline gap-1.5 mt-1">
        <span className="text-2xl font-semibold" style={{ color: INK.primary }}>
          {kpi.value === null ? "-" : compact(kpi.value)}
        </span>
        <span className="text-xs" style={{ color: INK.muted }}>{kpi.unit}</span>
      </div>
      <p className="text-[11px] mt-1 flex items-center gap-1" style={{ color }}>
        {hasDelta ? (
          <>
            <span aria-hidden>{up ? "▲" : "▼"}</span>
            <span className="tabular-nums">{up ? "+" : ""}{d!.toLocaleString()}</span>
            <span style={{ color: INK.muted }}>전월 대비</span>
          </>
        ) : (
          <span style={{ color: INK.muted }}>
            {kpi.value === null ? "데이터 없음" : "전월과 동일"}
          </span>
        )}
      </p>
    </div>
  );
}

// ── 공용 카드 ─────────────────────────────────────────────────────────────────

export function ChartCard({
  title, subtitle, children, empty, className = "",
}: {
  title:     string;
  subtitle?: string;
  children:  React.ReactNode;
  /** 데이터가 없을 때 표시할 문구 */
  empty?:    string;
  className?: string;
}) {
  return (
    <section className={`bg-white border border-gray-200 rounded-xl shadow-sm p-4 ${className}`}>
      <header className="mb-3">
        <h3 className="text-sm font-semibold" style={{ color: INK.primary }}>{title}</h3>
        {subtitle && (
          <p className="text-xs mt-0.5" style={{ color: INK.secondary }}>{subtitle}</p>
        )}
      </header>
      {empty
        ? <p className="text-xs py-10 text-center" style={{ color: INK.muted }}>{empty}</p>
        : children}
    </section>
  );
}

// ── 공용 조각 ─────────────────────────────────────────────────────────────────

const tooltipStyle = {
  contentStyle: {
    borderRadius: 8,
    border:       `1px solid ${INK.grid}`,
    fontSize:     12,
    boxShadow:    "0 4px 12px rgba(11,11,11,0.08)",
  },
  labelStyle: { color: INK.secondary, fontSize: 11, marginBottom: 2 },
} as const;

function Grid() {
  return <CartesianGrid stroke={INK.grid} strokeWidth={1} vertical={false} />;
}

/** 범례 — 색은 마크(점)가 지고 텍스트는 잉크 토큰을 쓴다 */
function legendFormatter(value: string) {
  return <span style={{ color: INK.secondary, fontSize: 11 }}>{value}</span>;
}

// ── 1. 단일 시리즈 세로 막대 (월별 추이) ───────────────────────────────────────

export function MonthlyBar({
  data, colorIndex = 0, unit = "", decimals = false,
}: {
  data:        DashboardSeries;
  colorIndex?: number;
  unit?:       string;
  /** 소수 눈금 허용 (예: 리뷰 소요 '일') — 건수·인원 지표는 false 로 두어 2.25 같은 눈금을 막는다 */
  decimals?:   boolean;
}) {
  const rows  = data.labels.map((label, i) => ({ label, value: data.values[i] ?? 0 }));
  const color = seriesColor(colorIndex);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={rows} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}
                barCategoryGap={BAR.categoryGap}>
        <Grid />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: INK.baseline }} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={decimals}
               tickFormatter={(v: unknown) => compact(num(v))} width={44} />
        <Tooltip {...tooltipStyle}
                 formatter={(v: unknown) => [`${num(v).toLocaleString()}${unit}`, "값"]} />
        <Bar dataKey="value" fill={color} maxBarSize={BAR.maxSize} radius={BAR.radiusTop}>
          {/* 단일 시리즈는 값을 직접 표기 — 대비 완화 규칙 충족 */}
          <LabelList dataKey="value" position="top"
                     style={{ fill: INK.secondary, fontSize: 11 }}
                     formatter={(v: unknown) => compact(num(v))} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── 2. 다중 시리즈 그룹 막대 (월 × 유형) ───────────────────────────────────────

export function GroupedBar({
  data, height = 220, unit = "",
}: {
  data:    DashboardGroupedSeries;
  height?: number;
  unit?:   string;
}) {
  const rows = toRows(data.labels, data.series);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                barGap={BAR.gap} barCategoryGap={BAR.categoryGap}>
        <Grid />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: INK.baseline }} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false}
               tickFormatter={(v: unknown) => compact(num(v))} width={44} />
        <Tooltip {...tooltipStyle}
                 formatter={(v: unknown, name: unknown) => [`${num(v).toLocaleString()}${unit}`, String(name)]} />
        {/* 시리즈 2개 이상 → 범례 항상 */}
        <Legend iconType="circle" iconSize={8} formatter={legendFormatter}
                wrapperStyle={{ paddingTop: 6 }} />
        {data.series.map((s, i) => (
          <Bar key={s.name} dataKey={s.name} fill={seriesColor(i)}
               maxBarSize={BAR.maxSize} radius={BAR.radiusTop} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── 3. 누적 가로 막대 (Study × 조직처럼 구성비를 볼 때) ────────────────────────

export function StackedHorizontalBar({
  data, height,
}: {
  data:    DashboardGroupedSeries;
  height?: number;
}) {
  const rows = toRows(data.labels, data.series);
  const h    = height ?? Math.max(220, data.labels.length * 42 + 60);

  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={rows} layout="vertical"
                margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
                barCategoryGap={BAR.categoryGap}>
        <CartesianGrid stroke={INK.grid} strokeWidth={1} horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} axisLine={{ stroke: INK.baseline }} tickLine={false} allowDecimals={false}
               tickFormatter={(v: unknown) => compact(num(v))} />
        <YAxis type="category" dataKey="label" tick={AXIS_TICK}
               axisLine={false} tickLine={false} width={132} />
        <Tooltip {...tooltipStyle}
                 formatter={(v: unknown, name: unknown) => [`${num(v).toLocaleString()}명`, String(name)]} />
        <Legend iconType="circle" iconSize={8} formatter={legendFormatter}
                wrapperStyle={{ paddingTop: 6 }} />
        {data.series.map((s, i) => (
          <Bar key={s.name} dataKey={s.name} stackId="a" fill={seriesColor(i)}
               maxBarSize={BAR.maxSize}
               /* 누적 세그먼트 사이 2px 표면 간격 */
               stroke={INK.surface} strokeWidth={BAR.gap} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── 4. 카테고리 가로 막대 (단일 시리즈, 라벨이 길 때) ──────────────────────────

export function CategoryBar({
  items, colorIndex = 0, unit = "건",
}: {
  items:       DashboardCategoryItem[];
  colorIndex?: number;
  unit?:       string;
}) {
  const rows  = items.map((c) => ({ label: c.category, value: c.value }));
  const color = seriesColor(colorIndex);
  const h     = Math.max(180, rows.length * 38 + 40);

  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={rows} layout="vertical"
                margin={{ top: 4, right: 44, left: 8, bottom: 0 }}
                barCategoryGap={BAR.categoryGap}>
        <CartesianGrid stroke={INK.grid} strokeWidth={1} horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} axisLine={{ stroke: INK.baseline }} tickLine={false} allowDecimals={false}
               tickFormatter={(v: unknown) => compact(num(v))} />
        <YAxis type="category" dataKey="label" tick={AXIS_TICK}
               axisLine={false} tickLine={false} width={120} />
        <Tooltip {...tooltipStyle}
                 formatter={(v: unknown) => [`${num(v).toLocaleString()}${unit}`, "값"]} />
        <Bar dataKey="value" fill={color} maxBarSize={BAR.maxSize} radius={BAR.radiusRight}>
          {/* 막대 끝 바깥에 값 표기 (안쪽에 넣으면 짧은 막대에서 잘림) */}
          <LabelList dataKey="value" position="right"
                     style={{ fill: INK.secondary, fontSize: 11 }}
                     formatter={(v: unknown) => compact(num(v))} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── 5. 구성비 막대 (전체 대비 비중 — 도넛 대신 단일 막대 + 비율 표기) ───────────

export function ShareBar({ items }: { items: DashboardCategoryItem[] }) {
  const total = items.reduce((s, c) => s + c.value, 0);
  if (total === 0) return null;

  return (
    <div className="space-y-3">
      {/* 한 줄 누적 바 — 세그먼트 사이 2px 표면 간격 */}
      <div className="flex w-full h-6 rounded-md overflow-hidden" style={{ background: INK.grid }}>
        {items.map((c, i) => (
          <div key={c.category}
               title={`${c.category} ${c.value.toLocaleString()}건`}
               style={{
                 width:           `${(c.value / total) * 100}%`,
                 background:      seriesColor(i),
                 borderRight:     i < items.length - 1 ? `${BAR.gap}px solid ${INK.surface}` : undefined,
               }} />
        ))}
      </div>
      {/* 범례 + 값 (색은 점이 지고 텍스트는 잉크) */}
      <ul className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1.5">
        {items.map((c, i) => (
          <li key={c.category} className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: seriesColor(i) }} />
            <span className="flex-1 truncate" style={{ color: INK.secondary }}>{c.category}</span>
            <span className="font-semibold tabular-nums" style={{ color: INK.primary }}>
              {c.value.toLocaleString()}
            </span>
            <span style={{ color: INK.muted }}>
              {((c.value / total) * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── 6. 추이 선 그래프 (일별 KPI) ───────────────────────────────────────────────

export function TrendLine({
  points, unit = "",
}: {
  points: { date: string; value: number | null }[];
  unit?:  string;
}) {
  const rows = points.map((p) => ({ label: p.date.slice(5), full: p.date, value: p.value }));

  // 점이 많으면(수십~수백 일) 축 라벨을 솎아내고 개별 점 마커를 숨긴다.
  //   - 라벨을 다 그리면 겹쳐서 읽을 수 없다 → 약 8개만 노출
  //   - 촘촘한 선에 점을 다 찍으면 선이 뭉개진다 → hover 시 activeDot 으로만 표시
  const dense    = rows.length > 40;
  const interval = rows.length > 8 ? Math.floor(rows.length / 8) : 0;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <Grid />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: INK.baseline }} tickLine={false}
               interval={interval} minTickGap={16} />
        {/* 추이 선은 데이터 범위에 맞춘 축을 쓴다.
            (0 기준선은 길이로 크기를 인코딩하는 **막대**의 규칙이다. 여기서 0을 강제하면
             20만대 지표의 일별 변화가 완전히 평평해져 추이를 읽을 수 없다.
             축 눈금에 실제 값이 표기되므로 과장 위험은 없다.) */}
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} domain={["auto", "auto"]}
               tickFormatter={(v: unknown) => compact(num(v))} width={52} />
        <Tooltip {...tooltipStyle}
                 labelFormatter={(_l: unknown, payload: readonly { payload?: { full?: string } }[]) =>
                   payload?.[0]?.payload?.full ?? ""}
                 formatter={(v: unknown) => [`${v === null || v === undefined ? "-" : num(v).toLocaleString()}${unit}`, "값"]} />
        <Line type="monotone" dataKey="value" stroke={seriesColor(0)} strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round"
              /* 마커 ≥8px + 표면 링 (촘촘하면 숨김) */
              dot={dense ? false : { r: 4, fill: seriesColor(0), stroke: INK.surface, strokeWidth: 2 }}
              activeDot={{ r: 5, fill: seriesColor(0), stroke: INK.surface, strokeWidth: 2 }}
              connectNulls={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── 7. 표 보기 (대비 완화 + 접근성 — 모든 값을 텍스트로 제공) ───────────────────

export function SeriesTable({
  labels, series,
}: {
  labels: string[];
  series: { name: string; values: number[] }[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b" style={{ borderColor: INK.grid }}>
            <th className="text-left py-1.5 pr-3 font-medium" style={{ color: INK.muted }}>구분</th>
            {labels.map((l) => (
              <th key={l} className="text-right py-1.5 px-2 font-medium tabular-nums"
                  style={{ color: INK.muted }}>{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {series.map((s, i) => (
            <tr key={s.name} className="border-b last:border-0" style={{ borderColor: INK.grid }}>
              <td className="py-1.5 pr-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: seriesColor(i) }} />
                  <span style={{ color: INK.secondary }}>{s.name}</span>
                </span>
              </td>
              {s.values.map((v, j) => (
                <td key={j} className="text-right py-1.5 px-2 tabular-nums"
                    style={{ color: INK.primary }}>{v.toLocaleString()}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
