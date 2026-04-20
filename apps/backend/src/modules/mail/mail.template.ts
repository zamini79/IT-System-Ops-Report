/**
 * Mail Template
 *
 * 이메일 클라이언트 호환성을 위해 테이블 기반 레이아웃과 인라인 스타일만 사용합니다.
 */

import { SYSTEM_ORDER, SYSTEM_LABELS } from "../../engines/report/types";
import type { DivisionCode } from "../../engines/playwright/types";
import type { StoredAnalysisResult, SpreadsheetAnalysisResult } from "../../engines/analyzer/types";

// ── 인터페이스 ────────────────────────────────────────────────────────────────

export interface SystemKpi {
  systemName:   string;
  label:        string;
  crawlStatus:  string;
  crawlError:   string | null;
  rowCount:     number | null;
  keyMetric:    { col: string; sum: number } | null;
}

export interface UploadedFileSummary {
  originalName: string;
  fileType:     string;
  fileSize:     number;
  analysisSummary: string;
}

export interface TemplateData {
  divisionCode:    DivisionCode;
  divisionName:    string;
  period:          string;              // "2024.01.01 ~ 2024.03.31"
  generatedAt:     string;             // "2024.03.31 14:30"
  systemKpis:      SystemKpi[];
  uploadedFiles:   UploadedFileSummary[];
  hasPdf:          boolean;
  pdfFilename:     string | null;
}

// ── 유틸리티 ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtBytes(b: number): string {
  if (b < 1024)         return `${b} B`;
  if (b < 1024 * 1024)  return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 1 });
}

// ── 상태 배지 (인라인 스타일) ─────────────────────────────────────────────────

interface BadgeStyle { bg: string; color: string; label: string }

const STATUS_STYLE: Record<string, BadgeStyle> = {
  COMPLETED: { bg: "#dcfce7", color: "#166534", label: "완료" },
  FAILED:    { bg: "#fee2e2", color: "#991b1b", label: "실패" },
  RUNNING:   { bg: "#dbeafe", color: "#1e40af", label: "진행 중" },
  PENDING:   { bg: "#fef3c7", color: "#92400e", label: "대기" },
};

function statusBadge(status: string): string {
  const s   = STATUS_STYLE[status] ?? { bg: "#f3f4f6", color: "#374151", label: status };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;` +
         `font-size:11px;font-weight:600;background:${s.bg};color:${s.color};">${s.label}</span>`;
}

// ── 시스템 행 생성 ────────────────────────────────────────────────────────────

function renderSystemRows(kpis: SystemKpi[]): string {
  if (!kpis.length) {
    return `<tr><td colspan="3" style="padding:12px;text-align:center;color:#9ca3af;font-size:12px;">
      수집된 시스템 정보가 없습니다.</td></tr>`;
  }

  return kpis
    .map((k, i) => {
      const bg   = i % 2 === 0 ? "#ffffff" : "#f9fafb";
      let note   = "";

      if (k.crawlStatus === "FAILED" && k.crawlError) {
        note = `<span style="color:#ef4444;font-size:11px;">${esc(k.crawlError.slice(0, 80))}${k.crawlError.length > 80 ? "…" : ""}</span>`;
      } else if (k.rowCount !== null) {
        note = `<span style="color:#374151;">${fmtNum(k.rowCount)}건 수집</span>`;
        if (k.keyMetric) {
          note += `&ensp;<span style="color:#6b7280;font-size:11px;">(${esc(k.keyMetric.col)} 합계: ${fmtNum(k.keyMetric.sum)})</span>`;
        }
      } else if (k.crawlStatus === "COMPLETED") {
        note = `<span style="color:#6b7280;font-size:11px;">파일 수집 완료</span>`;
      }

      return `<tr style="background:${bg};border-bottom:1px solid #e5e7eb;">
          <td style="padding:10px 12px;font-size:13px;color:#111827;font-weight:500;">${esc(k.label)}</td>
          <td style="padding:10px 12px;text-align:center;">${statusBadge(k.crawlStatus)}</td>
          <td style="padding:10px 12px;font-size:12px;">${note || "&nbsp;"}</td>
        </tr>`;
    })
    .join("\n");
}

// ── 업로드 파일 섹션 ──────────────────────────────────────────────────────────

function renderUploadedFilesSection(files: UploadedFileSummary[]): string {
  if (!files.length) return "";

  const rows = files
    .map(
      (f, i) =>
        `<tr style="background:${i % 2 === 0 ? "#fff" : "#f9fafb"};border-bottom:1px solid #e5e7eb;">
           <td style="padding:8px 12px;font-size:12px;color:#111827;">${esc(f.originalName)}</td>
           <td style="padding:8px 12px;font-size:11px;color:#6b7280;">${esc(f.fileType)}</td>
           <td style="padding:8px 12px;font-size:11px;color:#6b7280;">${fmtBytes(f.fileSize)}</td>
           <td style="padding:8px 12px;font-size:11px;color:#374151;">${esc(f.analysisSummary)}</td>
         </tr>`
    )
    .join("\n");

  return `
  <h3 style="font-size:14px;color:#0f2d5c;margin:0 0 10px;border-bottom:2px solid #1d4ed8;padding-bottom:6px;">
    업로드 파일 분석 요약
  </h3>
  <table width="100%" cellpadding="0" cellspacing="0"
         style="border-collapse:collapse;margin:0 0 24px;font-family:Arial,sans-serif;">
    <thead>
      <tr style="background:#374151;">
        <th style="color:#fff;padding:8px 12px;text-align:left;font-size:11px;width:35%;">파일명</th>
        <th style="color:#fff;padding:8px 12px;text-align:left;font-size:11px;width:20%;">형식</th>
        <th style="color:#fff;padding:8px 12px;text-align:left;font-size:11px;width:15%;">크기</th>
        <th style="color:#fff;padding:8px 12px;text-align:left;font-size:11px;">분석 요약</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── PDF 첨부 안내 섹션 ────────────────────────────────────────────────────────

function renderPdfSection(hasPdf: boolean, filename: string | null): string {
  if (!hasPdf || !filename) {
    return `<p style="color:#6b7280;font-size:12px;background:#f9fafb;padding:10px 14px;border-radius:6px;margin:0 0 20px;">
      📌 상세 보고서(PDF)는 생성 완료 후 별도 발송될 예정입니다.</p>`;
  }
  return `<p style="color:#1e40af;font-size:12px;background:#eff6ff;padding:10px 14px;border-radius:6px;
    border-left:3px solid #1d4ed8;margin:0 0 20px;">
    📎 첨부 파일: <strong>${esc(filename)}</strong><br>
    <span style="color:#6b7280;">상세 분석 내용은 첨부된 PDF 보고서를 참조 바랍니다.</span>
  </p>`;
}

// ── 공개 함수: 제목 생성 ──────────────────────────────────────────────────────

export function buildSubject(divisionName: string, refDate: Date): string {
  const yyyy = refDate.getFullYear();
  const mm   = String(refDate.getMonth() + 1).padStart(2, "0");
  return `[SKBS] ${divisionName} IT 시스템 운영 현황 보고 (${yyyy}년 ${mm}월)`;
}

// ── 공개 함수: HTML 본문 생성 ─────────────────────────────────────────────────

export function buildBodyHtml(data: TemplateData): string {
  const systemRowsHtml      = renderSystemRows(data.systemKpis);
  const uploadedSection     = renderUploadedFilesSection(data.uploadedFiles);
  const pdfSection          = renderPdfSection(data.hasPdf, data.pdfFilename);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,'맑은 고딕',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr>
    <td align="center" style="padding:24px 0;">

      <!-- ── 컨테이너 600px ── -->
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">

        <!-- 헤더 -->
        <tr>
          <td style="background:#0f2d5c;padding:28px 32px;">
            <p style="color:rgba(255,255,255,.55);font-size:10px;letter-spacing:.12em;
                      text-transform:uppercase;margin:0 0 6px;">SKBS · IT 운영팀</p>
            <h1 style="color:#ffffff;font-size:20px;font-weight:700;margin:0;line-height:1.3;">
              IT 시스템 운영 현황 보고
            </h1>
            <p style="color:rgba(255,255,255,.7);font-size:13px;margin:6px 0 0;">
              ${esc(data.divisionName)}
            </p>
          </td>
        </tr>

        <!-- 본문 -->
        <tr>
          <td style="padding:28px 32px;">

            <!-- 인사말 -->
            <p style="color:#374151;font-size:14px;line-height:1.75;margin:0 0 20px;">
              안녕하세요,<br>
              <strong style="color:#111827;">${esc(data.divisionName)}</strong> IT 시스템 운영 현황
              보고 자료를 전달드립니다.<br>
              아래 내용을 검토해 주시기 바랍니다.
            </p>

            <!-- 보고 기간 정보 -->
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="border:1px solid #e5e7eb;border-radius:6px;margin:0 0 24px;border-collapse:collapse;">
              <tr style="background:#f9fafb;">
                <td style="padding:10px 14px;font-size:12px;color:#6b7280;
                            font-weight:600;width:110px;border-bottom:1px solid #e5e7eb;">담당 본부</td>
                <td style="padding:10px 14px;font-size:13px;color:#111827;
                            border-bottom:1px solid #e5e7eb;">${esc(data.divisionName)}</td>
              </tr>
              <tr>
                <td style="padding:10px 14px;font-size:12px;color:#6b7280;
                            font-weight:600;border-bottom:1px solid #e5e7eb;">보고 기간</td>
                <td style="padding:10px 14px;font-size:13px;color:#111827;
                            border-bottom:1px solid #e5e7eb;">${esc(data.period)}</td>
              </tr>
              <tr style="background:#f9fafb;">
                <td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;">보고서 생성</td>
                <td style="padding:10px 14px;font-size:13px;color:#111827;">${esc(data.generatedAt)}</td>
              </tr>
            </table>

            <!-- 시스템별 운영 현황 -->
            <h3 style="font-size:14px;color:#0f2d5c;margin:0 0 10px;
                        border-bottom:2px solid #1d4ed8;padding-bottom:6px;">
              시스템별 운영 현황
            </h3>
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="border-collapse:collapse;margin:0 0 24px;">
              <thead>
                <tr style="background:#0f2d5c;">
                  <th style="color:#fff;padding:10px 12px;text-align:left;font-size:12px;width:35%;">시스템</th>
                  <th style="color:#fff;padding:10px 12px;text-align:center;font-size:12px;width:20%;">수집 상태</th>
                  <th style="color:#fff;padding:10px 12px;text-align:left;font-size:12px;">비고</th>
                </tr>
              </thead>
              <tbody>
                ${systemRowsHtml}
              </tbody>
            </table>

            ${uploadedSection}
            ${pdfSection}

            <!-- 마무리 인사 -->
            <p style="color:#374151;font-size:13px;line-height:1.75;margin:4px 0 0;">
              내용에 관한 문의사항이 있으시면 언제든지 연락 주시기 바랍니다.<br>
              감사합니다.
            </p>
          </td>
        </tr>

        <!-- 서명 -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:18px 32px;">
            <p style="color:#111827;font-size:13px;font-weight:700;margin:0 0 3px;">
              SKBS IT 운영팀
            </p>
            <p style="color:#9ca3af;font-size:11px;margin:0;">
              본 메일은 시스템에서 자동 생성되었습니다. 직접 회신하지 마세요.
            </p>
          </td>
        </tr>

      </table>
      <!-- /컨테이너 -->

    </td>
  </tr>
</table>
</body>
</html>`;
}

// ── KPI 추출 헬퍼 (service 에서 사용) ────────────────────────────────────────

/**
 * crawl_tasks 행과 SYSTEM_ORDER 를 이용해 SystemKpi 배열을 구성합니다.
 */
export function buildSystemKpis(
  divisionCode: DivisionCode,
  taskRows: Array<{
    system_name: string;
    task_type:   string;
    status:      string;
    error:       string | null;
    result_path: string | null;
  }>
): SystemKpi[] {
  const order = SYSTEM_ORDER[divisionCode] ?? [];

  return order.map((sysName) => {
    const downloadTask = taskRows.find(
      (t) => t.system_name === sysName && t.task_type === "DOWNLOAD"
    );

    return {
      systemName:  sysName,
      label:       SYSTEM_LABELS[sysName] ?? sysName,
      crawlStatus: downloadTask?.status   ?? "PENDING",
      crawlError:  downloadTask?.error    ?? null,
      rowCount:    null,
      keyMetric:   null,
    };
  });
}

/**
 * uploaded_files.analysis_result JSONB 에서 분석 요약 문자열을 추출합니다.
 */
export function extractAnalysisSummary(stored: StoredAnalysisResult | null): string {
  if (!stored || stored.status !== "completed" || !stored.result) {
    return stored?.status === "pending" ? "분석 중" : "분석 없음";
  }

  const r = stored.result;
  if (r.type === "excel" || r.type === "csv") {
    const total = r.sheets.reduce((s, sh) => s + sh.totalRows, 0);
    return `${r.sheets.length}개 시트, 총 ${total.toLocaleString()}행`;
  }
  if (r.type === "pdf") {
    return `PDF ${r.pageCount}페이지`;
  }
  if (r.type === "image") {
    return `${r.width}×${r.height}px (${r.format.toUpperCase()})`;
  }
  return "분석 완료";
}
