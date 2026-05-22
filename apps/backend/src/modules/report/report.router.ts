/**
 * Report Router
 *
 * POST /api/report/generate            — HTML → PDF 변환 시작 (비동기, SSE 완료 알림)
 * GET  /api/report/history?division=   — 생성 이력 목록 (페이지네이션)
 * GET  /api/report/:jobId/status       — 생성 진행 상태
 * GET  /api/report/:jobId/download     — 생성된 PDF 스트리밍
 * GET  /api/report/:jobId/stream       — SSE 진행 상태 스트리밍 (crawl.router 와 공용 버스)
 *
 * ⚠ 라우트 등록 순서
 *  구체 경로(/generate, /history)는 파라미터 경로(/:jobId)보다 반드시 먼저 등록해야 합니다.
 */

import path from "path";
import { Router, Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../auth/auth.types";
import { AppError }  from "../../utils/errors";
import { respond }   from "../../utils/response";
import { logger }    from "../../utils/logger";
import { jobEventBus } from "../crawl/crawl.events";
import {
  startReportGeneration,
  listReportHistory,
  getJobStatus,
  getPdfPath,
} from "./report.service";
import {
  saveReportToHistory,
  listSavedReports,
  getSavedReport,
  deleteSavedReport,
} from "./history.service";
import { generateLhouseReport } from "./lhouse.report.service";
import { generateDevReport }    from "./dev.report.service";
import { generateBioReport, generateBioLimsReport, generateBioElnReport } from "./bio.report.service";
import type { DivisionCode } from "../../engines/playwright/types";

export const reportRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_DIVISIONS: DivisionCode[] = ["BIO", "DEV", "LHOUSE"];

// ---------------------------------------------------------------------------
// POST /api/report/generate
// HTML 생성 → PDF 변환을 백그라운드에서 시작.  202 Accepted 즉시 반환.
// SSE: GET /api/crawl/:jobId/stream 에서 report_generating / report_done / report_error 수신
// ---------------------------------------------------------------------------
reportRouter.post(
  "/generate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { divisionCode, jobId } = req.body as {
        divisionCode?: string;
        jobId?:        string;
      };

      if (!divisionCode || !jobId) {
        throw new AppError(400, "divisionCode 와 jobId 는 필수입니다.");
      }
      if (!ALLOWED_DIVISIONS.includes(divisionCode as DivisionCode)) {
        throw new AppError(400, `올바르지 않은 divisionCode: ${divisionCode}`);
      }
      if (!UUID_RE.test(jobId)) {
        throw new AppError(400, "jobId 는 UUID 형식이어야 합니다.");
      }

      const user = (req as AuthRequest).user!;

      // 사업부 권한 검사: admin 은 모든 사업부, 일반 사용자는 소속 사업부만 허용
      if (user.role !== "admin" && user.divisionCode && user.divisionCode !== divisionCode) {
        throw new AppError(
          403,
          `소속 사업부(${user.divisionCode}) 외의 보고서를 생성할 수 없습니다.`
        );
      }

      await startReportGeneration({
        jobId,
        divisionCode: divisionCode as DivisionCode,
        userId:       user.sub,
      });

      // 202: 작업이 백그라운드에서 진행 중
      res.status(202).json({
        success: true,
        data:    { jobId },
        message: "PDF 생성이 시작되었습니다. SSE 스트림에서 완료 이벤트를 확인하세요.",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/report/generate-lhouse
// Activity.xlsx + Systemusage.jpg → LHOUSE 전용 PDF 생성 (동기, 직접 다운로드)
// ---------------------------------------------------------------------------
reportRouter.post(
  "/generate-lhouse",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.body as { jobId?: string };
      if (!jobId) throw new AppError(400, "jobId 는 필수입니다.");
      if (!UUID_RE.test(jobId)) throw new AppError(400, "jobId 는 UUID 형식이어야 합니다.");

      const result = await generateLhouseReport(jobId);

      // PDF 파일을 직접 스트리밍 다운로드
      res.download(result.filePath, result.filename, (err) => {
        if (err && !res.headersSent) {
          next(new AppError(500, `PDF 다운로드 실패: ${err.message}`));
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/report/generate-dev
// DEV 전용 PDF 생성 (동기, 직접 다운로드)
// ---------------------------------------------------------------------------
reportRouter.post(
  "/generate-dev",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.body as { jobId?: string };
      if (!jobId) throw new AppError(400, "jobId 는 필수입니다.");
      if (!UUID_RE.test(jobId)) throw new AppError(400, "jobId 는 UUID 형식이어야 합니다.");

      const result = await generateDevReport(jobId);

      res.download(result.filePath, result.filename, (err) => {
        if (err && !res.headersSent) {
          next(new AppError(500, `PDF 다운로드 실패: ${err.message}`));
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/report/generate-bio
// BIO 전용 PDF 생성 (동기, 직접 다운로드)
// ---------------------------------------------------------------------------
reportRouter.post(
  "/generate-bio",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.body as { jobId?: string };
      if (!jobId) throw new AppError(400, "jobId 는 필수입니다.");
      if (!UUID_RE.test(jobId)) throw new AppError(400, "jobId 는 UUID 형식이어야 합니다.");

      const result = await generateBioReport(jobId);

      res.download(result.filePath, result.filename, (err) => {
        if (err && !res.headersSent) {
          next(new AppError(500, `PDF 다운로드 실패: ${err.message}`));
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/report/generate-bio-lims
// BIO 임검분 LIMS 전용 PDF 생성 (동기, 직접 다운로드)
// ---------------------------------------------------------------------------
reportRouter.post(
  "/generate-bio-lims",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.body as { jobId?: string };
      if (!jobId) throw new AppError(400, "jobId 는 필수입니다.");
      if (!UUID_RE.test(jobId)) throw new AppError(400, "jobId 는 UUID 형식이어야 합니다.");

      const result = await generateBioLimsReport(jobId);

      res.download(result.filePath, result.filename, (err) => {
        if (err && !res.headersSent) {
          next(new AppError(500, `PDF 다운로드 실패: ${err.message}`));
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/report/generate-bio-eln
// BIO 전자연구노트(ELN) 전용 PDF 생성 (동기, 직접 다운로드)
// ---------------------------------------------------------------------------
reportRouter.post(
  "/generate-bio-eln",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.body as { jobId?: string };
      if (!jobId) throw new AppError(400, "jobId 는 필수입니다.");
      if (!UUID_RE.test(jobId)) throw new AppError(400, "jobId 는 UUID 형식이어야 합니다.");

      const result = await generateBioElnReport(jobId);

      res.download(result.filePath, result.filename, (err) => {
        if (err && !res.headersSent) {
          next(new AppError(500, `PDF 다운로드 실패: ${err.message}`));
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/report/history?division=BIO&page=1&limit=20
// 보고서 생성 이력 목록 (페이지네이션, division 필터)
// ---------------------------------------------------------------------------
reportRouter.get(
  "/history",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const division = req.query.division as string | undefined;
      const page     = Math.max(1, Number(req.query.page  ?? 1));
      const limit    = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));

      if (division && !ALLOWED_DIVISIONS.includes(division as DivisionCode)) {
        throw new AppError(400, `올바르지 않은 division: ${division}`);
      }

      const { items, total } = await listReportHistory({ division, page, limit });
      respond.paginated(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// 보고서 History (월별 저장소) — 매달 발행된 보고서 보관 및 조회
// ---------------------------------------------------------------------------

// POST /api/report/saved  — outputs/ 의 최신 보고서를 History 에 저장 (덮어쓰기)
reportRouter.post(
  "/saved",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { divisionCode, reportType, year, month, sourceJobId } = req.body as {
        divisionCode?: string;
        reportType?:   string;
        year?:         number;
        month?:        number;
        sourceJobId?:  string | null;
      };

      if (!divisionCode || !ALLOWED_DIVISIONS.includes(divisionCode as DivisionCode))
        throw new AppError(400, "올바른 divisionCode 가 필요합니다.");
      if (!reportType)     throw new AppError(400, "reportType 이 필요합니다.");
      if (!year || !month) throw new AppError(400, "year, month 가 필요합니다.");

      const user  = (req as AuthRequest).user!;
      const saved = await saveReportToHistory({
        divisionCode,
        reportType,
        year:        Number(year),
        month:       Number(month),
        userId:      user.sub,
        sourceJobId: sourceJobId ?? null,
      });

      respond.created(res, saved, "보고서가 History 에 저장되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/report/saved?division=&year=&month=  — 저장된 보고서 목록
reportRouter.get(
  "/saved",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const divisionCode = req.query.division as string | undefined;
      const year         = req.query.year  ? Number(req.query.year)  : undefined;
      const month        = req.query.month ? Number(req.query.month) : undefined;

      if (divisionCode && !ALLOWED_DIVISIONS.includes(divisionCode as DivisionCode))
        throw new AppError(400, `올바르지 않은 division: ${divisionCode}`);

      const items = await listSavedReports({ divisionCode, year, month });
      respond.ok(res, items);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/report/saved/:id/download  — 저장된 PDF 다운로드
reportRouter.get(
  "/saved/:id/download",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new AppError(400, "id 는 UUID 형식이어야 합니다.");

      const row = await getSavedReport(id);
      if (!row) throw new AppError(404, "저장된 보고서를 찾을 수 없습니다.");

      const fs = await import("fs");
      if (!fs.existsSync(row.stored_path))
        throw new AppError(404, `파일이 디스크에서 누락되었습니다: ${row.stored_path}`);

      res.setHeader("Content-Type",        "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
      fs.createReadStream(row.stored_path).pipe(res);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/report/saved/:id  — History 에서 제거 (디스크 파일도 삭제)
reportRouter.delete(
  "/saved/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new AppError(400, "id 는 UUID 형식이어야 합니다.");

      await deleteSavedReport(id);
      respond.noContent(res);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/report/:jobId/status  — 보고서 생성 진행 상태 (REST)
// ---------------------------------------------------------------------------
reportRouter.get(
  "/:jobId/status",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.params;
      const job       = await getJobStatus(jobId);

      // SSE 히스토리에서 최신 이벤트도 함께 반환 (클라이언트 폴링 보조)
      const events = jobEventBus.replay(jobId);

      respond.ok(res, { job, events });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/report/:jobId/stream  (SSE)
// crawl.events.ts 의 jobEventBus 를 사용하여 report_done 이벤트를 스트리밍합니다.
// 재연결 시 ?replay=false 로 히스토리 전송을 생략할 수 있습니다.
// ---------------------------------------------------------------------------
reportRouter.get(
  "/:jobId/stream",
  async (req: Request, res: Response): Promise<void> => {
    const { jobId } = req.params;

    res.setHeader("Content-Type",      "text/event-stream");
    res.setHeader("Cache-Control",     "no-cache, no-store");
    res.setHeader("Connection",        "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (payload: object): void => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // 재연결 시 히스토리 replay
    const replay = req.query.replay !== "false";
    if (replay) {
      const history = jobEventBus.replay(jobId);
      for (const ev of history) send(ev);
      if (history.some((e) => e.type === "report_done" || e.type === "report_error")) {
        res.end();
        return;
      }
    }

    let done = false;
    const unsubscribe = jobEventBus.subscribe(jobId, (payload) => {
      send(payload);
      if (payload.type === "report_done" || payload.type === "report_error") {
        done = true;
        clearInterval(keepalive);
        res.end();
      }
    });

    const keepalive = setInterval(() => {
      if (done || res.writableEnded) { clearInterval(keepalive); return; }
      res.write(": keepalive\n\n");
    }, 15_000);

    req.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
      logger.debug(`[SSE] Report stream closed: ${jobId}`);
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/report/:jobId/download  — 생성된 PDF 파일 스트리밍
// ---------------------------------------------------------------------------
reportRouter.get(
  "/:jobId/download",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.params;
      const pdfPath   = await getPdfPath(jobId);
      const filename  = path.basename(pdfPath);

      res.download(pdfPath, filename, (err) => {
        if (err && !res.headersSent) {
          next(new AppError(500, `PDF 다운로드 실패: ${err.message}`));
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/report/:jobId  — 보고서 작업 상세 조회
// ---------------------------------------------------------------------------
reportRouter.get(
  "/:jobId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.params;
      const job       = await getJobStatus(jobId);
      respond.ok(res, job);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/report  — 보고서 작업 목록 (history 의 alias)
// ---------------------------------------------------------------------------
reportRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page  = Math.max(1, Number(req.query.page  ?? 1));
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
      const { items, total } = await listReportHistory({ page, limit });
      respond.paginated(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/report/:jobId/status  — 상태 수동 변경 (운영자 조작)
// ---------------------------------------------------------------------------
reportRouter.patch(
  "/:jobId/status",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId }   = req.params;
      const { status, errorMessage } = req.body as {
        status:        "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
        errorMessage?: string;
      };

      if (!["PENDING", "RUNNING", "COMPLETED", "FAILED"].includes(status)) {
        throw new AppError(400, `올바르지 않은 status: ${status}`);
      }

      await import("../../config/db").then(({ query }) =>
        query(
          `UPDATE report_jobs
           SET status        = $1,
               error_message = CASE WHEN $1 = 'FAILED' THEN $2 ELSE error_message END,
               updated_at    = NOW()
           WHERE id = $3`,
          [status, errorMessage ?? null, jobId]
        )
      );

      respond.ok(res, null, `상태가 ${status}(으)로 변경되었습니다.`);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/report/:jobId  — 보고서 작업 삭제 (CASCADE)
// ---------------------------------------------------------------------------
reportRouter.delete(
  "/:jobId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.params;
      await import("../../config/db").then(({ query }) =>
        query("DELETE FROM report_jobs WHERE id = $1", [jobId])
      );
      respond.noContent(res);
    } catch (err) {
      next(err);
    }
  }
);
