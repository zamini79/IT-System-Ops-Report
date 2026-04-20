import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import type { AccessPayload, AuthRequest, DivisionCode } from "./auth.types";

// Refresh Token 쿠키 이름 — service, controller와 공유
export const REFRESH_COOKIE = "skbs_rt";

// Refresh Token 쿠키 공통 옵션
export const refreshCookieOptions = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
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
