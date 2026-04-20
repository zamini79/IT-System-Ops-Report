import { useAuth } from "../../hooks/useAuth";

const ROLE_LABEL: Record<string, string> = {
  admin:   "관리자",
  manager: "매니저",
  viewer:  "뷰어",
};

interface Props {
  /** 현재 페이지 제목 */
  title: string;
}

export function Header({ title }: Props) {
  const { user, logout } = useAuth();

  return (
    <header className="sticky top-0 z-30 bg-white border-b border-gray-200 h-14 flex items-center px-6 gap-4">
      {/* 페이지 제목 */}
      <h1 className="text-base font-semibold text-primary flex-1 truncate">{title}</h1>

      {/* 사용자 정보 */}
      <div className="flex items-center gap-3">
        {/* 아바타 */}
        <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
          <span className="text-white text-xs font-bold">
            {user?.name?.charAt(0).toUpperCase() ?? "?"}
          </span>
        </div>

        <div className="hidden sm:block text-right leading-tight">
          <p className="text-sm font-medium text-gray-800 leading-none">{user?.name}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {user?.role ? ROLE_LABEL[user.role] ?? user.role : ""}
          </p>
        </div>

        {/* 구분선 */}
        <div className="w-px h-5 bg-gray-200 mx-1" />

        {/* 로그아웃 */}
        <button
          onClick={logout}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-600 transition-colors"
          title="로그아웃"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          <span className="hidden sm:inline">로그아웃</span>
        </button>
      </div>
    </header>
  );
}
