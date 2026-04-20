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
