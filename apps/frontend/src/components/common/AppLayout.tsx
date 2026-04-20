import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Header }  from "./Header";

interface Props {
  /** Header 에 표시될 페이지 제목 */
  title:    string;
  children: ReactNode;
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
export function AppLayout({ title, children }: Props) {
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

        {/* 스크롤 가능한 콘텐츠 영역 */}
        <main ref={mainRef} className="flex-1 overflow-y-auto">
          <div className="p-6 max-w-screen-xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
