import { Request, Response, NextFunction } from "express";
import * as authService from "./auth.service";
import { AuthRequest } from "./auth.types";
import { REFRESH_COOKIE, refreshCookieOptions } from "./auth.guard";

// ── POST /api/auth/login ──────────────────────────────────────────────────────
export async function login(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { email, password } = req.body as { email: string; password: string };

    if (!email || !password) {
      res.status(400).json({ success: false, error: "이메일과 비밀번호를 입력해주세요." });
      return;
    }

    const { loginResponse, refreshToken } = await authService.login(email, password);

    // Refresh Token → httpOnly 쿠키
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions);

    res.json({ success: true, data: loginResponse });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
export async function refresh(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;

    if (!refreshToken) {
      res.status(401).json({ success: false, error: "Refresh Token이 없습니다." });
      return;
    }

    const { accessToken, newRefreshToken } = await authService.refresh(refreshToken);

    // 토큰 로테이션: 새 Refresh Token으로 교체
    res.cookie(REFRESH_COOKIE, newRefreshToken, refreshCookieOptions);

    res.json({ success: true, data: { accessToken } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
export async function logout(
  _req: Request,
  res: Response
): Promise<void> {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: refreshCookieOptions.httpOnly,
    secure:   refreshCookieOptions.secure,
    sameSite: refreshCookieOptions.sameSite,
    path:     refreshCookieOptions.path,
  });

  res.json({ success: true, message: "로그아웃되었습니다." });
}

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
export async function me(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = await authService.getMe(req.user!.sub);
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}
