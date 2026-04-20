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


// ── CORS ───────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // curl / Postman 등 origin 없는 요청은 개발 환경에서만 허용
      if (!origin && process.env.NODE_ENV !== "production") return callback(null, true);
      if (origin && allowedOrigins.includes(origin)) return callback(null, true);
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


// ── Health check ───────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});


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
