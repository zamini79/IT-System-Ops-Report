import express, {
  Application,
  Request,
  Response,
  NextFunction,
} from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import path from "path";

import { logger } from "./utils/logger";
import { AppError } from "./utils/errors";
import { router } from "./routes";

export { AppError };

// ── Express 앱 생성 ────────────────────────────────────────────────────────────
const app: Application = express();


// ── 보안 헤더 ──────────────────────────────────────────────────────────────────
app.use(helmet());


// ── Health check ───────────────────────────────────────────────────────────────
// 어떤 미들웨어보다 먼저 등록한다. ALB/ECS 헬스체크가 CORS·helmet 에 걸려
// 실패하면 태스크가 unhealthy 로 계속 교체된다.
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});


// ── CORS ───────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

// *.vercel.app 패턴 매칭 (Vercel 프리뷰 배포 포함)
const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  // Vercel 배포 도메인 자동 허용
  if (/^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/.test(origin)) return true;
  return false;
};

app.use(
  cors({
    origin: (origin, callback) => {
      // Origin 헤더가 없는 요청은 허용한다.
      //   CORS 는 브라우저의 교차 출처 요청을 막는 장치다. Origin 이 없는 요청은
      //   애초에 교차 출처 브라우저 요청이 아니므로 막아도 얻는 보안 이득이 없고,
      //   대신 아래가 전부 깨진다:
      //     · ALB/ECS 헬스체크 (Origin 을 보내지 않음) → 태스크가 계속 재시작
      //     · nginx 가 /api 를 같은 출처로 프록시하는 구성에서 브라우저 GET
      //       (같은 출처 요청은 Origin 을 붙이지 않는다) → 앱 전체가 동작 불가
      //     · 서버 간 호출 / curl / 모니터링
      //   인증은 JWT 가, CSRF 는 쿠키의 SameSite 가 담당한다.
      if (!origin) return callback(null, true);
      if (isAllowedOrigin(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
  })
);


// ── HTTP 요청 로그 (morgan → winston) ─────────────────────────────────────────
const morganStream = {
  write: (message: string) => logger.http(message.trimEnd()),
};

app.use(
  morgan(
    process.env.NODE_ENV === "production"
      ? "combined"   // Apache combined 포맷
      : "dev",       // 색상 있는 간결한 포맷
    { stream: morganStream }
  )
);


// ── Cookie 파싱 ────────────────────────────────────────────────────────────────
app.use(cookieParser());


// ── Body 파싱 ──────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));


// ── 정적 파일 서빙 ─────────────────────────────────────────────────────────────
const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "uploads");
const outputDir = path.resolve(process.env.OUTPUT_DIR ?? "outputs");

app.use("/uploads", express.static(uploadDir));
app.use("/outputs", express.static(outputDir));


// ── API 라우터 ─────────────────────────────────────────────────────────────────
app.use("/api", router);


// ── 404 핸들러 ─────────────────────────────────────────────────────────────────
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: `Cannot ${req.method} ${req.path}`,
  });
});


// ── 글로벌 에러 핸들러 ─────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    // 예측된 운영 오류 (클라이언트 잘못된 요청 등)
    logger.warn(`[AppError] ${err.message}`, { statusCode: err.statusCode });
    return res.status(err.statusCode).json({ success: false, error: err.message });
  }

  // 예상치 못한 서버 오류
  logger.error(`[UnhandledError] ${err.message}`, { stack: err.stack });
  res.status(500).json({
    success: false,
    error:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
  });
});


export default app;
