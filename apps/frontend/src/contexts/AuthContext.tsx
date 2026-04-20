/**
 * AuthContext
 *
 * 인증 상태를 전역으로 관리합니다.
 * - localStorage(token / user)를 Single Source of Truth로 초기화
 * - login(): API 호출 → 저장 → 상태 갱신
 * - logout(): 저장소 초기화 → 상태 갱신 → /login 이동
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { apiClient } from "../api/client";
import type { LoginRequest, LoginResponse, UserRole } from "@skbs/shared";

// ── 타입 ──────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id:           string;
  name:         string;
  email:        string;
  role:         UserRole;
  divisionCode: string | null;
}

export interface AuthContextValue {
  user:            AuthUser | null;
  isAuthenticated: boolean;
  isLoading:       boolean;
  login:           (credentials: LoginRequest) => Promise<void>;
  logout:          () => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

export const AuthContext = createContext<AuthContextValue | null>(null);

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

function readStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem("user");
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  const [user,      setUser]      = useState<AuthUser | null>(readStoredUser);
  const [isLoading, setIsLoading] = useState(false);

  const login = useCallback(async (credentials: LoginRequest) => {
    setIsLoading(true);
    try {
      const { data } = await apiClient.post<{ success: boolean; data: LoginResponse }>(
        "/auth/login",
        credentials
      );
      // 백엔드는 accessToken 필드를 사용 (shared LoginResponse 의 token 과 매핑)
      const raw = data.data as LoginResponse & { accessToken?: string };
      const token   = raw.token ?? raw.accessToken ?? "";
      const apiUser = raw.user;
      const authUser: AuthUser = {
        id:           apiUser.id,
        name:         apiUser.name,
        email:        apiUser.email,
        role:         apiUser.role,
        divisionCode: apiUser.divisionCode ?? null,
      };
      localStorage.setItem("token", token);
      localStorage.setItem("user",  JSON.stringify(authUser));
      setUser(authUser);
      navigate("/dashboard", { replace: true });
    } finally {
      setIsLoading(false);
    }
  }, [navigate]);

  const logout = useCallback(() => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setUser(null);
    navigate("/login", { replace: true });
  }, [navigate]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user && !!localStorage.getItem("token"),
        isLoading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ── useAuth hook ──────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
