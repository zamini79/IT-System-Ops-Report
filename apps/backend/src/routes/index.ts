import { Router } from "express";
import { authGuard, adminGuard } from "../modules/auth/auth.guard";
import { authRouter }   from "../modules/auth/auth.router";
import { reportRouter } from "../modules/report/report.router";
import { crawlRouter }  from "../modules/crawl/crawl.router";
import { fileRouter }   from "../modules/file/file.router";
import { mailRouter }   from "../modules/mail/mail.router";
import { adminRouter }  from "../modules/admin/admin.router";

export const router = Router();

// ── 인증 불필요 ───────────────────────────────────────────────────────────────
router.use("/auth",   authRouter);

// ── 로그인 필요 (authGuard) ───────────────────────────────────────────────────
router.use("/report", authGuard, reportRouter);
router.use("/crawl",  authGuard, crawlRouter);
router.use("/file",   authGuard, fileRouter);
router.use("/mail",   authGuard, mailRouter);

// ── 관리자 전용 (authGuard + adminGuard) ─────────────────────────────────────
router.use("/admin",  authGuard, adminGuard, adminRouter);
