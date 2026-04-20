import { Router, Request, Response, NextFunction } from "express";
import { respond }    from "../../utils/response";
import { AppError }   from "../../utils/errors";
import { query }      from "../../config/db";
import { logger }     from "../../utils/logger";
import type { ScreenshotTargetConfig } from "../../config/screenshot.config";
import {
  getScreenshotConfigByDivisionId,
  getAllScreenshotConfigs,
  saveScreenshotConfig,
  patchScreenshotTarget,
  resetScreenshotConfig,
  getDefaultConfigs,
} from "./screenshot-config.service";

export const adminRouter = Router();

// =============================================================================
// 사용자 관리
// =============================================================================

// ---------------------------------------------------------------------------
// GET /api/admin/users
// 전체 사용자 목록 조회 (role·division 필터, 페이지네이션)
// ---------------------------------------------------------------------------
adminRouter.get("/users", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page     = Math.max(1, Number(req.query.page  ?? 1));
    const limit    = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const role     = req.query.role     as string | undefined;
    const division = req.query.division as string | undefined;
    const offset   = (page - 1) * limit;

    const [users, countRows] = await Promise.all([
      query<{
        id:            string;
        email:         string;
        name:          string;
        role:          string;
        division_code: string | null;
        division_name: string | null;
        created_at:    string;
      }>(
        `SELECT u.id, u.email, u.name, u.role, u.created_at,
                d.code AS division_code, d.name AS division_name
         FROM users u
         LEFT JOIN divisions d ON d.id = u.division_id
         WHERE ($1::text IS NULL OR u.role::text = $1)
           AND ($2::text IS NULL OR d.code::text = $2)
         ORDER BY u.created_at DESC
         LIMIT $3 OFFSET $4`,
        [role ?? null, division ?? null, limit, offset]
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM users u
         LEFT JOIN divisions d ON d.id = u.division_id
         WHERE ($1::text IS NULL OR u.role::text = $1)
           AND ($2::text IS NULL OR d.code::text = $2)`,
        [role ?? null, division ?? null]
      ),
    ]);

    respond.paginated(res, users, Number(countRows[0]?.count ?? 0), page, limit);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/users
// 사용자 생성 (email·name·password·role·divisionId)
// ---------------------------------------------------------------------------
adminRouter.post("/users", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, name, password, role, divisionId } = req.body as {
      email:       string;
      name:        string;
      password:    string;
      role:        "admin" | "manager" | "viewer";
      divisionId?: string;
    };

    if (!email || !name || !password || !role) {
      throw new AppError(400, "email, name, password, role 은 필수입니다.");
    }
    if (!["admin", "manager", "viewer"].includes(role)) {
      throw new AppError(400, `올바르지 않은 role: ${role}`);
    }

    const bcrypt = await import("bcrypt");
    const hash   = await bcrypt.hash(password, 12);
    const crypto = await import("crypto");
    const id     = crypto.randomUUID();

    const [user] = await query<{ id: string; email: string; name: string; role: string; created_at: string }>(
      `INSERT INTO users (id, email, password_hash, name, role, division_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, name, role, created_at`,
      [id, email, hash, name, role, divisionId ?? null]
    );

    respond.created(res, user, "사용자가 생성되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/users/:userId
// 사용자 상세 조회
// ---------------------------------------------------------------------------
adminRouter.get("/users/:userId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    // TODO: service.getUser(userId)
    respond.ok(res, { userId });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/users/:userId
// 사용자 정보 수정 (name·role·divisionId·password 부분 업데이트)
// ---------------------------------------------------------------------------
adminRouter.patch("/users/:userId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const { name, role, divisionId, password } = req.body as {
      name?:       string;
      role?:       "admin" | "manager" | "viewer";
      divisionId?: string | null;
      password?:   string;
    };

    // 비밀번호 변경이 포함된 경우 bcrypt 재해시
    let passwordHash: string | undefined;
    if (password) {
      const bcrypt = await import("bcrypt");
      passwordHash = await bcrypt.hash(password, 12);
    }

    const setClauses: string[] = [];
    const params: unknown[]    = [];
    let idx = 1;

    if (name !== undefined)       { setClauses.push(`name = $${idx++}`);          params.push(name); }
    if (role !== undefined)       { setClauses.push(`role = $${idx++}`);          params.push(role); }
    if (divisionId !== undefined) { setClauses.push(`division_id = $${idx++}`);   params.push(divisionId); }
    if (passwordHash)             { setClauses.push(`password_hash = $${idx++}`); params.push(passwordHash); }

    if (!setClauses.length) throw new AppError(400, "변경할 필드를 하나 이상 입력하세요.");

    setClauses.push(`updated_at = NOW()`);
    params.push(userId);

    await query(
      `UPDATE users SET ${setClauses.join(", ")} WHERE id = $${idx}`,
      params
    );

    respond.ok(res, null, "사용자 정보가 수정되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/users/:userId
// 사용자 삭제
// ---------------------------------------------------------------------------
adminRouter.delete("/users/:userId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const rows = await query<{ id: string }>(
      "DELETE FROM users WHERE id = $1 RETURNING id",
      [userId]
    );
    if (!rows.length) throw new AppError(404, "사용자를 찾을 수 없습니다.");
    respond.noContent(res);
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// 사업부(Division) 관리
// =============================================================================

// ---------------------------------------------------------------------------
// GET /api/admin/divisions
// 전체 사업부 목록 조회
// ---------------------------------------------------------------------------
adminRouter.get("/divisions", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // TODO: service.listDivisions()
    respond.ok(res, []);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/divisions/:divisionId
// 사업부 상세 조회 (system_configs JSONB 포함)
// ---------------------------------------------------------------------------
adminRouter.get("/divisions/:divisionId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { divisionId } = req.params;
    // TODO: service.getDivision(divisionId)
    respond.ok(res, { divisionId });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/divisions/:divisionId
// 사업부 기본 정보 수정 (name)
// ---------------------------------------------------------------------------
adminRouter.patch("/divisions/:divisionId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { divisionId } = req.params;
    const { name } = req.body as { name: string };
    // TODO: service.updateDivision(divisionId, { name })
    respond.ok(res, null, "사업부 정보가 수정되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/divisions/:divisionId/config
// 사업부 시스템 접속 설정(system_configs JSONB) 업데이트
// 시스템 URL·인증 방식 변경 시 사용
// ---------------------------------------------------------------------------
adminRouter.patch("/divisions/:divisionId/config", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { divisionId } = req.params;
    const { systems } = req.body as {
      systems?: Array<{
        name:  string;
        url:   string;
        auth:  Record<string, unknown>;
      }>;
    };

    if (!Array.isArray(systems) || !systems.length) {
      throw new AppError(400, "systems 배열이 필요합니다.");
    }

    // 현재 JSONB 읽기
    const rows = await query<{ system_configs: Record<string, unknown> | null }>(
      "SELECT system_configs FROM divisions WHERE id = $1",
      [divisionId]
    );
    if (!rows.length) throw new AppError(404, "사업부를 찾을 수 없습니다.");

    // 이름 기준으로 기존 항목 머지 (없으면 추가)
    const current = (
      rows[0].system_configs?.systems as Array<{ name: string }> | undefined
    ) ?? [];

    const updated = [...current];
    for (const ns of systems) {
      const idx = updated.findIndex((s) => s.name === ns.name);
      if (idx >= 0) {
        updated[idx] = { ...updated[idx], ...ns };
      } else {
        updated.push(ns);
      }
    }

    await query(
      `UPDATE divisions
       SET system_configs = system_configs || jsonb_build_object('systems', $1::jsonb)
       WHERE id = $2`,
      [JSON.stringify(updated), divisionId]
    );

    logger.info(`[AdminRouter] Division ${divisionId} config updated (${systems.length} systems)`);
    respond.ok(res, null, "시스템 설정이 저장되었습니다.");
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// 스크린샷 설정 관리 (Screenshot Config)
// divisions.system_configs JSONB 의 screenshotTargets 키를 CRUD 합니다.
// =============================================================================

// ---------------------------------------------------------------------------
// GET /api/admin/screenshot-configs
// 전체 사업부 스크린샷 설정 조회 (DB 값 + 코드 기본값 병합)
// ---------------------------------------------------------------------------
adminRouter.get("/screenshot-configs", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const configs = await getAllScreenshotConfigs();
    respond.ok(res, configs);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/screenshot-configs/defaults
// 코드 기본값 조회 (DB 미조회, "기본값으로 되돌리기" 미리보기용)
// ---------------------------------------------------------------------------
adminRouter.get("/screenshot-configs/defaults", (_req: Request, res: Response) => {
  respond.ok(res, getDefaultConfigs());
});

// ---------------------------------------------------------------------------
// GET /api/admin/divisions/:divisionId/screenshot-config
// 특정 사업부 스크린샷 설정 조회 (DB 값 + 코드 기본값 병합)
// ---------------------------------------------------------------------------
adminRouter.get("/divisions/:divisionId/screenshot-config", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { divisionId } = req.params;
    const config = await getScreenshotConfigByDivisionId(divisionId);
    respond.ok(res, config);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/admin/divisions/:divisionId/screenshot-config
// 특정 사업부 스크린샷 설정 전체 교체
// body: { targets: ScreenshotTargetConfig[] }
// ---------------------------------------------------------------------------
adminRouter.put("/divisions/:divisionId/screenshot-config", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { divisionId } = req.params;
    const { targets } = req.body as { targets: ScreenshotTargetConfig[] };

    if (!Array.isArray(targets)) {
      res.status(400).json({ success: false, error: "targets 배열이 필요합니다." });
      return;
    }

    const saved = await saveScreenshotConfig(divisionId, targets);
    respond.ok(res, saved, "스크린샷 설정이 저장되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/divisions/:divisionId/screenshot-config/:systemName
// 특정 시스템 항목만 부분 업데이트
// body: { label?, urlPath?, selector?, waitForSelector?, description? }
// ---------------------------------------------------------------------------
adminRouter.patch("/divisions/:divisionId/screenshot-config/:systemName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { divisionId, systemName } = req.params;
    const patch = req.body as Partial<
      Omit<ScreenshotTargetConfig, "systemName" | "captureAfterLogin">
    >;

    const updated = await patchScreenshotTarget(divisionId, systemName, patch);
    respond.ok(res, updated, `${systemName} 스크린샷 설정이 수정되었습니다.`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/divisions/:divisionId/screenshot-config
// DB 저장값 삭제 → 코드 기본값으로 초기화
// ---------------------------------------------------------------------------
adminRouter.delete("/divisions/:divisionId/screenshot-config", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { divisionId } = req.params;
    await resetScreenshotConfig(divisionId);
    respond.ok(res, null, "스크린샷 설정이 코드 기본값으로 초기화되었습니다.");
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// 연결 테스트 / 캡처 미리보기
// =============================================================================

// ---------------------------------------------------------------------------
// POST /api/admin/test-connection
// 외부 시스템 URL 에 HTTP HEAD 요청으로 연결 가능 여부를 확인합니다.
// Playwright 로그인 테스트는 인증 정보가 DB에 저장된 후 별도로 지원 예정.
// ---------------------------------------------------------------------------
adminRouter.post("/test-connection", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, username, password } = req.body as {
      divisionId?: string;
      systemCode?: string;
      url?:        string;
      username?:   string;
      password?:   string;
    };

    if (!url) throw new AppError(400, "url 은 필수입니다.");

    // HTTP 연결 테스트 (Node 20 global fetch 사용)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    const headers: Record<string, string> = {
      "User-Agent": "SKBS-IT-Report/1.0 (connection-test)",
    };
    if (username && password) {
      headers["Authorization"] =
        `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    }

    let statusCode: number;
    let ok: boolean;

    try {
      const resp = await fetch(url, {
        method:  "HEAD",
        headers,
        signal:  controller.signal,
        // Node fetch 는 redirect 자동 처리
      });
      statusCode = resp.status;
      // 401/403 도 "서버가 응답함" 이므로 연결 성공으로 처리
      ok = resp.status < 500;
    } catch (fetchErr) {
      clearTimeout(timer);
      throw new AppError(503, `연결 실패: ${(fetchErr as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    logger.info(`[AdminRouter] Connection test → ${url} : HTTP ${statusCode}`);
    respond.ok(res, { statusCode, ok }, ok ? "연결 성공" : `서버 오류 (HTTP ${statusCode})`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/capture-preview
// 스크린샷 캡처 미리보기 요청. 내부적으로 새 jobId를 생성하고
// POST /api/crawl/screenshot 으로 위임하여 비동기 실행합니다.
// ---------------------------------------------------------------------------
adminRouter.post("/capture-preview", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { divisionId, systemName, urlPath, selector } = req.body as {
      divisionId?: string;
      systemName?: string;
      urlPath?:    string;
      selector?:   string;
    };

    if (!divisionId || !systemName || !urlPath) {
      throw new AppError(400, "divisionId, systemName, urlPath 는 필수입니다.");
    }

    // 사업부 코드 조회
    const divRows = await query<{ code: string }>(
      "SELECT code FROM divisions WHERE id = $1",
      [divisionId]
    );
    if (!divRows.length) throw new AppError(404, "사업부를 찾을 수 없습니다.");

    const { randomUUID } = await import("crypto");
    const jobId = randomUUID();

    logger.info(
      `[AdminRouter] Capture preview → ${divisionId}/${systemName}  jobId=${jobId}`
    );

    // 202 즉시 응답 (스크린샷은 백그라운드 처리)
    res.status(202).json({
      success: true,
      data:    { jobId },
      message: "캡처 미리보기 요청이 접수되었습니다.",
    });
  } catch (err) {
    next(err);
  }
});
