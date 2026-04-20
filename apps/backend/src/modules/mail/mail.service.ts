/**
 * Mail Service
 *
 * mail_drafts CRUD + 데이터 조회 기반 초안 자동 생성
 */

import path from "path";
import { query } from "../../config/db";
import { AppError } from "../../utils/errors";
import type { DivisionCode } from "../../engines/playwright/types";
import type { StoredAnalysisResult } from "../../engines/analyzer/types";
import {
  buildSubject,
  buildBodyHtml,
  buildSystemKpis,
  extractAnalysisSummary,
  type TemplateData,
  type UploadedFileSummary,
} from "./mail.template";

// ── DB Row 타입 ───────────────────────────────────────────────────────────────

export interface RecipientGroupRow {
  id:            string;
  division_code: string;
  name:          string;
  emails:        string[];
  created_at:    string;
}

export interface DraftRow {
  id:            string;
  report_job_id: string;
  recipients:    string[];
  cc:            string[];
  subject:       string;
  body_html:     string;
  created_at:    string;
  updated_at:    string;
}

interface JobRow {
  id:            string;
  status:        string;
  pdf_path:      string | null;
  created_at:    string;
  division_code: string;
  division_name: string;
}

interface TaskRow {
  system_name: string;
  task_type:   string;
  status:      string;
  error:       string | null;
  result_path: string | null;
}

interface FileRow {
  id:              string;
  original_name:   string;
  file_type:       string;
  file_size:       number;
  analysis_result: StoredAnalysisResult | null;
}

// ── 날짜 포매터 ───────────────────────────────────────────────────────────────

function fmt(d: Date, withTime = false): string {
  const p  = (n: number) => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
  return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}

// ── 초안 자동 생성 ────────────────────────────────────────────────────────────

/**
 * jobId 에 연결된 데이터를 조회하여 메일 초안을 생성하고 DB 에 저장합니다.
 */
export async function generateDraft(jobId: string): Promise<DraftRow> {
  // ── 1. report_jobs + divisions 조회 ───────────────────────────────────────
  const jobRows = await query<JobRow>(
    `SELECT rj.id, rj.status, rj.pdf_path, rj.created_at,
            d.code AS division_code, d.name AS division_name
     FROM report_jobs rj
     JOIN divisions   d ON rj.division_id = d.id
     WHERE rj.id = $1`,
    [jobId]
  );
  if (!jobRows.length) throw new AppError(404, `보고서 작업을 찾을 수 없습니다: ${jobId}`);

  const job          = jobRows[0];
  const divisionCode = job.division_code as DivisionCode;
  const createdAt    = new Date(job.created_at);

  // ── 2. crawl_tasks 조회 ───────────────────────────────────────────────────
  const taskRows = await query<TaskRow>(
    `SELECT system_name, task_type, status, error, result_path
     FROM crawl_tasks
     WHERE report_job_id = $1`,
    [jobId]
  );

  // ── 3. uploaded_files 조회 ────────────────────────────────────────────────
  const fileRows = await query<FileRow>(
    `SELECT id, original_name, file_type, file_size, analysis_result
     FROM uploaded_files
     WHERE report_job_id = $1
     ORDER BY created_at`,
    [jobId]
  );

  // ── 4. 핵심 지표 구성 ─────────────────────────────────────────────────────
  const systemKpis = buildSystemKpis(divisionCode, taskRows);

  const uploadedFiles: UploadedFileSummary[] = fileRows.map((f) => ({
    originalName:    f.original_name,
    fileType:        f.file_type,
    fileSize:        f.file_size,
    analysisSummary: extractAnalysisSummary(f.analysis_result),
  }));

  // ── 5. 보고 기간 (job 생성일 기준 최근 3개월) ─────────────────────────────
  const periodTo   = new Date(createdAt);
  const periodFrom = new Date(createdAt);
  periodFrom.setMonth(periodFrom.getMonth() - 3);
  const period = `${fmt(periodFrom)} ~ ${fmt(periodTo)}`;

  // ── 6. PDF 파일명 ─────────────────────────────────────────────────────────
  const pdfFilename = job.pdf_path ? path.basename(job.pdf_path) : null;

  // ── 7. HTML 생성 ──────────────────────────────────────────────────────────
  const templateData: TemplateData = {
    divisionCode,
    divisionName: job.division_name,
    period,
    generatedAt:  fmt(new Date(), true),
    systemKpis,
    uploadedFiles,
    hasPdf:       !!job.pdf_path,
    pdfFilename,
  };

  const subject  = buildSubject(job.division_name, createdAt);
  const bodyHtml = buildBodyHtml(templateData);

  // ── 8. 해당 본부의 기본 수신자 그룹 이메일 수집 ──────────────────────────
  const groupRows = await query<{ emails: string[] }>(
    `SELECT emails FROM mail_recipient_groups WHERE division_code = $1`,
    [divisionCode]
  );
  const defaultRecipients = [
    ...new Set(groupRows.flatMap((g) => g.emails)),
  ];

  // ── 9. mail_drafts INSERT ─────────────────────────────────────────────────
  const inserted = await query<DraftRow>(
    `INSERT INTO mail_drafts (report_job_id, recipients, subject, body_html)
     VALUES ($1, $2, $3, $4)
     RETURNING id, report_job_id, recipients, cc, subject, body_html, created_at, updated_at`,
    [jobId, defaultRecipients, subject, bodyHtml]
  );

  return inserted[0];
}

// ── 조회 ─────────────────────────────────────────────────────────────────────

/** 단일 초안 조회 */
export async function getDraft(draftId: string): Promise<DraftRow> {
  const rows = await query<DraftRow>(
    `SELECT id, report_job_id, recipients, cc, subject, body_html, created_at, updated_at
     FROM mail_drafts WHERE id = $1`,
    [draftId]
  );
  if (!rows.length) throw new AppError(404, `메일 초안을 찾을 수 없습니다: ${draftId}`);
  return rows[0];
}

/** jobId 기준 초안 목록 조회 (페이지네이션) */
export async function listDraftsByJobId(
  jobId: string,
  page:  number,
  limit: number
): Promise<{ items: DraftRow[]; total: number }> {
  const offset = (page - 1) * limit;

  const [items, countRows] = await Promise.all([
    query<DraftRow>(
      `SELECT id, report_job_id, recipients, cc, subject, body_html, created_at, updated_at
       FROM mail_drafts
       WHERE report_job_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [jobId, limit, offset]
    ),
    query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM mail_drafts WHERE report_job_id = $1",
      [jobId]
    ),
  ]);

  return { items, total: Number(countRows[0]?.count ?? 0) };
}

// ── 수정 ─────────────────────────────────────────────────────────────────────

/** 초안 전체 교체 (PUT 의미론) */
export async function updateDraft(
  draftId: string,
  data: {
    recipients: string[];
    cc:         string[];
    subject:    string;
    body_html:  string;
  }
): Promise<DraftRow> {
  const rows = await query<DraftRow>(
    `UPDATE mail_drafts
     SET recipients = $1,
         cc         = $2,
         subject    = $3,
         body_html  = $4,
         updated_at = NOW()
     WHERE id = $5
     RETURNING id, report_job_id, recipients, cc, subject, body_html, created_at, updated_at`,
    [data.recipients, data.cc, data.subject, data.body_html, draftId]
  );
  if (!rows.length) throw new AppError(404, `메일 초안을 찾을 수 없습니다: ${draftId}`);
  return rows[0];
}

// ── 삭제 ─────────────────────────────────────────────────────────────────────

export async function deleteDraft(draftId: string): Promise<void> {
  const rows = await query<{ id: string }>(
    "DELETE FROM mail_drafts WHERE id = $1 RETURNING id",
    [draftId]
  );
  if (!rows.length) throw new AppError(404, `메일 초안을 찾을 수 없습니다: ${draftId}`);
}

// ── 수신자 그룹 ───────────────────────────────────────────────────────────────

/** division_code 기준 수신자 그룹 목록 조회 */
export async function listGroups(
  divisionCode?: string
): Promise<RecipientGroupRow[]> {
  return query<RecipientGroupRow>(
    `SELECT id, division_code, name, emails, created_at
     FROM mail_recipient_groups
     WHERE ($1::text IS NULL OR division_code = $1)
     ORDER BY division_code, created_at`,
    [divisionCode ?? null]
  );
}

/** 수신자 그룹 생성 */
export async function createGroup(data: {
  division_code: string;
  name:          string;
  emails:        string[];
}): Promise<RecipientGroupRow> {
  const rows = await query<RecipientGroupRow>(
    `INSERT INTO mail_recipient_groups (division_code, name, emails)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, division_code, name, emails, created_at`,
    [data.division_code, data.name, JSON.stringify(data.emails)]
  );
  return rows[0];
}

/** 수신자 그룹 수정 */
export async function updateGroup(
  groupId: string,
  data: { name?: string; emails?: string[] }
): Promise<RecipientGroupRow> {
  const rows = await query<RecipientGroupRow>(
    `UPDATE mail_recipient_groups
     SET name   = COALESCE($1, name),
         emails = COALESCE($2::jsonb, emails)
     WHERE id = $3
     RETURNING id, division_code, name, emails, created_at`,
    [
      data.name ?? null,
      data.emails !== undefined ? JSON.stringify(data.emails) : null,
      groupId,
    ]
  );
  if (!rows.length) throw new AppError(404, `수신자 그룹을 찾을 수 없습니다: ${groupId}`);
  return rows[0];
}

/** 수신자 그룹 삭제 */
export async function deleteGroup(groupId: string): Promise<void> {
  const rows = await query<{ id: string }>(
    "DELETE FROM mail_recipient_groups WHERE id = $1 RETURNING id",
    [groupId]
  );
  if (!rows.length) throw new AppError(404, `수신자 그룹을 찾을 수 없습니다: ${groupId}`);
}
