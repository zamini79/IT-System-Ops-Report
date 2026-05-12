/**
 * Crawl Controller
 *
 * POST /api/crawl/start   — 크롤 잡 시작
 * GET  /api/crawl/:jobId/stream — SSE 진행 상태 스트리밍
 */

import { Request, Response, NextFunction } from "express";
import type { AuthRequest }  from "../auth/auth.types";
import { AppError }          from "../../utils/errors";
import { respond }           from "../../utils/response";
import { startCrawlJob, getCrawlJobStatus, takeScreenshotJob, startDashboardCapture, type ScreenshotConfig } from "./crawl.service";
import { jobEventBus }       from "./crawl.events";
import type { DivisionCode } from "../../engines/playwright/types";
import { logger }            from "../../utils/logger";

// ── POST /api/crawl/start ─────────────────────────────────────────────────────

export async function startCrawlHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { divisionCode, jobId } = req.body as {
      divisionCode?: string;
      jobId?:        string;
    };

    if (!divisionCode || !jobId) {
      throw new AppError(400, "divisionCode 와 jobId 는 필수입니다.");
    }

    const allowedCodes: DivisionCode[] = ["BIO", "DEV", "LHOUSE"];
    if (!allowedCodes.includes(divisionCode as DivisionCode)) {
      throw new AppError(400, `올바르지 않은 divisionCode: ${divisionCode}`);
    }

    // UUID 형식 검증
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(jobId)) {
      throw new AppError(400, "jobId 는 UUID 형식이어야 합니다.");
    }

    const user = (req as AuthRequest).user!;

    // 사업부 권한 검사: admin 은 모든 사업부, 일반 사용자는 소속 사업부만 허용
    if (user.role !== "admin" && user.divisionCode && user.divisionCode !== divisionCode) {
      throw new AppError(
        403,
        `소속 사업부(${user.divisionCode}) 외의 크롤을 시작할 수 없습니다.`
      );
    }

    const tasks = await startCrawlJob({
      divisionCode: divisionCode as DivisionCode,
      jobId,
      userId:       user.sub,
    });

    respond.created(res, { jobId, tasks }, "크롤 잡이 시작되었습니다.");
  } catch (err) {
    next(err);
  }
}

// ── GET /api/crawl/:jobId/stream (SSE) ───────────────────────────────────────

/**
 * SSE 이벤트 스트리밍.
 *
 * ─ 이벤트 포맷 ───────────────────────────────────────────────────────────────
 *  data: {"type":"task_start","systemName":"EDMS","total":5}\n\n
 *  data: {"type":"progress","systemName":"EDMS","percent":50}\n\n
 *  data: {"type":"task_done","systemName":"EDMS","filePaths":[...]}\n\n
 *  data: {"type":"task_error","systemName":"EDMS","error":"..."}\n\n
 *  data: {"type":"all_done","jobId":"..."}\n\n
 *
 * ─ 재연결 ────────────────────────────────────────────────────────────────────
 *  ?replay=true 쿼리 파라미터로 히스토리 전체를 순서대로 먼저 전송합니다.
 *  (기본값: true)
 *
 * ─ 인증 ──────────────────────────────────────────────────────────────────────
 *  Authorization: Bearer <token> 헤더 또는
 *  ?token=<accessToken> 쿼리 파라미터로 인증합니다 (EventSource 지원).
 */
export async function streamCrawlHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { jobId } = req.params;

  // ── SSE 헤더 설정 ──────────────────────────────────────────────────────────
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx 버퍼링 비활성화
  res.flushHeaders();

  // ── 헬퍼: SSE 데이터 전송 ──────────────────────────────────────────────────
  const send = (payload: object): void => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const sendComment = (): void => {
    if (res.writableEnded) return;
    res.write(`: keepalive\n\n`);
  };

  // ── 재연결 시 히스토리 replay ──────────────────────────────────────────────
  const replay = req.query.replay !== "false";
  if (replay) {
    const history = jobEventBus.replay(jobId);
    for (const payload of history) {
      send(payload);
    }
    // 이미 all_done 이면 스트림 종료
    if (history.some((p) => p.type === "all_done")) {
      res.end();
      return;
    }
  }

  // ── 실시간 이벤트 구독 ────────────────────────────────────────────────────
  let done = false;

  const unsubscribe = jobEventBus.subscribe(jobId, (payload) => {
    send(payload);
    if (payload.type === "all_done") {
      done = true;
      clearInterval(keepaliveTimer);
      res.end();
    }
  });

  // ── keepalive 주석 (15초마다) ─────────────────────────────────────────────
  const keepaliveTimer = setInterval(() => {
    if (done || res.writableEnded) {
      clearInterval(keepaliveTimer);
      return;
    }
    sendComment();
  }, 15_000);

  // ── 클라이언트 연결 해제 처리 ─────────────────────────────────────────────
  req.on("close", () => {
    clearInterval(keepaliveTimer);
    unsubscribe(); // 구독만 해제, 백그라운드 크롤 잡은 계속 실행됨
    logger.debug(`[SSE] Client disconnected from job ${jobId}`);
  });
}

// ── POST /api/crawl/screenshot ────────────────────────────────────────────────

/**
 * 로그인 후 지정 URL을 스크린샷으로 캡처합니다.
 *
 * Request body:
 *   {
 *     jobId:            string,   // report_jobs.id (SSE 스트림 채널)
 *     divisionCode:     string,   // 'BIO' | 'DEV' | 'LHOUSE'
 *     systemName:       string,   // 크롤러 레지스트리 키
 *     screenshotConfig: {
 *       url:       string,        // 캡처할 페이지 URL
 *       selector?: string,        // 요소 셀렉터 (없으면 viewport)
 *       fullPage?: boolean,       // 전체 페이지 캡처 여부
 *       width?:    number,        // 기본 1280
 *       height?:   number,        // 기본 720
 *     }
 *   }
 *
 * 응답: 202 Accepted + { taskId }
 * SSE 이벤트: screenshot_done | screenshot_error (GET /:jobId/stream 에서 수신)
 */
export async function screenshotHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { jobId, divisionCode, systemName, screenshotConfig } = req.body as {
      jobId?:            string;
      divisionCode?:     string;
      systemName?:       string;
      screenshotConfig?: Partial<ScreenshotConfig>;
    };

    // ── 입력 검증 ────────────────────────────────────────────────────────────
    if (!jobId || !divisionCode || !systemName || !screenshotConfig?.url) {
      throw new AppError(
        400,
        "jobId, divisionCode, systemName, screenshotConfig.url 은 필수입니다."
      );
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(jobId)) {
      throw new AppError(400, "jobId 는 UUID 형식이어야 합니다.");
    }

    const allowedCodes: DivisionCode[] = ["BIO", "DEV", "LHOUSE"];
    if (!allowedCodes.includes(divisionCode as DivisionCode)) {
      throw new AppError(400, `올바르지 않은 divisionCode: ${divisionCode}`);
    }

    const user = (req as AuthRequest).user!;

    const { taskId } = await takeScreenshotJob({
      jobId,
      divisionCode: divisionCode as DivisionCode,
      systemName,
      config:       screenshotConfig as ScreenshotConfig,
      userId:       user.sub,
    });

    // 202: 작업이 백그라운드에서 진행 중
    res.status(202).json({
      success: true,
      data:    { taskId, jobId },
      message: "스크린샷 작업이 시작되었습니다. SSE 스트림에서 진행 상태를 확인하세요.",
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/crawl/veeva-dashboard ──────────────────────────────────────────

/**
 * Veeva 대시보드 스크린샷 캡처 (임시 기능).
 *
 * 로그인 → SKY QMS Production Vault 선택 → 대시보드 접속 →
 * 차트 6개 렌더링 대기 → 전체 화면 스크린샷 1장 저장
 *
 * Request body: { jobId, userId? }
 * 응답: 202 Accepted + { taskId }
 * SSE: GET /:jobId/stream 에서 진행 상태 수신
 */
export async function veevaDashboardHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { jobId } = req.body as { jobId?: string };

    if (!jobId) throw new AppError(400, "jobId 는 필수입니다.");

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(jobId)) throw new AppError(400, "jobId 는 UUID 형식이어야 합니다.");

    const user = (req as AuthRequest).user!;

    const { taskId } = await startDashboardCapture({ jobId, userId: user.sub });

    res.status(202).json({
      success: true,
      data:    { taskId, jobId },
      message: "대시보드 캡처가 시작되었습니다. SSE 스트림에서 진행 상태를 확인하세요.",
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/crawl/:jobId/status ─────────────────────────────────────────────

export async function getJobStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { jobId } = req.params;
    const data = await getCrawlJobStatus(jobId);
    respond.ok(res, data);
  } catch (err) {
    next(err);
  }
}
