/**
 * ReportBuilder
 *
 * ReportData 를 받아 Puppeteer 로 PDF 변환할 수 있는 자립형(self-contained) HTML 을 생성합니다.
 *
 * 섹션 순서
 *  1. 표지   — 본부명, 보고 기간, 생성일시
 *  2. 전체 요약  — 시스템별 핵심 지표 카드 그리드
 *  3. 시스템 섹션 × N — 섹션 헤더, 스크린샷, KPI 테이블, 업로드 파일 분석
 *  4. 별첨   — 추가 업로드 자료 목록
 */

import { ReportDataLoader } from "./ReportDataLoader";
import type {
  ReportData,
  SystemReportData,
  UploadedFileInfo,
  ReportPeriod,
  ReportJobInfo,
} from "./types";
import type {
  SpreadsheetAnalysisResult,
  NumericSummary,
  StoredAnalysisResult,
} from "../analyzer/types";

// ── 날짜 포매터 ───────────────────────────────────────────────────────────────

function fmt(d: Date, includeTime = false): string {
  const pad  = (n: number) => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  if (!includeTime) return base;
  return `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtPeriod(period: ReportPeriod): string {
  return `${fmt(period.from)} ~ ${fmt(period.to)}`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtNumber(n: number): string {
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

// ── 상태 배지 ─────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  COMPLETED: "완료",
  FAILED:    "실패",
  RUNNING:   "실행 중",
  PENDING:   "대기",
};

function statusBadge(status: string): string {
  const label = STATUS_LABEL[status] ?? status;
  const cls   = `status-${status.toLowerCase()}`;
  return `<span class="badge ${cls}">${label}</span>`;
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
  @charset "UTF-8";
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: "Apple SD Gothic Neo", "Noto Sans KR", "맑은 고딕", Arial, sans-serif;
    font-size: 10pt;
    color: #1a1a1a;
    line-height: 1.65;
    background: #fff;
  }

  /* ── 페이지 공통 ──────────────────────────────────────── */
  .page {
    padding: 2.5cm 2cm;
    page-break-after: always;
  }
  .page:last-child { page-break-after: avoid; }

  /* ── 표지 ─────────────────────────────────────────────── */
  .cover {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 25cm;
    background: linear-gradient(150deg, #0f2d5c 0%, #1d4ed8 100%);
    color: #fff;
    text-align: center;
    border-radius: 4px;
  }
  .cover-eyebrow {
    font-size: 9pt;
    letter-spacing: .25em;
    text-transform: uppercase;
    opacity: .7;
    margin-bottom: 2.5rem;
  }
  .cover-title {
    font-size: 26pt;
    font-weight: 700;
    line-height: 1.3;
    margin-bottom: .75rem;
  }
  .cover-division {
    font-size: 16pt;
    font-weight: 400;
    opacity: .9;
    margin-bottom: 3.5rem;
  }
  .cover-divider {
    width: 48px;
    height: 2px;
    background: rgba(255,255,255,.5);
    margin: 0 auto 2rem;
  }
  .cover-meta {
    font-size: 10pt;
    opacity: .75;
    line-height: 2;
  }
  .cover-meta strong { opacity: 1; }

  /* ── 섹션 제목 ────────────────────────────────────────── */
  .section-title {
    font-size: 15pt;
    font-weight: 700;
    color: #0f2d5c;
    border-bottom: 2.5px solid #1d4ed8;
    padding-bottom: .45rem;
    margin-bottom: 1.5rem;
  }
  .system-title {
    font-size: 13pt;
    font-weight: 700;
    color: #0f2d5c;
  }
  .system-header {
    display: flex;
    align-items: center;
    gap: .8rem;
    margin-bottom: 1.2rem;
    padding-bottom: .5rem;
    border-bottom: 1px solid #e2e8f0;
  }
  .system-period {
    font-size: 8.5pt;
    color: #64748b;
    margin-left: auto;
  }

  /* ── KPI 카드 그리드 (요약 페이지) ───────────────────── */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .kpi-card {
    border: 1px solid #e2e8f0;
    border-top: 3px solid #1d4ed8;
    border-radius: 6px;
    padding: .9rem 1rem;
    background: #f8fafc;
  }
  .kpi-card-name {
    font-size: 9pt;
    font-weight: 600;
    color: #475569;
    margin-bottom: .4rem;
    display: flex;
    align-items: center;
    gap: .4rem;
  }
  .kpi-card-value {
    font-size: 17pt;
    font-weight: 700;
    color: #0f2d5c;
    line-height: 1;
  }
  .kpi-card-sub {
    font-size: 8pt;
    color: #94a3b8;
    margin-top: .3rem;
  }

  /* ── 상태 배지 ────────────────────────────────────────── */
  .badge {
    display: inline-block;
    padding: .15em .5em;
    border-radius: 4px;
    font-size: 8pt;
    font-weight: 600;
    line-height: 1.5;
  }
  .status-completed { background:#dcfce7; color:#166534; }
  .status-failed    { background:#fee2e2; color:#991b1b; }
  .status-running   { background:#dbeafe; color:#1e40af; }
  .status-pending   { background:#fef3c7; color:#92400e; }

  /* ── 스크린샷 ─────────────────────────────────────────── */
  .screenshot-wrap {
    margin: 1rem 0;
    border: 1px solid #e2e8f0;
    border-radius: 4px;
    overflow: hidden;
    text-align: center;
  }
  .screenshot-wrap img {
    max-width: 100%;
    height: auto;
    display: block;
  }
  .screenshot-caption {
    font-size: 8pt;
    color: #94a3b8;
    padding: .3rem;
    background: #f8fafc;
  }

  /* ── 테이블 ───────────────────────────────────────────── */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 8.5pt;
    margin: .75rem 0 1.25rem;
  }
  th {
    background: #0f2d5c;
    color: #fff;
    padding: .45rem .65rem;
    text-align: left;
    font-weight: 600;
    white-space: nowrap;
  }
  td {
    padding: .35rem .65rem;
    border-bottom: 1px solid #e2e8f0;
    vertical-align: top;
  }
  tr:nth-child(even) td { background: #f8fafc; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #94a3b8; font-size: 8pt; }

  /* ── 소제목 ───────────────────────────────────────────── */
  .sub-title {
    font-size: 10pt;
    font-weight: 600;
    color: #374151;
    margin: 1rem 0 .4rem;
  }

  /* ── 빈 데이터 표시 ───────────────────────────────────── */
  .empty {
    text-align: center;
    color: #94a3b8;
    font-size: 9pt;
    padding: .8rem;
    border: 1px dashed #e2e8f0;
    border-radius: 4px;
    margin: .5rem 0;
  }

  /* ── 별첨 항목 ────────────────────────────────────────── */
  .appendix-item {
    border: 1px solid #e2e8f0;
    border-radius: 4px;
    padding: .7rem .9rem;
    margin-bottom: .6rem;
    background: #f8fafc;
  }
  .appendix-name { font-weight: 600; color: #0f2d5c; }
  .appendix-meta { font-size: 8pt; color: #64748b; margin-top: .2rem; }
  .appendix-excerpt {
    font-size: 8pt;
    color: #374151;
    margin-top: .4rem;
    max-height: 4em;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ── 인쇄 ─────────────────────────────────────────────── */
  @media print {
    @page { size: A4; margin: 1.5cm 2cm; }
    .page { padding: 0; min-height: auto; }
    .cover { min-height: auto; padding: 4cm 2cm; }
  }
`;

// ── ReportBuilder ────────────────────────────────────────────────────────────

export class ReportBuilder {
  private readonly loader = new ReportDataLoader();

  /**
   * jobId 에 해당하는 보고서 HTML 을 생성합니다.
   */
  async build(jobId: string): Promise<string> {
    const data = await this.loader.load(jobId);
    return this.renderDocument(data);
  }

  // ── 문서 조립 ──────────────────────────────────────────────────────────────

  private renderDocument(data: ReportData): string {
    const sections = [
      this.renderCoverPage(data.job, data.period),
      this.renderSummaryPage(data.systems, data.period),
      ...data.systems.map((s) => this.renderSystemSection(s, data.period)),
    ];

    if (data.uploadedFiles.length > 0) {
      sections.push(this.renderAppendixPage(data.uploadedFiles));
    }

    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${data.job.divisionName} IT 운영 보고서</title>
  <style>${CSS}</style>
</head>
<body>
${sections.join("\n")}
</body>
</html>`;
  }

  // ── 1. 표지 ─────────────────────────────────────────────────────────────────

  private renderCoverPage(job: ReportJobInfo, period: ReportPeriod): string {
    return `
<div class="page">
  <div class="cover">
    <div class="cover-eyebrow">IT 운영 보고서</div>
    <div class="cover-title">${escHtml(job.divisionName)}</div>
    <div class="cover-division">IT Operations Report</div>
    <div class="cover-divider"></div>
    <div class="cover-meta">
      <div><strong>보고 기간</strong>&ensp;${fmtPeriod(period)}</div>
      <div><strong>생성 일시</strong>&ensp;${fmt(new Date(), true)}</div>
      <div><strong>작업 ID</strong>&ensp;<span style="font-family:monospace;font-size:8pt">${escHtml(job.id)}</span></div>
    </div>
  </div>
</div>`;
  }

  // ── 2. 전체 요약 ─────────────────────────────────────────────────────────────

  private renderSummaryPage(systems: SystemReportData[], period: ReportPeriod): string {
    const cards = systems.map((s) => this.renderKpiCard(s)).join("\n");

    return `
<div class="page">
  <div class="section-title">전체 요약</div>
  <p class="muted" style="margin-bottom:1rem">보고 기간: ${fmtPeriod(period)}</p>
  <div class="kpi-grid">
${cards}
  </div>
</div>`;
  }

  private renderKpiCard(s: SystemReportData): string {
    const firstSheet = s.downloadedAnalysis?.sheets?.[0];
    const totalRows  = firstSheet?.totalRows ?? "-";

    // 첫 번째 숫자 컬럼의 합계를 대표 지표로 사용
    const summaryEntries = firstSheet
      ? Object.entries(firstSheet.summary)
      : [];
    const firstMetric = summaryEntries[0];

    const metricLine = firstMetric
      ? `<div class="kpi-card-sub">${escHtml(firstMetric[0])} 합계: ${fmtNumber(firstMetric[1].sum)}</div>`
      : "";

    return `    <div class="kpi-card">
      <div class="kpi-card-name">
        ${escHtml(s.label)}&ensp;${statusBadge(s.crawlStatus)}
      </div>
      <div class="kpi-card-value">${typeof totalRows === "number" ? fmtNumber(totalRows) : totalRows}</div>
      <div class="kpi-card-sub">레코드 수</div>
      ${metricLine}
    </div>`;
  }

  // ── 3. 시스템 섹션 ────────────────────────────────────────────────────────────

  private renderSystemSection(s: SystemReportData, period: ReportPeriod): string {
    const screenshot = s.screenshotBase64
      ? `<div class="screenshot-wrap">
          <img src="${s.screenshotBase64}" alt="${escHtml(s.label)} 화면 캡처" />
          <div class="screenshot-caption">화면 캡처 — ${escHtml(s.label)}</div>
        </div>`
      : "";

    const kpiContent = s.downloadedAnalysis
      ? this.renderSpreadsheetAnalysis(s.downloadedAnalysis)
      : (s.crawlStatus === "FAILED"
          ? `<div class="empty">⚠ 크롤 실패: ${escHtml(s.crawlError ?? "알 수 없는 오류")}</div>`
          : `<div class="empty">수집된 데이터 없음</div>`);

    return `
<div class="page">
  <div class="system-header">
    <div class="system-title">${escHtml(s.label)}</div>
    ${statusBadge(s.crawlStatus)}
    <span class="system-period">기간: ${fmtPeriod(period)}</span>
  </div>

  ${screenshot}

  <div class="sub-title">핵심 지표</div>
  ${kpiContent}
</div>`;
  }

  // ── 스프레드시트 분석 결과 렌더링 ──────────────────────────────────────────

  private renderSpreadsheetAnalysis(result: SpreadsheetAnalysisResult): string {
    return result.sheets
      .map((sheet) => {
        const summaryTable = this.renderNumericSummaryTable(sheet.summary);
        const dataTable    = this.renderDataTable(
          sheet.headers,
          sheet.recentRows.length > 0 ? sheet.recentRows : sheet.rows,
          sheet.recentRows.length > 0
        );

        return `
  <div class="sub-title">시트: ${escHtml(sheet.name)}&ensp;<span class="muted">(전체 ${fmtNumber(sheet.totalRows)}행)</span></div>
  ${summaryTable}
  ${dataTable}`;
      })
      .join("");
  }

  /** 숫자 컬럼 집계 요약 테이블 */
  private renderNumericSummaryTable(
    summary: Record<string, NumericSummary>
  ): string {
    const entries = Object.entries(summary);
    if (!entries.length) return "";

    const rows = entries
      .map(
        ([col, s]) =>
          `<tr>
            <td>${escHtml(col)}</td>
            <td class="num">${fmtNumber(s.sum)}</td>
            <td class="num">${fmtNumber(s.avg)}</td>
            <td class="num">${fmtNumber(s.max)}</td>
            <td class="num">${fmtNumber(s.min)}</td>
            <td class="num">${fmtNumber(s.count)}</td>
          </tr>`
      )
      .join("\n");

    return `
  <table>
    <thead>
      <tr>
        <th>컬럼</th><th>합계</th><th>평균</th><th>최대</th><th>최소</th><th>건수</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
  }

  /** 데이터 행 테이블 (최대 20행) */
  private renderDataTable(
    headers: string[],
    rows:    Record<string, unknown>[],
    isRecent: boolean
  ): string {
    if (!headers.length || !rows.length) {
      return `<div class="empty">표시할 데이터가 없습니다.</div>`;
    }

    const display = rows.slice(0, 20);
    const caption = isRecent
      ? `최근 3개월 데이터 (${display.length}/${rows.length}행)`
      : `데이터 샘플 (${display.length}/${rows.length}행)`;

    const ths = headers
      .map((h) => `<th>${escHtml(String(h))}</th>`)
      .join("");

    const trs = display
      .map(
        (row) =>
          `<tr>${headers
            .map((h) => {
              const v = row[h];
              return `<td>${v === null || v === undefined ? "" : escHtml(String(v))}</td>`;
            })
            .join("")}</tr>`
      )
      .join("\n");

    return `
  <div class="muted" style="margin-bottom:.3rem">${caption}</div>
  <table>
    <thead><tr>${ths}</tr></thead>
    <tbody>${trs}</tbody>
  </table>`;
  }

  // ── 4. 별첨 ─────────────────────────────────────────────────────────────────

  private renderAppendixPage(files: UploadedFileInfo[]): string {
    const items = files.map((f) => this.renderAppendixItem(f)).join("\n");

    return `
<div class="page">
  <div class="section-title">별첨 — 추가 업로드 자료</div>
  <p class="muted" style="margin-bottom:1rem">총 ${files.length}개 파일</p>
${items}
</div>`;
  }

  private renderAppendixItem(f: UploadedFileInfo): string {
    const stored = f.analysisResult;
    let analysisHtml = "";

    if (!stored || stored.status === "pending") {
      analysisHtml = `<div class="muted">분석 중…</div>`;
    } else if (stored.status === "failed") {
      analysisHtml = `<div class="muted">분석 실패: ${escHtml(stored.error ?? "")}</div>`;
    } else if (stored.result) {
      const r = stored.result;

      if (r.type === "excel" || r.type === "csv") {
        const sheetSummary = r.sheets
          .map(
            (s) =>
              `${escHtml(s.name)}: ${fmtNumber(s.totalRows)}행` +
              (s.dateColumns.length > 0
                ? `, 날짜 컬럼 [${s.dateColumns.map(escHtml).join(", ")}]`
                : "")
          )
          .join(" / ");
        analysisHtml = `<div class="appendix-excerpt">${sheetSummary}</div>`;

      } else if (r.type === "pdf") {
        const excerpt = r.fullText.slice(0, 300).replace(/\n{3,}/g, "\n\n");
        analysisHtml = `
          <div class="muted">${r.pageCount}페이지</div>
          <div class="appendix-excerpt">${escHtml(excerpt)}${r.fullText.length > 300 ? "…" : ""}</div>`;

      } else if (r.type === "image") {
        analysisHtml = `<div class="muted">${r.width} × ${r.height}px / ${escHtml(r.format.toUpperCase())}</div>`;
      }
    }

    return `  <div class="appendix-item">
    <div class="appendix-name">${escHtml(f.originalName)}</div>
    <div class="appendix-meta">
      ${escHtml(f.fileType)}&ensp;·&ensp;${fmtBytes(f.fileSize)}&ensp;·&ensp;${fmt(f.createdAt, true)}
    </div>
    ${analysisHtml}
  </div>`;
  }
}

// ── 유틸리티 ──────────────────────────────────────────────────────────────────

/** HTML 특수문자 이스케이프 */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
