// ── Common API response wrapper ───────────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  limit: number;
}

// ── User / Auth ───────────────────────────────────────────────────────────────
export type UserRole = "admin" | "manager" | "viewer";

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: Omit<User, "createdAt" | "updatedAt"> & {
    divisionCode: string | null;
  };
}

// ── IT Report ─────────────────────────────────────────────────────────────────
export type ReportStatus = "draft" | "submitted" | "approved" | "rejected";
export type ReportCategory =
  | "hardware"
  | "software"
  | "network"
  | "security"
  | "other";

export interface Report {
  id: string;
  title: string;
  category: ReportCategory;
  status: ReportStatus;
  content: string;
  authorId: string;
  attachments: Attachment[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateReportRequest {
  title: string;
  category: ReportCategory;
  content: string;
}

export interface UpdateReportRequest extends Partial<CreateReportRequest> {
  status?: ReportStatus;
}

// ── Attachment ────────────────────────────────────────────────────────────────
export interface Attachment {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  reportId: string;
  createdAt: string;
}

// ── Query params ──────────────────────────────────────────────────────────────
export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface ReportFilterParams extends PaginationParams {
  category?: ReportCategory;
  status?: ReportStatus;
  authorId?: string;
  search?: string;
}

// ── 운영 현황 대시보드 ─────────────────────────────────────────────────────────

export type DashboardDivisionCode = "BIO" | "DEV" | "LHOUSE";

/**
 * 본부별 고정 작업공간 jobId.
 *
 * 업로드 파일과 매일 자동 수집되는 파일이 같은 곳(UPLOAD_DIR/{jobId}/uploads)에 모이도록
 * 본부마다 고정된 UUID 를 사용한다. (기존 코드가 모두 jobId(UUID) 기준이라 경로 구조를
 * 바꾸지 않고 동일한 목적을 달성한다.)
 */
export const DASHBOARD_JOB_IDS: Record<DashboardDivisionCode, string> = {
  DEV:    "00000000-0000-4000-8000-000000000001",
  LHOUSE: "00000000-0000-4000-8000-000000000002",
  BIO:    "00000000-0000-4000-8000-000000000003",
};

/** 단일 시리즈 (월별 막대 등) */
export interface DashboardSeries {
  labels: string[];
  values: number[];
}

/** 다중 시리즈 (그룹 막대 — 월 × 유형) */
export interface DashboardGroupedSeries {
  labels: string[];
  series: { name: string; values: number[] }[];
}

/** 카테고리 집계 (도넛·카테고리 막대) */
export interface DashboardCategoryItem {
  category: string;
  value:    number;
}

/** 소스 파일 상태 — 수집/업로드 여부와 시각 */
export interface DashboardSourceStatus {
  /** 저장 파일명 (e.g. GCP_PerfStats.xlsx) */
  file:      string;
  label:     string;
  /** collected = 자동 수집 대상, uploaded = 사용자 업로드 대상 */
  kind:      "collected" | "uploaded";
  present:   boolean;
  updatedAt: string | null;
  sizeBytes: number | null;
}

/** KPI 카드 한 칸 */
export interface DashboardKpi {
  key:    string;
  label:  string;
  value:  number | null;
  unit:   string;
  /** 직전 기간 대비 증감 (없으면 null) */
  delta:  number | null;
}

/** 개발본부 대시보드 데이터 */
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
    groups: {
      groupName: string;
      chart:     DashboardSeries;
    }[];
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

/** 대시보드 조회 응답 */
export interface DashboardResponse<T = AnyDashboardData> {
  divisionCode:  DashboardDivisionCode;
  /** 스냅샷 기준일 (YYYY-MM-DD) — 없으면 아직 수집된 적 없음 */
  capturedDate:  string | null;
  updatedAt:     string | null;
  kpis:          DashboardKpi[];
  data:          T | null;
  sources:       DashboardSourceStatus[];
  /** 마지막 수집 실행 정보 */
  lastRun: {
    trigger:    string;
    status:     string;
    startedAt:  string;
    finishedAt: string | null;
    detail:     unknown;
  } | null;
}

/** 일별 추이 응답 */
export interface DashboardTrendResponse {
  divisionCode: DashboardDivisionCode;
  metric:       string;
  points:       { date: string; value: number | null }[];
}
