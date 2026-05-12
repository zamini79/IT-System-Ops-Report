/**
 * Crawl Router
 *
 * POST /api/crawl/start          — 크롤 잡 시작 (사업부 전체 시스템 순차 실행)
 * GET  /api/crawl/:jobId/stream  — SSE 진행 상태 스트리밍
 * GET  /api/crawl/:jobId/status  — 현재 잡 상태 조회 (REST)
 * GET  /api/crawl/               — 태스크 목록
 * GET  /api/crawl/:taskId        — 단일 태스크 조회
 * PATCH /api/crawl/:taskId/retry — 태스크 재시도
 */

import { Router, Request, Response, NextFunction } from "express";
import { divisionGuard }        from "../auth/auth.guard";
import type { AuthRequest }     from "../auth/auth.types";
import { respond }              from "../../utils/response";
import {
  startCrawlHandler,
  streamCrawlHandler,
  getJobStatusHandler,
  screenshotHandler,
  veevaDashboardHandler,
} from "./crawl.controller";

export const crawlRouter = Router();

// ---------------------------------------------------------------------------
// POST /api/crawl/start
// 해당 사업부의 모든 시스템 크롤러를 순서대로 실행
// ---------------------------------------------------------------------------
crawlRouter.post("/start", startCrawlHandler);

// ---------------------------------------------------------------------------
// POST /api/crawl/screenshot
// 로그인 후 지정 URL 스크린샷 캡처 (비동기, SSE로 완료 알림)
// ---------------------------------------------------------------------------
crawlRouter.post("/screenshot", screenshotHandler);

// ---------------------------------------------------------------------------
// POST /api/crawl/veeva-dashboard
// Veeva 대시보드 6개 차트 스크린샷 캡처 (임시 기능, SSE로 완료 알림)
// ---------------------------------------------------------------------------
crawlRouter.post("/veeva-dashboard", veevaDashboardHandler);

// ---------------------------------------------------------------------------
// GET /api/crawl/:jobId/stream  (SSE)
// Content-Type: text/event-stream
// 인증: Authorization: Bearer <token>  또는  ?token=<accessToken>
// ---------------------------------------------------------------------------
crawlRouter.get("/:jobId/stream", streamCrawlHandler);

// ---------------------------------------------------------------------------
// GET /api/crawl/:jobId/status  — 현재 잡 진행 상태 REST 조회
// ---------------------------------------------------------------------------
crawlRouter.get("/:jobId/status", getJobStatusHandler);

// ---------------------------------------------------------------------------
// GET /api/crawl  — 태스크 목록 (report_job_id·status 필터)
// ---------------------------------------------------------------------------
crawlRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page        = Number(req.query.page        ?? 1);
    const limit       = Number(req.query.limit       ?? 20);
    const reportJobId = req.query.reportJobId as string | undefined;
    const status      = req.query.status      as string | undefined;
    // TODO: service.listCrawlTasks({ reportJobId, status, page, limit })
    respond.paginated(res, [], 0, page, limit);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/crawl/:taskId/retry  — 실패 태스크 재시도
// ---------------------------------------------------------------------------
crawlRouter.patch("/:taskId/retry", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { taskId } = req.params;
    // TODO: service.retryCrawlTask(taskId)
    respond.ok(res, null, "태스크가 재시도 대기열에 추가되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/crawl/:taskId/status  — 상태 수동 업데이트
// ---------------------------------------------------------------------------
crawlRouter.patch("/:taskId/status", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { taskId } = req.params;
    const { status, resultPath, error } = req.body as {
      status:      "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
      resultPath?: string;
      error?:      string;
    };
    // TODO: service.updateCrawlTaskStatus(taskId, { status, resultPath, error })
    respond.ok(res, null, `태스크 상태가 ${status}(으)로 변경되었습니다.`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/crawl/dev/gitlab  — [DEV 전용] GitLab 크롤 결과 (divisionGuard 검증용)
// ※ 파라미터 라우트 (:taskId) 보다 먼저 등록해야 충돌이 없습니다.
// ---------------------------------------------------------------------------
crawlRouter.get(
  "/dev/gitlab",
  divisionGuard("DEV"),
  async (_req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // TODO: service.getGitLabCrawlResult()
      respond.ok(res, null, "GitLab 크롤 결과");
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/crawl/:taskId  — 단일 태스크 조회
// ※ 구체 경로 라우트들을 모두 등록한 뒤 마지막에 배치합니다.
// ---------------------------------------------------------------------------
crawlRouter.get("/:taskId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { taskId } = req.params;
    // TODO: service.getCrawlTask(taskId)
    respond.ok(res, { taskId });
  } catch (err) {
    next(err);
  }
});
