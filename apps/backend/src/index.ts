// ⚠️ 반드시 첫 줄 — 다른 모듈이 process.env 를 읽기 전에 .env 를 적재한다.
//    (cwd 가 아니라 리포지토리 루트에서 찾는다. config/env.ts 주석 참고)
import "./config/env";
import path from "path";
import fs from "fs";
import app from "./app";
import { testConnection, runMigrations } from "./config/db";
import { logger } from "./utils/logger";
import { startCollectionScheduler, stopCollectionScheduler } from "./modules/dashboard/collection.scheduler";

const PORT = Number(process.env.PORT ?? 4000);

// ── 필수 디렉터리 사전 생성 ────────────────────────────────────────────────────
for (const dir of [
  process.env.UPLOAD_DIR ?? "uploads",
  process.env.OUTPUT_DIR ?? "outputs",
]) {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
    logger.info(`[Init] Created directory: ${resolved}`);
  }
}

// ── DB 연결 확인 후 서버 기동 ─────────────────────────────────────────────────
(async () => {
  try {
    await testConnection();
    await runMigrations();
  } catch (err) {
    logger.error("[DB] Connection failed — server will not start", {
      message: (err as Error).message,
    });
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    logger.info(`[Server] http://localhost:${PORT}  (${process.env.NODE_ENV ?? "development"})`);
  });

  // 대시보드 자동 수집 스케줄러 (매일 새벽) — DASHBOARD_CRON_ENABLED=false 로 끌 수 있음
  startCollectionScheduler();

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`[Server] ${signal} received — shutting down`);
    stopCollectionScheduler();
    server.close(() => {
      logger.info("[Server] HTTP server closed");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
})();
