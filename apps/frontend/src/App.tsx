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
import { OpsDashboardPage }     from "./pages/OpsDashboardPage";
import { BioResearchPage }      from "./pages/BioResearchPage";
import { DevDivisionPage }      from "./pages/DevDivisionPage";
import { LhousePage }           from "./pages/LhousePage";
import { ReportGeneratePage }   from "./pages/ReportGeneratePage";
import { ReportHistoryPage }    from "./pages/ReportHistoryPage";
import { MailCompose }          from "./pages/MailCompose";
import { Settings }             from "./pages/Settings";
import { JobProgressProvider }  from "./contexts/JobProgressContext";

export default function App() {
  return (
    // 수집/보고서 진행 상태를 Routes **밖**에 둔다.
    //  화면을 전환해도 SSE 구독과 진행 플래그가 유지되어야 하기 때문이다.
    //  (자세한 이유는 contexts/JobProgressContext.tsx 주석 참고)
    <JobProgressProvider>
    <Routes>
      {/* 공개 라우트 */}
      <Route path="/login" element={<LoginPage />} />

      {/* 인증 필수 라우트 */}
      <Route element={<PrivateRoute />}>
        <Route path="/"               element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard"      element={<DashboardPage />} />
        {/* 본부별 운영 현황 대시보드 (매일 새벽 자동 수집된 스냅샷 조회) */}
        <Route path="/ops/:divisionCode" element={<OpsDashboardPage />} />
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
    </JobProgressProvider>
  );
}
