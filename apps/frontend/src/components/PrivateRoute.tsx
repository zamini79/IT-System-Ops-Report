/**
 * PrivateRoute / AdminRoute
 *
 * - 미인증: /login 리다이렉트
 * - adminOnly=true + role !== "admin": /dashboard 리다이렉트
 */

import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

interface Props {
  adminOnly?: boolean;
}

export function PrivateRoute({ adminOnly = false }: Props) {
  const { isAuthenticated, user } = useAuth();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (adminOnly && user?.role !== "admin") {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
