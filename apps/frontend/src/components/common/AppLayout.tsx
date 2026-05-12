import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Header }  from "./Header";

interface Props {
  /** Header 에 표시될 페이지 제목 */
  title:    string;
  children: ReactNode;
  /**
   * false 로 설정하면 main 영역의 overflow-y-auto 와 padding wrapper 를 제거합니다.
   * 자체 스크롤 영역이 필요한 페이지(DivisionReportPage 등)에서 사용합니다.
   * 기본값: true
   */
  scroll?:  boolean;
}

/**
 * AppLayout
 *
 * ┌────────────┬──────────────────────────────┐
 * │            │  Header (sticky 60px)         │
 * │  Sidebar   ├──────────────────────────────┤
 * │  (240px)   │  <children> (scroll)         │
 * │            │                              │
 * └────────────┴──────────────────────────────┘
 */
export function AppLayout({ title, children, scroll = true }: Props) {
  const mainRef  = useRef<HTMLElement>(null);
  const location = useLocation();

  // 라우트 변경 시 스크롤을 상단으로 초기화
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname]);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar />

      {/* 우측 영역 */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header title={title} />

        {scroll ? (
          /* 기본: main 자체가 스크롤 컨테이너 */
          <main ref={mainRef} className="flex-1 overflow-y-auto">
            <div className="p-6 max-w-screen-xl mx-auto">
              {children}
            </div>
          </main>
        ) : (
          /* scroll=false: children 이 직접 스크롤 영역을 관리 */
          <main ref={mainRef} className="flex-1 overflow-hidden flex flex-col min-h-0">
            {children}
          </main>
        )}
      </div>
    </div>
  );
}
