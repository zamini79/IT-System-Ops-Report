import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import type { AccessPayload, AuthRequest, DivisionCode } from "./auth.types";

// Refresh Token 쿠키 이름 — service, controller와 공유
export const REFRESH_COOKIE = "skbs_rt";

// Refresh Token 쿠키 공통 옵션
//
// ── 왜 NODE_ENV 에 직결하지 않는가 ────────────────────────────────────────────
//  예전에는 `secure: isProd`, `sameSite: isProd ? "none" : "strict"` 였다.
//  프론트(Vercel)와 백엔드(Railway)가 **다른 도메인**인 구성을 전제한 값이다.
//  그런데 쿠키 플래그를 결정하는 것은 배포 모드가 아니라 두 가지 사실이다:
//    · HTTPS 로 서비스하는가            → Secure
//    · 프론트와 API 가 다른 사이트인가  → SameSite=None
//  nginx 가 /api 를 같은 출처로 프록시하는 구성(ECS·온프레미스)에서는
//  SameSite=Lax 로 충분하고 None 보다 안전하다. 또 평문 http 로 띄우면
//  Secure 쿠키는 브라우저가 조용히 버려서 로그인이 되는 것처럼 보이다가
//  세션 갱신이 401 로 실패한다(실제로 로컬 컨테이너에서 겪었다).
//  그래서 두 값을 각각 환경변수로 분리한다.
//
//  COOKIE_SECURE    기본값: 프로덕션이면 true. 평문 http 로 띄울 때만 false
//  COOKIE_SAMESITE  기본값: lax(같은 출처). 프론트/API 가 다른 사이트면 none
const isProd = process.env.NODE_ENV === "production";

const sameSiteEnv = (process.env.COOKIE_SAMESITE ?? (isProd ? "lax" : "strict"))
  .toLowerCase() as "none" | "lax" | "strict";

// SameSite=None 은 Secure 없이는 브라우저가 거부하므로 함께 강제한다.
const secure =
  sameSiteEnv === "none" ? true
  : process.env.COOKIE_SECURE !== undefined ? process.env.COOKIE_SECURE === "true"
  : isProd;

export const refreshCookieOptions = {
  httpOnly: true,
  secure,
  sameSite: sameSiteEnv,
  maxAge:   7 * 24 * 60 * 60 * 1000,   // 7일 (ms)
  path:     "/api/auth",                 // refresh·logout 엔드포인트에만 전송
};

// ── authGuard ─────────────────────────────────────────────────────────────────
/**
 * Authorization: Bearer <accessToken> 헤더를 검증합니다.
 * 성공 시 req.user 에 페이로드를 주입합니다.
 */
export const authGuard: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const header = req.headers.authorization;

  // EventSource(SSE)는 커스텀 헤더를 보낼 수 없으므로 ?token= 쿼리 파라미터 허용
  const queryToken = req.query.token as string | undefined;

  if (!header?.startsWith("Bearer ") && !queryToken) {
    res.status(401).json({ success: false, error: "인증 토큰이 없습니다." });
    return;
  }

  const token = header ? header.slice(7) : queryToken!;
  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET ?? "access_secret_dev"
    ) as AccessPayload;

    // refresh 토큰을 access 엔드포인트에 사용하는 것을 차단
    if ((payload as unknown as { type?: string }).type === "refresh") {
      res.status(401).json({ success: false, error: "유효하지 않은 토큰 타입입니다." });
      return;
    }

    (req as AuthRequest).user = payload;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ success: false, error: "토큰이 만료되었습니다." });
      return;
    }
    res.status(401).json({ success: false, error: "유효하지 않은 토큰입니다." });
  }
};

// ── adminGuard ────────────────────────────────────────────────────────────────
/**
 * role === 'admin' 인 사용자만 통과시킵니다.
 * authGuard 다음에 사용하세요.
 */
export const adminGuard: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const user = (req as AuthRequest).user;
  if (user?.role !== "admin") {
    res.status(403).json({ success: false, error: "관리자 권한이 필요합니다." });
    return;
  }
  next();
};

// ── divisionGuard ─────────────────────────────────────────────────────────────
/**
 * 요청 사용자의 division 이 허용 목록에 포함되는지 확인합니다.
 * role === 'admin' 은 모든 사업부에 접근 가능합니다.
 *
 * 사용 예)
 *   router.get('/reports', authGuard, divisionGuard('BIO', 'DEV'), handler)
 */
export function divisionGuard(...allowedCodes: DivisionCode[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthRequest).user;

    // authGuard 없이 단독 사용한 경우 방어
    if (!user) {
      res.status(401).json({ success: false, error: "인증이 필요합니다." });
      return;
    }

    // admin은 사업부 제한 없이 전체 접근 허용
    if (user.role === "admin") {
      next();
      return;
    }

    if (!user.divisionCode || !allowedCodes.includes(user.divisionCode)) {
      res.status(403).json({
        success: false,
        error: `이 리소스에 접근할 수 없는 사업부입니다. (허용: ${allowedCodes.join(", ")})`,
      });
      return;
    }

    next();
  };
}

// ── AuthRequest re-export ─────────────────────────────────────────────────────
export type { AuthRequest };
