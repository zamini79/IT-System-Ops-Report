/**
 * File Router
 *
 * POST   /api/file/upload              — 범용 파일 업로드 (multer multipart)
 * POST   /api/file/upload-named        — LHOUSE 고정명 업로드 (slot 지정, 덮어쓰기)
 * GET    /api/file/list?jobId=         — jobId 기준 파일 목록 조회
 * DELETE /api/file/:id                 — 파일 삭제 (DB + 물리 파일)
 */

import { Router, Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../auth/auth.types";
import multer, { FileFilterCallback } from "multer";
import path   from "path";
import fs     from "fs";
import * as XLSX from "xlsx";
import { v4 as uuidv4 } from "uuid";
import { respond }       from "../../utils/response";
import { AppError }      from "../../utils/errors";
import { logger }        from "../../utils/logger";
import {
  saveUploadedFiles,
  saveNamedUploadedFile,
  listFilesByJobId,
  deleteFile,
  triggerAnalysis,
} from "./file.service";

export const fileRouter = Router();

// ── 상수 ─────────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_FILE_COUNT      = 10;

/**
 * 허용 MIME 타입 집합
 * - xlsx / xls / csv / pdf / png / jpg·jpeg
 */
const ALLOWED_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.ms-excel",                                           // xls
  "text/csv",                                                           // csv
  "application/csv",                                                    // csv (일부 클라이언트)
  "application/pdf",                                                    // pdf
  "image/png",                                                          // png
  "image/jpeg",                                                         // jpg / jpeg
]);

/**
 * 허용 확장자 (MIME 스푸핑 방어를 위해 확장자도 함께 검사)
 */
const ALLOWED_EXTENSIONS = new Set([".xlsx", ".xls", ".csv", ".pdf", ".png", ".jpg", ".jpeg"]);

// ── Multer 설정 ───────────────────────────────────────────────────────────────

/**
 * diskStorage: UPLOAD_DIR/{jobId}/uploads/{uuid}_{originalName}
 *
 * NOTE: multipart/form-data 는 텍스트 필드가 파일보다 먼저 전송되므로
 *       destination 콜백 시점에 req.body.jobId 가 이미 파싱되어 있습니다.
 */
const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const jobId = req.body?.jobId as string | undefined;
    if (!jobId) {
      return cb(new AppError(400, "jobId 필드가 필요합니다."), "");
    }

    // UUID 형식 검증
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(jobId)) {
      return cb(new AppError(400, "jobId 는 UUID 형식이어야 합니다."), "");
    }

    const uploadDir = process.env.UPLOAD_DIR ?? "uploads";
    const destDir   = path.resolve(uploadDir, jobId, "uploads");

    try {
      fs.mkdirSync(destDir, { recursive: true });
      cb(null, destDir);
    } catch (e) {
      cb(e as Error, "");
    }
  },

  filename(_req, file, cb) {
    // 한글 파일명 안전 처리: 원본 이름의 공백·특수문자는 그대로 유지하되 앞에 uuid 를 붙임
    const safe = file.originalname.replace(/[/\\]/g, "_"); // 경로 구분자만 제거
    cb(null, `${uuidv4()}_${safe}`);
  },
});

function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
): void {
  const ext  = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype.toLowerCase();

  if (ALLOWED_EXTENSIONS.has(ext) && ALLOWED_MIME_TYPES.has(mime)) {
    cb(null, true);
  } else {
    cb(new AppError(400, `허용되지 않는 파일 형식입니다: ${file.originalname} (${mime})`));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files:    MAX_FILE_COUNT,
  },
});

// ── Multer 에러 → AppError 변환 미들웨어 ─────────────────────────────────────

function handleMulterError(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ success: false, error: `파일 크기는 ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB 이하여야 합니다.` });
      return;
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      res.status(413).json({ success: false, error: `최대 ${MAX_FILE_COUNT}개까지 업로드할 수 있습니다.` });
      return;
    }
    res.status(400).json({ success: false, error: err.message });
    return;
  }
  next(err);
}

// ── 라우트 ────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// POST /api/file/upload
// multipart/form-data 필드: files (복수), jobId
// ---------------------------------------------------------------------------
fileRouter.post(
  "/upload",
  upload.array("files", MAX_FILE_COUNT),
  handleMulterError,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const jobId        = req.body?.jobId        as string | undefined;
      const divisionCode = req.body?.divisionCode as string | undefined;
      const files        = req.files as Express.Multer.File[] | undefined;
      const userId       = (req as AuthRequest).user?.sub;

      if (!jobId) {
        throw new AppError(400, "jobId 필드가 필요합니다.");
      }
      if (!divisionCode) {
        throw new AppError(400, "divisionCode 필드가 필요합니다.");
      }
      if (!files?.length) {
        throw new AppError(400, "업로드할 파일이 없습니다. 필드명 'files' 를 확인하세요.");
      }

      // DB 저장 (report_jobs 없으면 자동 생성)
      const saved = await saveUploadedFiles(jobId, divisionCode, userId!, files);

      // 업로드 완료 후 자동 분석 시작 (fire-and-forget)
      triggerAnalysis(saved.map((f) => f.id));

      respond.created(
        res,
        { jobId, files: saved },
        `${saved.length}개 파일이 업로드되었습니다. 분석이 시작되었습니다.`
      );
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/file/list?jobId=<uuid>
// ---------------------------------------------------------------------------
fileRouter.get("/list", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobId = req.query.jobId as string | undefined;
    if (!jobId) throw new AppError(400, "jobId 쿼리 파라미터가 필요합니다.");

    const files = await listFilesByJobId(jobId);
    respond.ok(res, { jobId, files, count: files.length });
  } catch (err) {
    next(err);
  }
});

// ── 고정명 슬롯 정의 (LHOUSE + DEV + BIO) ────────────────────────────────────

const NAMED_SLOTS = {
  // ── LHOUSE ────────────────────────────────────────────────────────────────
  activity: {
    filename:  "Activity_LHOUSE.xlsx",
    mimeTypes: new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
    ]),
    extensions: new Set([".xlsx", ".xls"]),
    label: "Activity (Task) Count",
  },
  systemusage: {
    filename:   "Systemusage_LHOUSE.jpg",   // 이미지 슬롯 — 확장자 동적 처리
    mimeTypes:  new Set(["image/jpeg", "image/png"]),
    extensions: new Set([".jpg", ".jpeg", ".png"]),
    label: "System Usage (DX)",
  },
  // ── DEV ───────────────────────────────────────────────────────────────────
  activity_gcp: {
    filename:  "Activity_GCP.xlsx",
    mimeTypes: new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
    ]),
    extensions: new Set([".xlsx", ".xls"]),
    label: "Activity (Task) Count - GCP Quality System",
  },
  // ── DEV: 시스템별 대시보드 이미지 (1장 업로드 → 서버에서 분할) ─────────────
  systemusage_gcp: {
    filename:   "Systemusage_GCP.jpg",
    mimeTypes:  new Set(["image/jpeg", "image/png"]),
    extensions: new Set([".jpg", ".jpeg", ".png"]),
    label: "System Usage — GCP Quality System (eDMS / eQMS / eLMS)",
  },
  systemusage_medcomms: {
    filename:   "Systemusage_Medcomms.jpg",
    mimeTypes:  new Set(["image/jpeg", "image/png"]),
    extensions: new Set([".jpg", ".jpeg", ".png"]),
    label: "System Usage — Medical Contents Management System (Medcomms)",
  },
  systemusage_ctms1: {
    filename:   "Systemusage_Clinical1.jpg",
    mimeTypes:  new Set(["image/jpeg", "image/png"]),
    extensions: new Set([".jpg", ".jpeg", ".png"]),
    label: "System Usage — Clinical Trial Management System 이미지 1",
  },
  systemusage_ctms2: {
    filename:   "Systemusage_Clinical2.jpg",
    mimeTypes:  new Set(["image/jpeg", "image/png"]),
    extensions: new Set([".jpg", ".jpeg", ".png"]),
    label: "System Usage — Clinical Trial Management System 이미지 2",
  },
  // ── BIO ───────────────────────────────────────────────────────────────────
  systemusage_rd: {
    filename:   "Systemusage_RD.jpg",
    mimeTypes:  new Set(["image/jpeg", "image/png"]),
    extensions: new Set([".jpg", ".jpeg", ".png"]),
    label: "System Usage — Bio연구본부 Veeva System",
  },
  lims: {
    filename:  "LIMS.xlsx",
    mimeTypes: new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
    ]),
    extensions: new Set([".xlsx", ".xls"]),
    label: "임검분 LIMS — 데이터 (Excel)",
  },
  lims_image: {
    filename:   "LIMS.png",
    mimeTypes:  new Set(["image/jpeg", "image/png"]),
    extensions: new Set([".jpg", ".jpeg", ".png"]),
    label: "임검분 LIMS — 사용 현황 이미지",
  },
  eln_report: {
    filename:  "ELN_report.xlsx",
    mimeTypes: new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
    ]),
    extensions: new Set([".xlsx", ".xls"]),
    label: "전자연구노트 (ELN) — ELN Report",
  },
  eln_service: {
    filename:  "ELN_service.xlsx",
    mimeTypes: new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
    ]),
    extensions: new Set([".xlsx", ".xls"]),
    label: "전자연구노트 (ELN) — ELN Service",
  },
  // ── 공유 ──────────────────────────────────────────────────────────────────
  timesheet: {
    filename:   "SKB_Quallity_MS_Timesheet.xlsx",
    mimeTypes:  new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
    ]),
    extensions: new Set([".xlsx", ".xls"]),
    label: "Veeva MS Timesheet",
  },
} as const;

type NamedSlot = keyof typeof NAMED_SLOTS;

/** 업로드된 파일 확장자(.jpg/.png)를 그대로 저장해야 하는 슬롯 집합 */
const IMAGE_SLOTS = new Set<NamedSlot>([
  "systemusage",
  "systemusage_gcp",
  "systemusage_medcomms",
  "systemusage_ctms1",
  "systemusage_ctms2",
  "systemusage_rd",
]);

// ── Multer: 고정명 저장 ───────────────────────────────────────────────────────

const namedStorage = multer.diskStorage({
  destination(req, _file, cb) {
    const jobId = req.body?.jobId as string | undefined;
    if (!jobId) return cb(new AppError(400, "jobId 필드가 필요합니다."), "");

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(jobId)) return cb(new AppError(400, "jobId 는 UUID 형식이어야 합니다."), "");

    const uploadDir = process.env.UPLOAD_DIR ?? "uploads";
    const destDir   = path.resolve(uploadDir, jobId, "uploads");
    try {
      fs.mkdirSync(destDir, { recursive: true });
      cb(null, destDir);
    } catch (e) {
      cb(e as Error, "");
    }
  },

  filename(req, file, cb) {
    const slot = req.body?.slot as NamedSlot | undefined;
    // 이미지 슬롯은 jpg / png 모두 허용 — 업로드된 파일 확장자를 그대로 사용
    if (slot && IMAGE_SLOTS.has(slot)) {
      const base = NAMED_SLOTS[slot].filename.replace(/\.(jpg|jpeg|png)$/i, "");
      const ext  = path.extname(file.originalname).toLowerCase();
      cb(null, `${base}${ext}`);
      return;
    }
    const cfg = slot ? NAMED_SLOTS[slot] : undefined;
    cb(null, cfg?.filename ?? `upload_${Date.now()}`);
  },
});

function namedFileFilter(
  req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
): void {
  const slot = req.body?.slot as NamedSlot | undefined;
  const cfg  = slot ? NAMED_SLOTS[slot] : undefined;

  if (!cfg) {
    return cb(new AppError(400, `알 수 없는 slot 값입니다. activity / systemusage / activity_gcp / systemusage_gcp / systemusage_medcomms / systemusage_ctms1 / systemusage_ctms2 / systemusage_rd / lims / lims_image / eln_report / eln_service / timesheet 를 사용하세요.`));
  }

  const ext = path.extname(file.originalname).toLowerCase();

  // MIME 타입은 브라우저/OS마다 다르게 보고될 수 있으므로 확장자만 검증
  // (xlsx → application/zip, jpg → image/pjpeg 등 비표준 보고 사례 존재)
  if (!cfg.extensions.has(ext as never)) {
    return cb(
      new AppError(
        400,
        `'${cfg.label}' 슬롯에는 ${[...cfg.extensions].join(" / ")} 파일만 허용됩니다.`
      )
    );
  }
  cb(null, true);
}

const namedUpload = multer({
  storage:    namedStorage,
  fileFilter: namedFileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
});

// ---------------------------------------------------------------------------
// POST /api/file/upload-named
// multipart/form-data 필드: file (단일), jobId, divisionCode, slot
// slot: "activity" | "systemusage"
// ---------------------------------------------------------------------------
fileRouter.post(
  "/upload-named",
  namedUpload.single("file"),
  handleMulterError,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const jobId        = req.body?.jobId        as string | undefined;
      const divisionCode = req.body?.divisionCode as string | undefined;
      const slot         = req.body?.slot         as NamedSlot | undefined;
      const file         = req.file;
      const userId       = (req as AuthRequest).user?.sub;

      if (!jobId)        throw new AppError(400, "jobId 필드가 필요합니다.");
      if (!divisionCode) throw new AppError(400, "divisionCode 필드가 필요합니다.");
      if (!slot || !NAMED_SLOTS[slot]) throw new AppError(400, "slot 필드가 필요합니다.");
      if (!file)         throw new AppError(400, "업로드할 파일이 없습니다.");

      const cfg = NAMED_SLOTS[slot];
      // 이미지 슬롯은 업로드된 파일 확장자를 그대로 사용
      const savedFilename = IMAGE_SLOTS.has(slot)
        ? `${cfg.filename.replace(/\.(jpg|jpeg|png)$/i, "")}${path.extname(file.originalname).toLowerCase()}`
        : cfg.filename;

      const saved = await saveNamedUploadedFile(jobId, divisionCode, userId!, file, savedFilename);

      // Excel 슬롯: 암호화 여부 검증 (저장 직후 읽기 시도)
      const EXCEL_SLOTS = new Set<NamedSlot>(["timesheet", "activity", "activity_gcp", "lims", "eln_report", "eln_service"]);
      if (EXCEL_SLOTS.has(slot)) {
        try {
          XLSX.readFile(file.path, { sheetRows: 1 });
        } catch (e) {
          const msg = (e as Error).message ?? "";
          if (/ecma-376|encrypt|password/i.test(msg)) {
            await deleteFile(saved.id);
            throw new AppError(
              400,
              `'${cfg.label}' 파일이 암호화(비밀번호 보호)되어 있어 읽을 수 없습니다. ` +
              "Excel에서 비밀번호를 제거한 후 다시 업로드해 주세요. " +
              "(방법: [검토] 탭 → [시트 보호 해제] 또는 저장 시 암호 옵션 제거)"
            );
          }
          // 그 외 읽기 오류는 경고만 남기고 허용
          logger.warn(`[FileRouter] xlsx 검증 경고 (${savedFilename}): ${msg}`);
        }
      }

      triggerAnalysis([saved.id]);

      respond.created(res, { jobId, slot, file: saved }, `${savedFilename} 파일이 저장되었습니다.`);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/file/:id
// ---------------------------------------------------------------------------
fileRouter.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    await deleteFile(id);
    respond.noContent(res);
  } catch (err) {
    next(err);
  }
});
