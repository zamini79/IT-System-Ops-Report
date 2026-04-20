import { Request } from "express";

// ── DB enum 값과 일치 ─────────────────────────────────────────────────────────
export type UserRole     = "admin" | "manager" | "viewer";
export type DivisionCode = "BIO" | "DEV" | "LHOUSE";

// ── JWT 페이로드 ──────────────────────────────────────────────────────────────
export interface AccessPayload {
  sub:          string;           // users.id (UUID)
  email:        string;
  name:         string;
  role:         UserRole;
  divisionId:   string | null;    // divisions.id
  divisionCode: DivisionCode | null;
}

export interface RefreshPayload {
  sub:  string;   // users.id
  type: "refresh";
}

// ── Request 확장 ──────────────────────────────────────────────────────────────
// user 는 authGuard 통과 후 반드시 존재하지만, Express RequestHandler 호환을 위해 optional로 선언
export interface AuthRequest extends Request {
  user?: AccessPayload;
}

// ── DB 조회 결과 row 타입 ─────────────────────────────────────────────────────
export interface UserRow {
  id:            string;
  email:         string;
  password_hash: string;
  name:          string;
  role:          UserRole;
  division_id:   string | null;
  division_code: DivisionCode | null;
}

// ── HTTP 응답 타입 ────────────────────────────────────────────────────────────
export interface LoginResponse {
  accessToken: string;
  user: {
    id:           string;
    email:        string;
    name:         string;
    role:         UserRole;
    divisionCode: DivisionCode | null;
  };
}
