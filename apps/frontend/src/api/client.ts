import axios, { type InternalAxiosRequestConfig } from "axios";

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api") as string;

export const apiClient = axios.create({
  baseURL:         BASE_URL,
  headers:         { "Content-Type": "application/json" },
  withCredentials: true, // Refresh Token httpOnly 쿠키 전송에 필요
});

// ── 요청 인터셉터: Access Token 첨부 ─────────────────────────────────────────

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;

  // FormData 전송 시 Content-Type 헤더를 제거해야 브라우저가
  // multipart/form-data; boundary=... 를 올바르게 자동 설정함.
  // 기본값 application/json 이 남아 있으면 multer 가 파일을 파싱하지 못함.
  if (config.data instanceof FormData) {
    delete config.headers["Content-Type"];
  }

  return config;
});

// ── 토큰 갱신 상태 관리 ──────────────────────────────────────────────────────

let isRefreshing = false;
let pendingQueue: Array<{
  resolve: (token: string) => void;
  reject:  (err: unknown) => void;
}> = [];

function flushQueue(token: string | null, err: unknown = null) {
  pendingQueue.forEach((p) => (token ? p.resolve(token) : p.reject(err)));
  pendingQueue = [];
}

function clearAuthAndRedirect() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  window.location.replace("/login");
}

// ── 응답 인터셉터: 401 → Refresh Token으로 재발급 후 원본 요청 재시도 ────────

type RetryConfig = InternalAxiosRequestConfig & { _retry?: boolean };

apiClient.interceptors.response.use(
  (res) => res,
  async (err: unknown) => {
    if (!axios.isAxiosError(err)) return Promise.reject(err);

    const original = err.config as RetryConfig | undefined;
    const status   = err.response?.status;

    // Refresh 엔드포인트 자체가 401이면 세션 만료 — 로그인으로 이동
    if (original?.url?.includes("/auth/refresh")) {
      clearAuthAndRedirect();
      return Promise.reject(err);
    }

    // 401이 아니거나 이미 재시도한 요청은 그대로 reject
    if (status !== 401 || !original || original._retry) {
      return Promise.reject(err);
    }

    original._retry = true;

    // 이미 갱신 중이면 완료까지 대기
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        pendingQueue.push({
          resolve: (token) => {
            original.headers.Authorization = `Bearer ${token}`;
            resolve(apiClient(original));
          },
          reject,
        });
      });
    }

    isRefreshing = true;

    try {
      // Refresh Token은 httpOnly 쿠키로 자동 전송됨
      const { data } = await axios.post<{
        success: boolean;
        data: { accessToken: string };
      }>(
        `${BASE_URL}/auth/refresh`,
        {},
        { withCredentials: true }
      );

      const newToken = data.data.accessToken;
      localStorage.setItem("token", newToken);
      apiClient.defaults.headers.common.Authorization = `Bearer ${newToken}`;

      flushQueue(newToken);

      original.headers.Authorization = `Bearer ${newToken}`;
      return apiClient(original);
    } catch (refreshErr) {
      flushQueue(null, refreshErr);
      clearAuthAndRedirect();
      return Promise.reject(refreshErr);
    } finally {
      isRefreshing = false;
    }
  }
);
