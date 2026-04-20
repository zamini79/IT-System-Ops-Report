import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children:  ReactNode;
  /** 에러 발생 시 표시할 대체 UI (기본값: 내장 에러 카드) */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error:    Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 필요 시 외부 로깅 서비스로 전송
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="flex flex-col items-center justify-center min-h-[300px] gap-4 p-8">
        <div className="text-red-500">
          {/* 경고 아이콘 */}
          <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <div className="text-center">
          <h3 className="text-lg font-semibold text-gray-800 mb-1">
            오류가 발생했습니다
          </h3>
          <p className="text-sm text-gray-500 max-w-sm">
            {this.state.error?.message ?? "알 수 없는 오류입니다."}
          </p>
        </div>
        <button
          onClick={this.handleReset}
          className="px-4 py-2 text-sm font-medium text-white bg-secondary rounded-md hover:bg-secondary-600 transition-colors"
        >
          다시 시도
        </button>
      </div>
    );
  }
}
