/**
 * 운영 현황 대시보드 (본부별)
 *
 * ─ 목적 ──────────────────────────────────────────────────────────────────────
 *  담당자가 필요할 때 접속해 본부 운영 현황을 확인한다.
 *  데이터는 **매일 새벽 자동 수집**되어 스냅샷으로 저장되고, 이 화면은 그 스냅샷을 읽는다.
 *  업로드가 필요한 항목(예: Veeva MS Timesheet)은 업로드 시 스냅샷이 갱신된다.
 *
 * ─ 데이터 ────────────────────────────────────────────────────────────────────
 *  GET /api/dashboard/:code            최신 스냅샷 + 소스 상태 + 마지막 수집 정보
 *  GET /api/dashboard/:code/trend      KPI 일별 추이
 *  POST /api/dashboard/:code/collect   지금 즉시 수집 (새벽까지 기다리지 않을 때)
 */

import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import { AppLayout, LoadingSpinner, useToast } from "../components/common";
import {
  CategoryBar, ChartCard, GroupedBar, KpiTile, MonthlyBar,
  SeriesTable, ShareBar, StackedHorizontalBar, TrendLine,
} from "../components/dashboard/charts";
import { INK, STATUS } from "../components/dashboard/viz";
import type {
  AnyDashboardData, BioDashboardData, DashboardDivisionCode, DashboardResponse,
  DashboardTrendResponse, DevDashboardData, LhouseDashboardData,
} from "@skbs/shared";

// ── 상수 ──────────────────────────────────────────────────────────────────────

const DIVISION_NAMES: Record<string, string> = {
  DEV:    "개발본부",
  LHOUSE: "L HOUSE 공장",
  BIO:    "Bio연구본부",
};

/**
 * 수동 "지금 수집" 버튼 노출 여부.
 * 현재는 UI 에서 숨김 — 수집은 매일 새벽 자동 실행된다.
 * (백엔드 POST /api/dashboard/:code/collect 는 그대로 살아 있어 필요 시 바로 되살릴 수 있다)
 */
const SHOW_COLLECT_BUTTON = false;

/** 추이에서 선택할 수 있는 KPI (본부별 — 스냅샷 KPI key 와 일치해야 함) */
const TREND_METRICS_BY_DIVISION: Record<string, { key: string; label: string; unit: string }[]> = {
  DEV: [
    { key: "gcp_doc",    label: "GCP 문서 관리",      unit: "건" },
    { key: "gcp_user",   label: "GCP 등록 사용자",    unit: "명" },
    { key: "gcp_login",  label: "GCP 일평균 접속",    unit: "명" },
    { key: "mc_doc",     label: "Medcomms 문서 관리", unit: "건" },
    { key: "ctms_user",  label: "CTMS 사용자",        unit: "명" },
  ],
  LHOUSE: [
    { key: "lh_doc",   label: "문서 관리",   unit: "건" },
    { key: "lh_user",  label: "등록 사용자", unit: "명" },
    { key: "lh_login", label: "일평균 접속", unit: "명" },
  ],
  BIO: [
    { key: "bio_doc",   label: "문서 관리",   unit: "건" },
    { key: "bio_user",  label: "등록 사용자", unit: "명" },
    { key: "bio_login", label: "일평균 접속", unit: "명" },
  ],
};

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function fmtDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtBytes(b: number | null): string {
  if (b === null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** 수집 상태 배지 — 색만으로 의미를 전달하지 않도록 라벨과 함께 */
function RunBadge({ status }: { status: string }) {
  const map: Record<string, { text: string; color: string }> = {
    SUCCESS: { text: "정상 수집", color: STATUS.good },
    PARTIAL: { text: "일부 실패", color: STATUS.warning },
    FAILED:  { text: "수집 실패", color: STATUS.critical },
    RUNNING: { text: "수집 중",   color: INK.muted },
  };
  const s = map[status] ?? { text: status, color: INK.muted };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
      <span style={{ color: INK.secondary }}>{s.text}</span>
    </span>
  );
}

// ── 페이지 ────────────────────────────────────────────────────────────────────

export function OpsDashboardPage() {
  const { divisionCode = "DEV" } = useParams();
  const code = divisionCode.toUpperCase() as DashboardDivisionCode;
  const name = DIVISION_NAMES[code] ?? code;

  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const trendMetrics = TREND_METRICS_BY_DIVISION[code] ?? [];
  const [metric, setMetric] = useState(trendMetrics[0]?.key ?? "");

  // 본부를 바꿔 이동하면 라우터가 같은 컴포넌트를 재사용하므로 metric 이 이전 본부의
  // 키로 남는다(예: DEV 의 "gcp_doc" 을 들고 LHOUSE 로 이동 → 해당 지표가 없어 빈 그래프).
  // 상태를 그대로 쓰지 않고, 현재 본부에 없는 키면 첫 지표로 대체해 파생값을 만든다.
  const activeMetric = trendMetrics.some((m) => m.key === metric)
    ? metric
    : (trendMetrics[0]?.key ?? "");
  const [showTable, setShowTable] = useState(false);
  const [days, setDays] = useState(30);

  // ── 스냅샷 조회 ─────────────────────────────────────────────────────────────
  const { data: dash, isLoading, isError, error } = useQuery({
    queryKey: ["ops-dashboard", code],
    queryFn: () =>
      apiClient
        .get<{ success: boolean; data: DashboardResponse<AnyDashboardData> }>(`/dashboard/${code}`)
        .then((r) => r.data.data),
    refetchInterval: 60_000,
  });

  // ── 추이 조회 ───────────────────────────────────────────────────────────────
  const { data: trend } = useQuery({
    queryKey: ["ops-trend", code, activeMetric, days],
    queryFn: () =>
      apiClient
        .get<{ success: boolean; data: DashboardTrendResponse }>(
          `/dashboard/${code}/trend?metric=${activeMetric}&days=${days}`
        )
        .then((r) => r.data.data),
    enabled: !!dash?.capturedDate && !!activeMetric,
  });

  // ── 즉시 수집 ───────────────────────────────────────────────────────────────
  const collect = useMutation({
    mutationFn: () => apiClient.post(`/dashboard/${code}/collect`),
    onSuccess: () => {
      success("데이터 수집을 시작했습니다. 완료되면 대시보드가 갱신됩니다.");
      void queryClient.invalidateQueries({ queryKey: ["ops-dashboard", code] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })
        ?.response?.data?.error ?? "수집 시작에 실패했습니다.";
      toastError(msg);
    },
  });

  if (isLoading) {
    return (
      <AppLayout title={`${name} 운영 현황`}>
        <LoadingSpinner centered label="대시보드를 불러오는 중…" />
      </AppLayout>
    );
  }

  if (isError || !dash) {
    const msg = (error as { response?: { data?: { error?: string } } })
      ?.response?.data?.error ?? "대시보드를 불러올 수 없습니다.";
    return (
      <AppLayout title={`${name} 운영 현황`}>
        <p className="text-sm text-red-600">{msg}</p>
      </AppLayout>
    );
  }

  // 본부별로 데이터 형태가 달라 좁혀서 사용한다
  const dev = code === "DEV"    ? (dash.data as DevDashboardData    | null) : null;
  const lh  = code === "LHOUSE" ? (dash.data as LhouseDashboardData | null) : null;
  const bio = code === "BIO"    ? (dash.data as BioDashboardData    | null) : null;
  const timesheet = dev?.timesheet ?? lh?.timesheet ?? bio?.timesheet ?? null;
  const collected  = dash.sources.filter((s) => s.kind === "collected");
  const uploaded   = dash.sources.filter((s) => s.kind === "uploaded");
  const missing    = dash.sources.filter((s) => !s.present);
  const metricInfo = trendMetrics.find((m) => m.key === activeMetric);

  return (
    <AppLayout title={`${name} 운영 현황`}>
      <div className="space-y-5 pb-8">

        {/* ── 헤더: 기준일 + 수집 상태 + 즉시 수집 ── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm" style={{ color: INK.secondary }}>
              기준일{" "}
              <strong style={{ color: INK.primary }}>
                {dash.capturedDate ?? "아직 수집된 데이터가 없습니다"}
              </strong>
              {dash.updatedAt && (
                <span style={{ color: INK.muted }}> · 갱신 {fmtDateTime(dash.updatedAt)}</span>
              )}
            </p>
            <div className="flex items-center gap-3 mt-1">
              {dash.lastRun ? (
                <>
                  <RunBadge status={dash.lastRun.status} />
                  <span className="text-[11px]" style={{ color: INK.muted }}>
                    마지막 수집 {fmtDateTime(dash.lastRun.finishedAt ?? dash.lastRun.startedAt)}
                    {" · "}{dash.lastRun.trigger === "cron" ? "자동" : "수동"}
                  </span>
                </>
              ) : (
                <span className="text-[11px]" style={{ color: INK.muted }}>
                  수집 이력이 없습니다 (매일 새벽 03:00 자동 수집)
                </span>
              )}
            </div>
          </div>

          {/* 수동 수집 버튼은 현재 UI 에서 제외 (기능·엔드포인트는 그대로 유지).
              다시 노출하려면 SHOW_COLLECT_BUTTON = true 로 바꾸면 된다. */}
          {SHOW_COLLECT_BUTTON && (
            <button
              onClick={() => collect.mutate()}
              disabled={collect.isPending || dash.lastRun?.status === "RUNNING"}
              title="새벽 자동 수집을 기다리지 않고 지금 즉시 수집합니다 (수 분 소요)"
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all
                ${collect.isPending || dash.lastRun?.status === "RUNNING"
                  ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                  : "bg-secondary text-white hover:bg-secondary-600 shadow-sm"}`}
            >
              {collect.isPending || dash.lastRun?.status === "RUNNING" ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              )}
              {collect.isPending || dash.lastRun?.status === "RUNNING" ? "수집 중…" : "지금 수집"}
            </button>
          )}
        </div>

        {/* 누락 소스 경고 — 아이콘 + 라벨로 표시(색만으로 전달하지 않음) */}
        {missing.length > 0 && (
          <div className="flex items-start gap-2 px-4 py-3 rounded-lg border"
               style={{ borderColor: STATUS.warning, background: "#fffbeb" }}>
            <span aria-hidden>⚠</span>
            <div className="text-xs" style={{ color: INK.secondary }}>
              <strong style={{ color: INK.primary }}>일부 데이터가 없습니다</strong> —{" "}
              {missing.map((s) => s.label).join(", ")}
              <br />
              {missing.some((s) => s.kind === "uploaded")
                ? "업로드가 필요한 항목은 해당 본부 화면에서 업로드해 주세요."
                : "다음 자동 수집에서 다시 시도됩니다."}
            </div>
          </div>
        )}

        {dash.capturedDate === null ? (
          <ChartCard title="데이터 없음"
                     empty="아직 수집된 데이터가 없습니다. '지금 수집'을 누르거나 새벽 자동 수집을 기다려 주세요." >
            <div />
          </ChartCard>
        ) : (
          <>
            {/* ── KPI ── */}
            <section>
              <h2 className="text-sm font-semibold mb-2" style={{ color: INK.primary }}>주요 지표</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {dash.kpis.map((k) => <KpiTile key={k.key} kpi={k} />)}
              </div>
            </section>

            {/* ── 일별 추이 ── */}
            <ChartCard
              title={`일별 추이 (최근 ${days}일)`}
              subtitle="Veeva Performance Statistics 리포트의 일별 데이터 기준"
              empty={!trend || trend.points.length === 0 ? "이 지표는 일별 데이터가 없습니다 (월 단위 집계 지표)." : undefined}
            >
              <>
                <div className="flex flex-wrap items-center gap-1.5 mb-3">
                  {[30, 60, 90].map((d) => (
                    <button key={d} onClick={() => setDays(d)}
                            className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors
                              ${days === d
                                ? "bg-gray-800 text-white border-gray-800"
                                : "bg-white border-gray-200 hover:bg-gray-50"}`}
                            style={days === d ? undefined : { color: INK.secondary }}>
                      {d}일
                    </button>
                  ))}
                  <span className="w-px h-4 mx-1" style={{ background: INK.grid }} />
                  {trendMetrics.map((m) => (
                    <button key={m.key} onClick={() => setMetric(m.key)}
                            className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors
                              ${activeMetric === m.key
                                ? "bg-primary text-white border-primary"
                                : "bg-white border-gray-200 hover:bg-gray-50"}`}
                            style={activeMetric === m.key ? undefined : { color: INK.secondary }}>
                      {m.label}
                    </button>
                  ))}
                </div>
                {trend && trend.points.length > 0 && (
                  <TrendLine points={trend.points} unit={metricInfo?.unit ?? ""} />
                )}
              </>
            </ChartCard>

            {/* ── GCP Quality System ── */}
            {dev?.gcp && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold" style={{ color: INK.primary }}>
                  GCP Quality System
                </h2>

                {dev.gcp.insight.length > 0 && (
                  <div className="bg-white border border-gray-200 rounded-xl shadow-sm px-4 py-3">
                    <ul className="space-y-1 text-xs" style={{ color: INK.secondary }}>
                      {dev.gcp.insight.map((line, i) => (
                        <li key={i} dangerouslySetInnerHTML={{ __html: line }} />
                      ))}
                    </ul>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                  <ChartCard title="문서 관리 현황" subtitle="월평균 Doc Count"
                             empty={!dev.gcp.docCount ? "데이터 없음" : undefined}>
                    {dev.gcp.docCount && <MonthlyBar data={dev.gcp.docCount} colorIndex={0} unit="건" />}
                  </ChartCard>

                  <ChartCard title="사용자 현황" subtitle="월평균 Active User"
                             empty={!dev.gcp.activeUser ? "데이터 없음" : undefined}>
                    {dev.gcp.activeUser && <MonthlyBar data={dev.gcp.activeUser} colorIndex={1} unit="명" />}
                  </ChartCard>

                  <ChartCard title="일일 사용 현황" subtitle="월평균 Unique Login"
                             empty={!dev.gcp.uniqueLogin ? "데이터 없음" : undefined}>
                    {dev.gcp.uniqueLogin && <MonthlyBar data={dev.gcp.uniqueLogin} colorIndex={2} unit="명" />}
                  </ChartCard>

                  <ChartCard title="교육 실행" subtitle="월별 Training 건수"
                             empty={!dev.gcp.training ? "데이터 없음" : undefined}>
                    {dev.gcp.training && <MonthlyBar data={dev.gcp.training} colorIndex={3} unit="건" />}
                  </ChartCard>

                  <ChartCard title="품질 이벤트" subtitle="월별 × 이벤트 유형"
                             empty={!dev.gcp.quality ? "데이터 없음" : undefined}>
                    {dev.gcp.quality && (
                      <>
                        <GroupedBar data={dev.gcp.quality} unit="건" />
                        <div className="mt-3 pt-3 border-t" style={{ borderColor: INK.grid }}>
                          <button onClick={() => setShowTable((v) => !v)}
                                  className="text-xs font-medium hover:underline"
                                  style={{ color: INK.secondary }}>
                            {showTable ? "표 숨기기" : "표로 보기"}
                          </button>
                          {showTable && (
                            <div className="mt-2">
                              <SeriesTable labels={dev.gcp.quality.labels} series={dev.gcp.quality.series} />
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </ChartCard>

                  <ChartCard title="업무 활용 현황" subtitle="Activity (Task) Count 구성비"
                             empty={dev.gcp.activity.length === 0 ? "데이터 없음" : undefined}>
                    {dev.gcp.activity.length > 0 && <ShareBar items={dev.gcp.activity} />}
                  </ChartCard>
                </div>
              </section>
            )}

            {/* ── Medcomms ── */}
            {dev?.medcomms && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold" style={{ color: INK.primary }}>Medcomms</h2>

                {dev.medcomms.insight.length > 0 && (
                  <div className="bg-white border border-gray-200 rounded-xl shadow-sm px-4 py-3">
                    <ul className="space-y-1 text-xs" style={{ color: INK.secondary }}>
                      {dev.medcomms.insight.map((line, i) => (
                        <li key={i} dangerouslySetInnerHTML={{ __html: line }} />
                      ))}
                    </ul>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                  <ChartCard title="문서 관리 현황" subtitle="월평균 Doc Count"
                             empty={!dev.medcomms.docMgmt ? "데이터 없음" : undefined}>
                    {dev.medcomms.docMgmt && <MonthlyBar data={dev.medcomms.docMgmt} colorIndex={0} unit="건" />}
                  </ChartCard>

                  <ChartCard title="사용자 현황" subtitle="월평균 Active User"
                             empty={!dev.medcomms.user ? "데이터 없음" : undefined}>
                    {dev.medcomms.user && <MonthlyBar data={dev.medcomms.user} colorIndex={1} unit="명" />}
                  </ChartCard>

                  <ChartCard title="일일 사용 현황" subtitle="월평균 Unique Login"
                             empty={!dev.medcomms.login ? "데이터 없음" : undefined}>
                    {dev.medcomms.login && <MonthlyBar data={dev.medcomms.login} colorIndex={2} unit="명" />}
                  </ChartCard>

                  <ChartCard title="생성 문서 구분" subtitle="최근 3개월 문서 유형별"
                             empty={dev.medcomms.docType.length === 0 ? "데이터 없음" : undefined}>
                    {dev.medcomms.docType.length > 0 && <CategoryBar items={dev.medcomms.docType} colorIndex={0} />}
                  </ChartCard>

                  <ChartCard title="업무 활용 현황" subtitle="최근 3개월 활동별"
                             empty={dev.medcomms.activity.length === 0 ? "데이터 없음" : undefined}>
                    {dev.medcomms.activity.length > 0 && <CategoryBar items={dev.medcomms.activity} colorIndex={1} />}
                  </ChartCard>

                  {/* 스케일이 다른 두 측정치 → 이중축 대신 차트를 나눈다 */}
                  {dev.medcomms.review && (
                    <>
                      <ChartCard title="리뷰 문서 수" subtitle="월별 Document Count">
                        <MonthlyBar
                          data={{ labels: dev.medcomms.review.labels,
                                  values: dev.medcomms.review.series[0]?.values ?? [] }}
                          colorIndex={0} unit="건" />
                      </ChartCard>
                      <ChartCard title="문서 리뷰 시간" subtitle="월별 Time in Review (일)">
                        <MonthlyBar
                          data={{ labels: dev.medcomms.review.labels,
                                  values: dev.medcomms.review.series[1]?.values ?? [] }}
                          colorIndex={1} unit="일" decimals />
                      </ChartCard>
                    </>
                  )}
                </div>
              </section>
            )}

            {/* ── CTMS / eTMF ── */}
            {dev?.ctms && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold" style={{ color: INK.primary }}>
                  CTMS / eTMF
                </h2>

                {dev.ctms.insight.length > 0 && (
                  <div className="bg-white border border-gray-200 rounded-xl shadow-sm px-4 py-3">
                    <ul className="space-y-1 text-xs" style={{ color: INK.secondary }}>
                      {dev.ctms.insight.map((line, i) => (
                        <li key={i} dangerouslySetInnerHTML={{ __html: line }} />
                      ))}
                    </ul>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                  <ChartCard title="사용자 현황" subtitle="월평균 Active User"
                             empty={!dev.ctms.user ? "데이터 없음" : undefined}>
                    {dev.ctms.user && <MonthlyBar data={dev.ctms.user} colorIndex={0} unit="명" />}
                  </ChartCard>

                  <ChartCard title="일일 사용자 현황" subtitle="월평균 Unique Login"
                             empty={!dev.ctms.login ? "데이터 없음" : undefined}>
                    {dev.ctms.login && <MonthlyBar data={dev.ctms.login} colorIndex={2} unit="명" />}
                  </ChartCard>
                </div>

                <ChartCard title="Study별 사용자 현황" subtitle="Study × 조직 (상위 7개 조직 + 기타)"
                           empty={!dev.ctms.study ? "데이터 없음" : undefined}>
                  {dev.ctms.study && <StackedHorizontalBar data={dev.ctms.study} />}
                </ChartCard>
              </section>
            )}

            {/* ── L HOUSE Veeva Quality System ── */}
            {lh?.veeva && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold" style={{ color: INK.primary }}>
                  Veeva Quality System
                </h2>

                {lh.veeva.insight.length > 0 && (
                  <div className="bg-white border border-gray-200 rounded-xl shadow-sm px-4 py-3">
                    <ul className="space-y-1 text-xs" style={{ color: INK.secondary }}>
                      {lh.veeva.insight.map((line, i) => (
                        <li key={i} dangerouslySetInnerHTML={{ __html: line }} />
                      ))}
                    </ul>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                  <ChartCard title="문서 관리 현황" subtitle="월평균 Doc Count"
                             empty={!lh.veeva.docCount ? "데이터 없음" : undefined}>
                    {lh.veeva.docCount && <MonthlyBar data={lh.veeva.docCount} colorIndex={0} unit="건" />}
                  </ChartCard>

                  <ChartCard title="사용자 등록 현황" subtitle="월평균 Active User"
                             empty={!lh.veeva.activeUser ? "데이터 없음" : undefined}>
                    {lh.veeva.activeUser && <MonthlyBar data={lh.veeva.activeUser} colorIndex={1} unit="명" />}
                  </ChartCard>

                  <ChartCard title="일일 사용 현황" subtitle="월평균 Unique Login"
                             empty={!lh.veeva.uniqueLogin ? "데이터 없음" : undefined}>
                    {lh.veeva.uniqueLogin && <MonthlyBar data={lh.veeva.uniqueLogin} colorIndex={2} unit="명" />}
                  </ChartCard>

                  <ChartCard title="교육 관리" subtitle="월별 교육 실행"
                             empty={!lh.veeva.training ? "데이터 없음" : undefined}>
                    {lh.veeva.training && <MonthlyBar data={lh.veeva.training} colorIndex={3} unit="건" />}
                  </ChartCard>

                  <ChartCard title="품질 관리" subtitle="월별 × 품질 이벤트 유형"
                             empty={!lh.veeva.quality ? "데이터 없음" : undefined}>
                    {lh.veeva.quality && (
                      <>
                        <GroupedBar data={lh.veeva.quality} unit="건" />
                        <div className="mt-3 pt-3 border-t" style={{ borderColor: INK.grid }}>
                          <button onClick={() => setShowTable((v) => !v)}
                                  className="text-xs font-medium hover:underline"
                                  style={{ color: INK.secondary }}>
                            {showTable ? "표 숨기기" : "표로 보기"}
                          </button>
                          {showTable && (
                            <div className="mt-2">
                              <SeriesTable labels={lh.veeva.quality.labels} series={lh.veeva.quality.series} />
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </ChartCard>

                  <ChartCard title="업무 활용 현황" subtitle="Activity (Task) Count 구성비"
                             empty={lh.veeva.activity.length === 0 ? "데이터 없음" : undefined}>
                    {lh.veeva.activity.length > 0 && <ShareBar items={lh.veeva.activity} />}
                  </ChartCard>
                </div>
              </section>
            )}

            {/* ── Bio연구본부 Veeva (eDMS) ── */}
            {bio?.veeva && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold" style={{ color: INK.primary }}>
                  Veeva System (eDMS)
                </h2>

                {bio.veeva.insight.length > 0 && (
                  <div className="bg-white border border-gray-200 rounded-xl shadow-sm px-4 py-3">
                    <ul className="space-y-1 text-xs" style={{ color: INK.secondary }}>
                      {bio.veeva.insight.map((line, i) => (
                        <li key={i} dangerouslySetInnerHTML={{ __html: line }} />
                      ))}
                    </ul>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                  <ChartCard title="문서 관리 현황" subtitle="월평균 Doc Count"
                             empty={!bio.veeva.docCount ? "데이터 없음" : undefined}>
                    {bio.veeva.docCount && <MonthlyBar data={bio.veeva.docCount} colorIndex={0} unit="건" />}
                  </ChartCard>

                  <ChartCard title="사용자 현황" subtitle="월평균 Active User"
                             empty={!bio.veeva.activeUser ? "데이터 없음" : undefined}>
                    {bio.veeva.activeUser && <MonthlyBar data={bio.veeva.activeUser} colorIndex={1} unit="명" />}
                  </ChartCard>

                  <ChartCard title="일일 사용 현황" subtitle="월평균 Unique Login"
                             empty={!bio.veeva.uniqueLogin ? "데이터 없음" : undefined}>
                    {bio.veeva.uniqueLogin && <MonthlyBar data={bio.veeva.uniqueLogin} colorIndex={2} unit="명" />}
                  </ChartCard>

                  <ChartCard title="업무 활용 현황" subtitle="Activity 카테고리별"
                             empty={bio.veeva.activity.length === 0 ? "데이터 없음" : undefined}>
                    {bio.veeva.activity.length > 0 && <CategoryBar items={bio.veeva.activity} colorIndex={0} />}
                  </ChartCard>

                  <ChartCard title="생성 문서 구분" subtitle="문서 유형별"
                             empty={bio.veeva.docType.length === 0 ? "데이터 없음" : undefined}>
                    {bio.veeva.docType.length > 0 && <CategoryBar items={bio.veeva.docType} colorIndex={1} />}
                  </ChartCard>
                </div>

                {/* 임검분 LIMS · ELN 은 수동 업로드 기반 별도 리포트로, 대시보드에 아직 포함되지 않음 */}
                <p className="text-[11px]" style={{ color: INK.muted }}>
                  ※ 임검분 LIMS · 전자연구노트(ELN) 는 수동 업로드 기반 별도 보고서로, 이 대시보드에는 포함되지 않았습니다.
                </p>
              </section>
            )}

            {/* ── MS Timesheet ── */}
            {timesheet && timesheet.groups.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold" style={{ color: INK.primary }}>
                  Veeva MS Timesheet
                </h2>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
                  {timesheet.groups.map((g, i) => (
                    <ChartCard key={g.groupName} title={g.groupName} subtitle="월별 사용 MS">
                      <MonthlyBar data={g.chart} colorIndex={i} unit=" MS" />
                    </ChartCard>
                  ))}
                </div>
              </section>
            )}

            {/* ── 소스 상태 ── */}
            <section>
              <h2 className="text-sm font-semibold mb-2" style={{ color: INK.primary }}>
                데이터 소스 상태
              </h2>
              <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 space-y-4">
                <SourceList title="자동 수집" items={collected} />
                <SourceList title="수동 업로드" items={uploaded} />
              </div>
            </section>
          </>
        )}
      </div>
    </AppLayout>
  );
}

// ── 소스 목록 ─────────────────────────────────────────────────────────────────

function SourceList({
  title, items,
}: {
  title: string;
  items: DashboardResponse["sources"];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium mb-2" style={{ color: INK.muted }}>{title}</p>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
        {items.map((s) => (
          <li key={s.file} className="flex items-center gap-2 text-xs">
            <span aria-hidden style={{ color: s.present ? STATUS.good : STATUS.critical }}>
              {s.present ? "●" : "○"}
            </span>
            <span className="flex-1 truncate" style={{ color: INK.secondary }} title={s.file}>
              {s.label}
            </span>
            <span className="tabular-nums" style={{ color: INK.muted }}>
              {s.present ? `${fmtDateTime(s.updatedAt)} · ${fmtBytes(s.sizeBytes)}` : "없음"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
