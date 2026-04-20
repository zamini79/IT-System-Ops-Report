/**
 * Mail Router
 *
 * POST /api/mail/draft              — 데이터 기반 초안 자동 생성
 * GET  /api/mail/draft?jobId=       — jobId 기준 초안 목록
 * GET  /api/mail/draft/:id          — 단일 초안 조회
 * PUT  /api/mail/draft/:id          — 초안 전체 수정
 * DELETE /api/mail/draft/:id        — 초안 삭제
 *
 * GET    /api/mail/groups?division= — 본부별 수신자 그룹 목록
 * POST   /api/mail/groups           — 수신자 그룹 생성
 * PUT    /api/mail/groups/:id       — 수신자 그룹 수정
 * DELETE /api/mail/groups/:id       — 수신자 그룹 삭제
 *
 * ⚠ /draft, /groups 구체 경로를 파라미터 경로보다 먼저 등록합니다.
 */

import { Router, Request, Response, NextFunction } from "express";
import { respond }  from "../../utils/response";
import { AppError } from "../../utils/errors";
import {
  generateDraft,
  getDraft,
  listDraftsByJobId,
  updateDraft,
  deleteDraft,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
} from "./mail.service";

export const mailRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// /draft 하위 라우트
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// POST /api/mail/draft
// body: { jobId }
// report_jobs · crawl_tasks · uploaded_files 를 조회하여 메일 초안 자동 생성
// ---------------------------------------------------------------------------
mailRouter.post(
  "/draft",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.body as { jobId?: string };

      if (!jobId) throw new AppError(400, "jobId 는 필수입니다.");

      const draft = await generateDraft(jobId);
      respond.created(res, draft, "메일 초안이 생성되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/mail/draft?jobId=<uuid>&page=1&limit=20
// jobId 기준 초안 목록 조회
// ---------------------------------------------------------------------------
mailRouter.get(
  "/draft",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const jobId = req.query.jobId as string | undefined;
      if (!jobId) throw new AppError(400, "jobId 쿼리 파라미터가 필요합니다.");

      const page  = Math.max(1, Number(req.query.page  ?? 1));
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));

      const { items, total } = await listDraftsByJobId(jobId, page, limit);
      respond.paginated(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/mail/draft/:id
// 단일 초안 조회
// ---------------------------------------------------------------------------
mailRouter.get(
  "/draft/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const draft = await getDraft(req.params.id);
      respond.ok(res, draft);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// PUT /api/mail/draft/:id
// 초안 전체 교체 (recipients · cc · subject · body_html 모두 필요)
// ---------------------------------------------------------------------------
mailRouter.put(
  "/draft/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { recipients, cc, subject, body_html } = req.body as {
        recipients?: unknown;
        cc?:         unknown;
        subject?:    string;
        body_html?:  string;
      };

      if (!Array.isArray(recipients) || !subject || !body_html) {
        throw new AppError(400, "recipients(배열), subject, body_html 은 필수입니다.");
      }

      const draft = await updateDraft(req.params.id, {
        recipients: recipients as string[],
        cc:         Array.isArray(cc) ? (cc as string[]) : [],
        subject,
        body_html,
      });

      respond.ok(res, draft, "메일 초안이 수정되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/mail/draft/:id
// 초안 삭제
// ---------------------------------------------------------------------------
mailRouter.delete(
  "/draft/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteDraft(req.params.id);
      respond.noContent(res);
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// /groups 하위 라우트
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// GET /api/mail/groups?division=BIO
// 본부별 수신자 그룹 목록
// ---------------------------------------------------------------------------
mailRouter.get(
  "/groups",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const division = req.query.division as string | undefined;
      const groups = await listGroups(division);
      respond.ok(res, groups);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/mail/groups
// body: { division_code, name, emails }
// ---------------------------------------------------------------------------
mailRouter.post(
  "/groups",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { division_code, name, emails } = req.body as {
        division_code?: string;
        name?:          string;
        emails?:        unknown;
      };

      if (!division_code || !name) {
        throw new AppError(400, "division_code, name 은 필수입니다.");
      }
      if (!Array.isArray(emails)) {
        throw new AppError(400, "emails 는 배열이어야 합니다.");
      }

      const group = await createGroup({
        division_code,
        name,
        emails: emails as string[],
      });
      respond.created(res, group, "수신자 그룹이 생성되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// PUT /api/mail/groups/:id
// body: { name?, emails? }  — 제공된 필드만 갱신
// ---------------------------------------------------------------------------
mailRouter.put(
  "/groups/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, emails } = req.body as {
        name?:   string;
        emails?: unknown;
      };

      if (emails !== undefined && !Array.isArray(emails)) {
        throw new AppError(400, "emails 는 배열이어야 합니다.");
      }

      const group = await updateGroup(req.params.id, {
        name,
        emails: Array.isArray(emails) ? (emails as string[]) : undefined,
      });
      respond.ok(res, group, "수신자 그룹이 수정되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/mail/groups/:id
// ---------------------------------------------------------------------------
mailRouter.delete(
  "/groups/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteGroup(req.params.id);
      respond.noContent(res);
    } catch (err) {
      next(err);
    }
  }
);
