import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

interface Props {
  open:      boolean;
  onClose:   () => void;
  title?:    string;
  children:  ReactNode;
  footer?:   ReactNode;
  size?:     ModalSize;
  /** Esc 키 / 배경 클릭으로 닫기 허용 여부 (기본 true) */
  closable?: boolean;
}

const SIZE_CLASS: Record<ModalSize, string> = {
  sm:   "max-w-sm",
  md:   "max-w-md",
  lg:   "max-w-lg",
  xl:   "max-w-2xl",
  full: "max-w-5xl",
};

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  closable = true,
}: Props) {
  // ESC 키 닫기
  useEffect(() => {
    if (!open || !closable) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, closable, onClose]);

  // 모달 열릴 때 body 스크롤 잠금
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      aria-modal="true"
      role="dialog"
    >
      {/* 배경 오버레이 */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity"
        onClick={closable ? onClose : undefined}
      />

      {/* 패널 */}
      <div
        className={`relative z-10 w-full ${SIZE_CLASS[size]} bg-white rounded-xl shadow-2xl flex flex-col max-h-[90vh]`}
      >
        {/* 헤더 */}
        {(title || closable) && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
            {title && (
              <h2 className="text-base font-semibold text-gray-800">{title}</h2>
            )}
            {closable && (
              <button
                onClick={onClose}
                className="ml-auto p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                aria-label="닫기"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* 본문 */}
        <div className="px-6 py-4 overflow-y-auto flex-1">{children}</div>

        {/* 푸터 */}
        {footer && (
          <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2 flex-shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
