/**
 * 대시보드 타입 (백엔드 로컬 정의)
 *
 * ※ 백엔드 tsconfig 는 rootDir="./src" 라서 packages/shared 를 직접 임포트할 수 없다
 *   (dist 산출물 경로가 바뀌어 프로덕션 빌드가 깨진다).
 *   프론트엔드용 동일 정의가 `packages/shared/src/index.ts` 에 있으므로,
 *   **한쪽을 수정하면 반드시 다른 쪽도 함께 수정**해야 한다.
 */

export type DashboardDivisionCode = "BIO" | "DEV" | "LHOUSE";

/**
 * 본부별 고정 작업공간 jobId.
 * 업로드 파일과 매일 자동 수집되는 파일이 같은 곳(UPLOAD_DIR/{jobId}/uploads)에 모이도록
 * 본부마다 고정된 UUID 를 사용한다.
 */
export const DASHBOARD_JOB_IDS: Record<DashboardDivisionCode, string> = {
  DEV:    "00000000-0000-4000-8000-000000000001",
  LHOUSE: "00000000-0000-4000-8000-000000000002",
  BIO:    "00000000-0000-4000-8000-000000000003",
};

export interface DashboardSeries {
  labels: string[];
  values: number[];
}

export interface DashboardGroupedSeries {
  labels: string[];
  series: { name: string; values: number[] }[];
}

export interface DashboardCategoryItem {
  category: string;
  value:    number;
}

export interface DashboardSourceStatus {
  file:      string;
  label:     string;
  kind:      "collected" | "uploaded";
  present:   boolean;
  updatedAt: string | null;
  sizeBytes: number | null;
}

export interface DashboardKpi {
  key:   string;
  label: string;
  value: number | null;
  unit:  string;
  delta: number | null;
}

export interface DevDashboardData {
  gcp: {
    labels:      string[];
    docCount:    DashboardSeries | null;
    activeUser:  DashboardSeries | null;
    uniqueLogin: DashboardSeries | null;
    training:    DashboardSeries | null;
    quality:     DashboardGroupedSeries | null;
    activity:    DashboardCategoryItem[];
    insight:     string[];
  } | null;
  medcomms: {
    labels:   string[];
    docMgmt:  DashboardSeries | null;
    user:     DashboardSeries | null;
    login:    DashboardSeries | null;
    review:   DashboardGroupedSeries | null;
    docType:  DashboardCategoryItem[];
    activity: DashboardCategoryItem[];
    insight:  string[];
  } | null;
  ctms: {
    labels:  string[];
    user:    DashboardSeries | null;
    login:   DashboardSeries | null;
    study:   DashboardGroupedSeries | null;
    insight: string[];
  } | null;
  timesheet: {
    groups: { groupName: string; chart: DashboardSeries }[];
  } | null;
}

/** L HOUSE 공장 대시보드 데이터 */
export interface LhouseDashboardData {
  veeva: {
    labels:      string[];
    docCount:    DashboardSeries | null;
    activeUser:  DashboardSeries | null;
    uniqueLogin: DashboardSeries | null;
    quality:     DashboardGroupedSeries | null;
    training:    DashboardSeries | null;
    activity:    DashboardCategoryItem[];
    insight:     string[];
  } | null;
  timesheet: {
    groups: { groupName: string; chart: DashboardSeries }[];
  } | null;
}

/** Bio연구본부 대시보드 데이터 (Veeva eDMS — 자동 수집분) */
export interface BioDashboardData {
  veeva: {
    labels:      string[];
    docCount:    DashboardSeries | null;
    activeUser:  DashboardSeries | null;
    uniqueLogin: DashboardSeries | null;
    activity:    DashboardCategoryItem[];
    docType:     DashboardCategoryItem[];
    insight:     string[];
  } | null;
  timesheet: {
    groups: { groupName: string; chart: DashboardSeries }[];
  } | null;
}

/** 본부별 대시보드 데이터 유니온 */
export type AnyDashboardData = DevDashboardData | LhouseDashboardData | BioDashboardData;

export interface DashboardResponse<T = AnyDashboardData> {
  divisionCode: DashboardDivisionCode;
  capturedDate: string | null;
  updatedAt:    string | null;
  kpis:         DashboardKpi[];
  data:         T | null;
  sources:      DashboardSourceStatus[];
  lastRun: {
    trigger:    string;
    status:     string;
    startedAt:  string;
    finishedAt: string | null;
    detail:     unknown;
  } | null;
}

export interface DashboardTrendResponse {
  divisionCode: DashboardDivisionCode;
  metric:       string;
  points:       { date: string; value: number | null }[];
}
