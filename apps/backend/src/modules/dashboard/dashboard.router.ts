/**
 * Dashboard Router
 *
 * GET  /api/dashboard/:divisionCode              — 최신 스냅샷 + 소스 상태 + 마지막 수집 정보
 * GET  /api/dashboard/:divisionCode/trend        — KPI 일별 추이 (?metric=&days=)
 * POST /api/dashboard/:divisionCode/refresh      — 현재 파일로 스냅샷 재계산 (수집은 하지 않음)
 *
 * 접근 제어: divisionGuard — 담당자는 소속 본부만, admin 은 전체.
 */

import { Router, Response, NextFunction } from "express";
import type { DashboardDivisionCode } from "./dashboard.types";

import { divisionGuard }    from "../auth/auth.guard";
import type { AuthRequest } from "../auth/auth.types";
import { respond }          from "../../utils/response";
import { AppError }         from "../../utils/errors";
import { logger }           from "../../utils/logger";
import {
  getDashboard,
  getTrend,
  refreshSnapshot,
} from "./dashboard.service";
import { collectDivision } from "./collection.scheduler";

export const dashboardRouter = Router();

const VALID_DIVISIONS: DashboardDivisionCode[] = ["BIO", "DEV", "LHOUSE"];

/** :divisionCode 파라미터 검증 + 타입 좁히기 */
function parseDivision(raw: string): DashboardDivisionCode {
  const code = raw.toUpperCase() as DashboardDivisionCode;
  if (!VALID_DIVISIONS.includes(code)) {
    throw new AppError(400, `알 수 없는 본부 코드: ${raw}`);
  }
  return code;
}

// ---------------------------------------------------------------------------
// GET /api/dashboard/:divisionCode
// ---------------------------------------------------------------------------
dashboardRouter.get(
  "/:divisionCode",
  divisionGuard("BIO", "DEV", "LHOUSE"),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const code = parseDivision(req.params.divisionCode);
      const data = await getDashboard(code);
      respond.ok(res, data);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/dashboard/:divisionCode/trend?metric=gcp_doc&days=30
// ---------------------------------------------------------------------------
dashboardRouter.get(
  "/:divisionCode/trend",
  divisionGuard("BIO", "DEV", "LHOUSE"),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const code   = parseDivision(req.params.divisionCode);
      const metric = (req.query.metric as string | undefined)?.trim();
      if (!metric) throw new AppError(400, "metric 쿼리 파라미터가 필요합니다.");

      const daysRaw = Number(req.query.days ?? 30);
      const days    = Number.isFinite(daysRaw)
        ? Math.min(365, Math.max(1, Math.floor(daysRaw)))
        : 30;

      const data = await getTrend(code, metric, days);
      respond.ok(res, data);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/dashboard/:divisionCode/refresh
//   현재 작업공간 파일로 스냅샷만 다시 계산한다(크롤링 없음).
//   업로드 직후 대시보드를 즉시 반영하는 용도.
// ---------------------------------------------------------------------------
dashboardRouter.post(
  "/:divisionCode/refresh",
  divisionGuard("BIO", "DEV", "LHOUSE"),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const code   = parseDivision(req.params.divisionCode);
      const result = await refreshSnapshot(code);
      logger.info(`[Dashboard] 수동 스냅샷 재계산 — ${code} (${req.user?.sub})`);
      respond.ok(res, result, "대시보드가 갱신되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/dashboard/:divisionCode/collect
//   지금 즉시 시스템 조회(크롤)까지 수행하고 스냅샷을 갱신한다.
//   새벽 자동 수집을 기다리지 않고 최신 데이터를 보고 싶을 때 사용.
//   수집은 수 분 걸리므로 즉시 202 를 반환하고 백그라운드로 진행한다.
// ---------------------------------------------------------------------------
dashboardRouter.post(
  "/:divisionCode/collect",
  divisionGuard("BIO", "DEV", "LHOUSE"),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const code = parseDivision(req.params.divisionCode);
      logger.info(`[Dashboard] 수동 수집 요청 — ${code} (${req.user?.sub})`);

      // fire-and-forget: 진행 상황은 GET /:divisionCode 의 lastRun 으로 확인
      void collectDivision(code, "manual").catch((e: Error) =>
        logger.error(`[Dashboard] 수동 수집 오류(${code}): ${e.message}`)
      );

      res.status(202).json({
        success: true,
        data:    { divisionCode: code },
        message: "데이터 수집을 시작했습니다. 완료 후 대시보드가 갱신됩니다.",
      });
    } catch (err) {
      next(err);
    }
  }
);
