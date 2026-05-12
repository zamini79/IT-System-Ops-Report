import { NavLink } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";

// ── 네비게이션 정의 ───────────────────────────────────────────────────────────

interface NavItem {
  to:        string;
  label:     string;
  icon:      JSX.Element;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    to:    "/dashboard",
    label: "대시보드",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
];

const DIV_ITEMS: NavItem[] = [
  {
    to:    "/bio-research",
    label: "Bio연구본부",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
      </svg>
    ),
  },
  {
    to:    "/dev-division",
    label: "개발본부",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
    ),
  },
  {
    to:    "/lhouse",
    label: "L HOUSE 공장",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
      </svg>
    ),
  },
];

const REPORT_ITEMS: NavItem[] = [
  {
    to:    "/report/history",
    label: "보고서 History",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

const ADMIN_ITEMS: NavItem[] = [
  {
    to:        "/settings",
    label:     "설정",
    adminOnly: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

const LINK_BASE =
  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150";
const LINK_INACTIVE = "text-primary-200 hover:bg-primary-600 hover:text-white";
const LINK_ACTIVE   = "bg-secondary text-white shadow-sm";

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pt-4 pb-1 text-[10px] font-semibold tracking-widest uppercase text-primary-300">
      {children}
    </p>
  );
}

function NavGroup({ items }: { items: NavItem[] }) {
  return (
    <>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            `${LINK_BASE} ${isActive ? LINK_ACTIVE : LINK_INACTIVE}`
          }
        >
          {item.icon}
          <span>{item.label}</span>
        </NavLink>
      ))}
    </>
  );
}

export function Sidebar() {
  const { user } = useAuth();

  return (
    <aside className="w-60 flex-shrink-0 bg-primary flex flex-col h-screen sticky top-0">
      {/* 로고 */}
      <div className="px-5 py-5 border-b border-primary-600">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div>
            <p className="text-white text-sm font-bold leading-tight">SKBS IT</p>
            <p className="text-primary-300 text-[10px] leading-tight">System Report</p>
          </div>
        </div>
      </div>

      {/* 네비게이션 */}
      <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5">
        <NavGroup items={NAV_ITEMS} />

        <SectionLabel>사업부</SectionLabel>
        <NavGroup items={DIV_ITEMS} />

        <SectionLabel>보고서</SectionLabel>
        <NavGroup items={REPORT_ITEMS} />

        {user?.role === "admin" && (
          <>
            <SectionLabel>관리</SectionLabel>
            <NavGroup items={ADMIN_ITEMS} />
          </>
        )}
      </nav>

      {/* 하단 버전 */}
      <div className="px-5 py-3 border-t border-primary-600">
        <p className="text-[10px] text-primary-400">v1.0.0 · SKBS IT Ops</p>
      </div>
    </aside>
  );
}
