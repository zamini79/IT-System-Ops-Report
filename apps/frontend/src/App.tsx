/**
 * App — 라우터 최상위 구성
 *
 * /              → /dashboard (redirect)
 * /login         — 비인증 접근 가능
 *
 * PrivateRoute (인증 필수)
 *   /dashboard
 *   /bio-research
 *   /dev-division
 *   /lhouse
 *   /report/generate
 *   /report/history
 *   /mail/compose
 *
 * PrivateRoute adminOnly (role=admin 필수)
 *   /settings
 */

import { Routes, Route, Navigate } from "react-router-dom";
import { PrivateRoute }         from "./components/PrivateRoute";
import { LoginPage }            from "./pages/LoginPage";
import { DashboardPage }        from "./pages/DashboardPage";
import { BioResearchPage }      from "./pages/BioResearchPage";
import { DevDivisionPage }      from "./pages/DevDivisionPage";
import { LhousePage }           from "./pages/LhousePage";
import { ReportGeneratePage }   from "./pages/ReportGeneratePage";
import { ReportHistoryPage }    from "./pages/ReportHistoryPage";
import { MailCompose }          from "./pages/MailCompose";
import { Settings }             from "./pages/Settings";

export default function App() {
  return (
    <Routes>
      {/* 공개 라우트 */}
      <Route path="/login" element={<LoginPage />} />

      {/* 인증 필수 라우트 */}
      <Route element={<PrivateRoute />}>
        <Route path="/"               element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard"      element={<DashboardPage />} />
        <Route path="/bio-research"   element={<BioResearchPage />} />
        <Route path="/dev-division"   element={<DevDivisionPage />} />
        <Route path="/lhouse"         element={<LhousePage />} />
        <Route path="/report/generate" element={<ReportGeneratePage />} />
        <Route path="/report/history" element={<ReportHistoryPage />} />
        <Route path="/mail/compose"   element={<MailCompose />} />
      </Route>

      {/* 관리자 전용 라우트 */}
      <Route element={<PrivateRoute adminOnly />}>
        <Route path="/settings" element={<Settings />} />
      </Route>

      {/* fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
