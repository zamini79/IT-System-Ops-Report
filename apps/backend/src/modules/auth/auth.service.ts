import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { query } from "../../config/db";
import { AppError } from "../../utils/errors";
import {
  AccessPayload,
  RefreshPayload,
  LoginResponse,
  UserRow,
} from "./auth.types";

// ── 환경 변수 ─────────────────────────────────────────────────────────────────
const ACCESS_SECRET  = () => process.env.JWT_SECRET          ?? "access_secret_dev";
const REFRESH_SECRET = () => process.env.JWT_REFRESH_SECRET  ?? "refresh_secret_dev";
const ACCESS_TTL     = "15m";
const REFRESH_TTL    = "7d";

// ── 토큰 생성 헬퍼 ────────────────────────────────────────────────────────────
function signAccess(payload: AccessPayload): string {
  return jwt.sign(payload, ACCESS_SECRET(), { expiresIn: ACCESS_TTL });
}

function signRefresh(userId: string): string {
  const p: RefreshPayload = { sub: userId, type: "refresh" };
  return jwt.sign(p, REFRESH_SECRET(), { expiresIn: REFRESH_TTL });
}

// ── 서비스 ────────────────────────────────────────────────────────────────────

/**
 * 이메일 + 비밀번호로 로그인.
 * Access Token(15분)과 Refresh Token(7일)을 반환합니다.
 */
export async function login(
  email: string,
  password: string
): Promise<{ loginResponse: LoginResponse; refreshToken: string }> {
  const rows = await query<UserRow>(
    `SELECT
       u.id,
       u.email,
       u.password_hash,
       u.name,
       u.role,
       d.id   AS division_id,
       d.code AS division_code
     FROM users u
     LEFT JOIN divisions d ON d.id = u.division_id
     WHERE u.email = $1
     LIMIT 1`,
    [email]
  );

  const user = rows[0];

  // 사용자 없음 또는 비밀번호 불일치 — 동일 메시지로 응답 (계정 존재 여부 노출 방지)
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new AppError(401, "이메일 또는 비밀번호가 올바르지 않습니다.");
  }

  const accessPayload: AccessPayload = {
    sub:          user.id,
    email:        user.email,
    name:         user.name,
    role:         user.role,
    divisionId:   user.division_id,
    divisionCode: user.division_code,
  };

  const accessToken  = signAccess(accessPayload);
  const refreshToken = signRefresh(user.id);

  return {
    refreshToken,
    loginResponse: {
      accessToken,
      user: {
        id:           user.id,
        email:        user.email,
        name:         user.name,
        role:         user.role,
        divisionCode: user.division_code,
      },
    },
  };
}

/**
 * Refresh Token 검증 후 새 Access Token(+ Refresh Token 교체)을 반환합니다.
 * 토큰 로테이션으로 탈취된 Refresh Token 재사용 방지.
 */
export async function refresh(
  refreshToken: string
): Promise<{ accessToken: string; newRefreshToken: string }> {
  let payload: RefreshPayload;

  try {
    payload = jwt.verify(refreshToken, REFRESH_SECRET()) as RefreshPayload;
  } catch {
    throw new AppError(401, "Refresh Token이 유효하지 않거나 만료되었습니다.");
  }

  if (payload.type !== "refresh") {
    throw new AppError(401, "유효하지 않은 토큰 타입입니다.");
  }

  // DB에서 최신 사용자 정보 조회 (role·division 변경 반영)
  const rows = await query<UserRow>(
    `SELECT
       u.id, u.email, u.name, u.role,
       d.id   AS division_id,
       d.code AS division_code
     FROM users u
     LEFT JOIN divisions d ON d.id = u.division_id
     WHERE u.id = $1
     LIMIT 1`,
    [payload.sub]
  );

  const user = rows[0];
  if (!user) throw new AppError(401, "사용자를 찾을 수 없습니다.");

  const accessPayload: AccessPayload = {
    sub:          user.id,
    email:        user.email,
    name:         user.name,
    role:         user.role,
    divisionId:   user.division_id,
    divisionCode: user.division_code,
  };

  return {
    accessToken:     signAccess(accessPayload),
    newRefreshToken: signRefresh(user.id),   // 토큰 로테이션
  };
}

/**
 * 현재 로그인 사용자 정보 조회 (DB에서 최신 데이터).
 */
export async function getMe(userId: string) {
  const rows = await query<Omit<UserRow, "password_hash">>(
    `SELECT
       u.id, u.email, u.name, u.role,
       u.created_at,
       d.id   AS division_id,
       d.code AS division_code,
       d.name AS division_name
     FROM users u
     LEFT JOIN divisions d ON d.id = u.division_id
     WHERE u.id = $1
     LIMIT 1`,
    [userId]
  );

  const user = rows[0];
  if (!user) throw new AppError(404, "사용자를 찾을 수 없습니다.");
  return user;
}
