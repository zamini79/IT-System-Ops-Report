/**
 * BIO (Bio연구본부) 보고서 생성 서비스
 *
 * 페이지 구성:
 *  - 표지: "Bio연구본부 시스템 운영 현황"
 *  - Page 1: "1. 시스템 사용 현황" — 플레이스홀더 (추후 업데이트 예정)
 *  - Page 2 (선택): "2. Managed Service 진행 현황"
 *                   MS Timesheet (DB 에서 최신 파일 조회)
 */

import fs   from "fs";
import path from "path";

import * as XLSX    from "xlsx";
import { chromium } from "playwright";

import { logger }       from "../../utils/logger";
import { PdfGenerator } from "../../engines/report/PdfGenerator";
import { query }        from "../../config/db";

// ── 날짜 헬퍼 ─────────────────────────────────────────────────────────────────

function getLastMonth(): { year: number; month: number } {
  const now = new Date();
  const m   = now.getMonth();
  return m === 0
    ? { year: now.getFullYear() - 1, month: 12 }
    : { year: now.getFullYear(),     month: m };
}

// ── MS Timesheet 데이터 구조 ─────────────────────────────────────────────────

/** YYYY-MM 시트에서 추출한 SKB GMP 1행 요약 (막대 차트용) */
interface MsChartRow {
  month:     string;  // e.g. "2026-03"
  possible:  number;  // B열 = GMP 가능 MS
  used:      number;  // C열 = GMP 사용 MS
  remaining: number;  // D열 = GMP 잔여 MS
}

/** SKB GMP 그룹 내 세부 작업 행 (테이블용) */
interface MsTableRow {
  hours:     string;  // E열
  system:    string;  // G열
  category:  string;  // H열
  subject:   string;  // I열
  detail:    string;  // J열
  startDate: string;  // K열 (Excel 시리얼 → YYYY-MM-DD)
  endDate:   string;  // L열
  status:    string;  // M열
}

interface MsTimesheetData {
  chartRows:   MsChartRow[];
  tableRows:   MsTableRow[];
  latestMonth: string;    // e.g. "2026-03"
  colHeaders:  string[];  // E,G,H,I,J,K,L,M 열 헤더 (row 0 에서 읽음)
}

// ── MS Timesheet 헬퍼 ────────────────────────────────────────────────────────

function escHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function excelDateToStr(serial: unknown): string {
  if (typeof serial !== "number" || serial < 1) return String(serial ?? "");
  const d   = new Date((serial - 25569) * 86400 * 1000);
  const y   = d.getUTCFullYear();
  const m   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatMonthKorean(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  return `${y}년 ${m}월`;
}

// ── Chart.js 로컬 번들 로드 ───────────────────────────────────────────────────

function loadChartJsScript(): string {
  const candidates = [
    path.resolve(__dirname, "../../../../node_modules/chart.js/dist/chart.umd.js"),
    path.resolve(__dirname, "../../../node_modules/chart.js/dist/chart.umd.js"),
    path.resolve(process.cwd(), "../../node_modules/chart.js/dist/chart.umd.js"),
    path.resolve(process.cwd(), "node_modules/chart.js/dist/chart.umd.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      logger.info(`[BIO Report] Chart.js 로컬 번들: ${p}`);
      return fs.readFileSync(p, "utf-8");
    }
  }
  logger.warn("[BIO Report] Chart.js 로컬 번들 없음 — CDN 사용");
  return "";
}

// ── MS Timesheet 읽기 ─────────────────────────────────────────────────────────

/**
 * SKB_Quallity_MS_Timesheet.xlsx 에서 막대 차트·표 데이터를 추출합니다.
 *
 * YYYY-MM 시트별:
 *  - A열 = "SKB GMP" 인 첫 행 → B(가능)/C(사용)/D(잔여) 값 수집 (막대 차트용)
 *  - 최신 월 시트의 SKB GMP 그룹 하위 행 → E/G/H/I/J/K/L/M 수집 (표 용)
 */
function readMsTimesheetData(xlsxPath: string): MsTimesheetData {
  const wb = XLSX.readFile(xlsxPath);

  // YYYY-MM 시트만 오름차순 정렬
  const monthSheets = wb.SheetNames
    .filter((n: string) => /^\d{4}-\d{2}$/.test(n))
    .sort() as string[];

  const chartRows: MsChartRow[] = [];
  let   tableRows: MsTableRow[] = [];
  let   latestMonth              = "";
  let   colHeaders: string[]     = ["시간(h)", "시스템", "카테고리", "주제", "세부내용", "시작일", "종료일", "상태"];

  for (const sheetName of monthSheets) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];

    // row 0 에서 실제 컬럼명 읽기 (최신 시트 기준)
    if (sheetName === monthSheets[monthSheets.length - 1] && rows.length > 0) {
      const hdr = rows[0] as unknown[];
      const h   = [4, 6, 7, 8, 9, 10, 11, 12].map((i) => String(hdr[i] ?? "").trim());
      if (h.some((v) => v !== "")) {
        colHeaders = h.map((v, i) => v || colHeaders[i]);
      }
    }

    // A열 = "SKB GMP" 인 첫 행 찾기
    let gmpRowIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String((rows[i] as unknown[])[0] ?? "").trim() === "SKB GMP") {
        gmpRowIdx = i;
        break;
      }
    }
    if (gmpRowIdx < 0) {
      logger.warn(`[BIO Report MS] ${sheetName}: SKB GMP 행 없음`);
      continue;
    }

    const gmpRow = rows[gmpRowIdx] as unknown[];
    chartRows.push({
      month:     sheetName,
      possible:  Number(gmpRow[1]) || 0,
      used:      Number(gmpRow[2]) || 0,
      remaining: Number(gmpRow[3]) || 0,
    });
    logger.info(`[BIO Report MS] ${sheetName} SKB GMP — B:${gmpRow[1]}, C:${gmpRow[2]}, D:${gmpRow[3]}`);

    // 최신 월: SKB GMP 그룹 하위 행 수집 (E열 값 있는 행만)
    if (sheetName === monthSheets[monthSheets.length - 1]) {
      latestMonth = sheetName;
      for (let i = gmpRowIdx + 1; i < rows.length; i++) {
        const row  = rows[i] as unknown[];
        const aVal = String(row[0] ?? "").trim();
        // 다른 그룹 시작 시 종료
        if (aVal !== "" && aVal !== "SKB GMP") break;
        // E열(시간) 비어 있으면 건너뜀
        if (String(row[4] ?? "").trim() === "") continue;
        tableRows.push({
          hours:     String(row[4]  ?? ""),
          system:    String(row[6]  ?? ""),
          category:  String(row[7]  ?? ""),
          subject:   String(row[8]  ?? ""),
          detail:    String(row[9]  ?? ""),
          startDate: excelDateToStr(row[10]),
          endDate:   excelDateToStr(row[11]),
          status:    String(row[12] ?? ""),
        });
      }
      logger.info(`[BIO Report MS] ${sheetName} 테이블 행: ${tableRows.length}개`);
    }
  }

  return { chartRows, tableRows, latestMonth, colHeaders };
}

// ── MS 막대 차트 렌더링 ──────────────────────────────────────────────────────

/**
 * 3개월 SKB GMP MS 현황을 그룹 막대 차트 PNG 로 렌더링합니다.
 * (가능 MS / 사용 MS / 잔여 MS)
 */
async function renderMsBarChartToPng(chartRows: MsChartRow[], outputPng: string): Promise<void> {
  const labels    = chartRows.map((r) => r.month.replace("-", "."));  // "2026.03"
  const possible  = chartRows.map((r) => r.possible);
  const used      = chartRows.map((r) => r.used);
  const remaining = chartRows.map((r) => r.remaining);

  const chartJs   = loadChartJsScript();
  const scriptTag = chartJs
    ? `<script>${chartJs}</script>`
    : `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>`;

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#fff; font-family:"Malgun Gothic",Arial,sans-serif; }
  #wrap { width:580px; height:340px; }
</style>
</head>
<body>
<div id="wrap">
  <canvas id="chart" width="580" height="340"></canvas>
</div>
${scriptTag}
<script>
(function() {
  var ctx = document.getElementById('chart').getContext('2d');
  if (!window.Chart) { ctx.fillStyle='#ef4444'; ctx.font='12px Arial'; ctx.fillText('Chart.js 로드 실패',10,20); return; }

  /* 막대 위 데이터 레이블 플러그인 */
  var barLabelPlugin = {
    id: 'barLabels',
    afterDatasetsDraw: function(chart) {
      var c = chart.ctx;
      chart.data.datasets.forEach(function(ds, di) {
        var meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        meta.data.forEach(function(bar, bi) {
          var val = ds.data[bi];
          if (val === null || val === undefined || val === 0) return;
          c.save();
          c.fillStyle = '#1f2937';
          c.font = 'bold 10px Arial';
          c.textAlign = 'center';
          c.textBaseline = 'bottom';
          c.fillText(String(val), bar.x, bar.y - 2);
          c.restore();
        });
      });
    }
  };
  Chart.register(barLabelPlugin);

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(labels)},
      datasets: [
        { label: 'GMP 가능 MS', data: ${JSON.stringify(possible)},  backgroundColor: '#4472C4', borderRadius: 3, borderSkipped: false },
        { label: 'GMP 사용 MS', data: ${JSON.stringify(used)},      backgroundColor: '#A9D18E', borderRadius: 3, borderSkipped: false },
        { label: 'GMP 잔여 MS', data: ${JSON.stringify(remaining)}, backgroundColor: '#ED7D31', borderRadius: 3, borderSkipped: false },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      layout: { padding: { top: 18 } },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 16, usePointStyle: true } },
        tooltip: { enabled: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 12 }, color: '#374151' } },
        y: {
          beginAtZero: true,
          grid: { color: '#f0f4f8' },
          ticks: { font: { size: 11 }, color: '#6b7280' },
          title: { display: true, text: '(MD)', font: { size: 10 }, color: '#9ca3af' },
        },
      },
    },
  });
})();
</script>
</body>
</html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 580, height: 320 });
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(400);
    const loaded = await page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>).Chart !== "undefined"
    );
    logger.info(`[BIO Report MS] Chart.js 로드: ${loaded ? "성공" : "실패"}`);
    await page.locator("#wrap").screenshot({ path: outputPng, type: "png" });
    logger.info(`[BIO Report MS] Bar chart PNG: ${outputPng} (${fs.statSync(outputPng).size.toLocaleString()} bytes)`);
  } finally {
    await browser.close();
  }
}

// ── PDF HTML 빌드 ─────────────────────────────────────────────────────────────

function buildBioReportHtml(
  titleDate:         string,
  msData?:           MsTimesheetData | null,
  msBarChartBase64?: string | null,
): string {
  const today = new Date().toLocaleDateString("ko-KR", {
    year: "numeric", month: "long", day: "numeric",
  });

  // ── Page 2 (MS) HTML ──────────────────────────────────────────────────────
  const msPageHtml = msData ? (() => {
    const latestLabel = msData.latestMonth ? formatMonthKorean(msData.latestMonth) : titleDate;

    const msChartSummaryTable = msData.chartRows.length > 0 ? `
      <div class="ms-summary-wrap">
        <table class="ms-summary-table">
          <thead>
            <tr>
              <th>월</th>
              <th>GMP 가능 MS</th>
              <th>GMP 사용 MS</th>
              <th>GMP 잔여 MS</th>
            </tr>
          </thead>
          <tbody>
            ${msData.chartRows.map((r) => `<tr>
              <td>${escHtml(formatMonthKorean(r.month))}</td>
              <td>${r.possible}</td>
              <td>${r.used}</td>
              <td>${r.remaining}</td>
            </tr>`).join("\n")}
          </tbody>
        </table>
      </div>` : "";

    const chartSection = `
    <div class="ms-section">
      <div class="ms-section-title">1) 시스템 별 MS 현황</div>
      <div class="ms-chart-subtitle">Bio연구본부 Quality System Managed Service 현황</div>
      <div class="ms-chart-wrap">
        ${msBarChartBase64
          ? `<img src="data:image/png;base64,${msBarChartBase64}" alt="MS 현황 막대 차트" />`
          : `<div class="ms-no-data">차트 생성 실패</div>`}
      </div>
      ${msChartSummaryTable}
    </div>`;

    const [hE, hG, hH, hI, hJ, hK, hL, hM] = msData.colHeaders;
    const tableHeaderRow = `<tr>
      <th>${escHtml(hG)}</th>
      <th>${escHtml(hH)}</th>
      <th style="min-width:80px">${escHtml(hI)}</th>
      <th>${escHtml(hJ)}</th>
      <th style="white-space:nowrap">${escHtml(hK)}</th>
      <th style="white-space:nowrap">${escHtml(hL)}</th>
      <th style="white-space:nowrap">${escHtml(hM)}</th>
      <th style="white-space:nowrap">${escHtml(hE)}</th>
    </tr>`;

    const tableBodyRows = msData.tableRows.map((r) => `<tr>
      <td class="td-center">${escHtml(r.system)}</td>
      <td class="td-center">${escHtml(r.category)}</td>
      <td>${escHtml(r.subject)}</td>
      <td class="td-detail">${escHtml(r.detail)}</td>
      <td class="td-nowrap">${escHtml(r.startDate)}</td>
      <td class="td-nowrap">${escHtml(r.endDate)}</td>
      <td class="td-nowrap">${escHtml(r.status)}</td>
      <td class="td-nowrap td-num">${escHtml(r.hours)}</td>
    </tr>`).join("\n");

    const tableSection = `
    <div class="ms-section">
      <div class="ms-table-title">${escHtml(latestLabel)} Managed Service 주요 현황</div>
      ${msData.tableRows.length > 0
        ? `<table class="ms-table">
            <thead>${tableHeaderRow}</thead>
            <tbody>${tableBodyRows}</tbody>
           </table>`
        : `<div class="ms-no-data">해당 월 SKB GMP 세부 데이터가 없습니다.</div>`}
    </div>`;

    return `
  <!-- ── MS 진행 현황 페이지 ── -->
  <div class="page">
    <div class="page-header">
      <h2>2. Managed Service 진행 현황</h2>
      <span class="pg">${titleDate}</span>
    </div>
    ${chartSection}
    ${tableSection}
    <div class="footer">
      <span>SK Bioscience Bio연구본부 — 시스템 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>`;
  })() : "";

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:"Malgun Gothic","Apple SD Gothic Neo",Arial,sans-serif; color:#222; background:#fff; }

    .cover {
      height:100vh; display:flex; flex-direction:column;
      align-items:center; justify-content:center;
      background:linear-gradient(160deg,#0f2d55 0%,#1a4a8a 100%);
      color:#fff; text-align:center; padding:40px;
    }
    .cover-badge { font-size:11px; letter-spacing:6px; text-transform:uppercase; opacity:.5; margin-bottom:48px; }
    .cover-main  { font-size:30px; font-weight:700; line-height:1.55; }
    .cover-rule  { width:60px; height:3px; background:rgba(255,255,255,.3); margin:32px auto; }
    .cover-date  { font-size:13px; opacity:.45; }

    .page { break-before:page; padding:36px 44px 28px; }
    .page-header {
      display:flex; align-items:flex-end; justify-content:space-between;
      border-bottom:2.5px solid #0f2d55; padding-bottom:10px; margin-bottom:20px;
    }
    .page-header h2  { font-size:18px; font-weight:700; color:#0f2d55; }
    .page-header .pg { font-size:11px; color:#9ca3af; }
    .section-desc { font-size:11px; color:#6b7280; margin-bottom:16px; line-height:1.6; }
    .caption { font-size:10px; color:#9ca3af; text-align:center; margin-top:8px; }
    .footer {
      margin-top:24px; padding-top:12px; border-top:1px solid #e5e7eb;
      font-size:10px; color:#d1d5db; display:flex; justify-content:space-between;
    }
    .img-full { width:100%; height:auto; display:block; border:1px solid #e5e7eb; border-radius:4px; }
    .img-half { width:100%; height:auto; display:block; border:1px solid #e5e7eb; border-radius:4px; }
    .two-col  { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px; }
    .img-block { margin-bottom:16px; }
    .img-title { font-size:12px; font-weight:700; color:#0f2d55; margin-bottom:6px; }
    .placeholder-box {
      border:2px dashed #cbd5e1; border-radius:8px; padding:40px;
      text-align:center; color:#9ca3af; font-size:12px;
      background:#f8fafc; margin-bottom:16px;
    }
    .headline {
      font-size:11px; line-height:1.8; color:#1f2937;
      background:#f0f4f8; border-left:4px solid #0f2d55;
      padding:10px 14px; margin-bottom:14px; border-radius:0 4px 4px 0;
    }
    .headline strong { color:#0f2d55; font-weight:700; }

    /* MS Timesheet CSS */
    .ms-section { margin-bottom: 22px; }
    .ms-section-title { font-size:13px; font-weight:700; color:#0f2d55; margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid #cbd5e1; }
    .ms-chart-subtitle { font-size:10px; color:#6b7280; margin-bottom:10px; }
    .ms-chart-wrap { display:flex; justify-content:center; align-items:center; background:#fafbfc; border:1px solid #e5e7eb; border-radius:6px; padding:12px 8px 8px; }
    .ms-chart-wrap img { max-width:100%; height:auto; display:block; }
    .ms-table-title { font-size:12px; font-weight:700; color:#0f2d55; margin-bottom:8px; }
    .ms-table { width:100%; border-collapse:collapse; font-size:9px; }
    .ms-table th { background:#0f2d55; color:#fff; font-weight:600; padding:5px 6px; text-align:center; white-space:nowrap; border:1px solid #1a4a8a; }
    .ms-table td { padding:4px 6px; border:1px solid #e5e7eb; vertical-align:middle; color:#374151; word-break:break-all; }
    .ms-table tr:nth-child(even) td { background:#f8fafc; }
    .ms-table .td-center { text-align:center; }
    .ms-table .td-num    { text-align:right; }
    .ms-table .td-nowrap { white-space:nowrap; text-align:center; }
    .ms-table .td-detail { word-break:break-word; }
    .ms-no-data { font-size:11px; color:#9ca3af; text-align:center; padding:20px; }
    .ms-summary-wrap { margin-top:8px; }
    .ms-summary-table { margin:0 auto; border-collapse:collapse; font-size:10px; }
    .ms-summary-table th { background:#4472C4; color:#fff; font-weight:600; padding:5px 18px; text-align:center; border:1px solid #3563b0; white-space:nowrap; }
    .ms-summary-table td { padding:4px 18px; border:1px solid #e5e7eb; text-align:center; color:#374151; white-space:nowrap; }
    .ms-summary-table tr:nth-child(even) td { background:#f8fafc; }
  </style>
</head>
<body>
  <!-- ── 표지 ── -->
  <div class="cover">
    <div class="cover-badge">SK Bioscience</div>
    <div class="cover-main">${titleDate}<br>Bio연구본부 시스템 운영 현황</div>
    <div class="cover-rule"></div>
    <div class="cover-date">작성일: ${today}</div>
  </div>

  <!-- ── Page 1: Veeva 시스템 사용현황 (플레이스홀더) ── -->
  <div class="page">
    <div class="page-header">
      <h2>1. Veeva 시스템 사용현황</h2>
      <span class="pg">${titleDate}</span>
    </div>
    <div class="headline">
      ${titleDate} Bio연구본부 Veeva Quality System에 대한 운영 현황입니다.
      <strong>(헤드메시지 내용은 추후 업데이트 예정입니다.)</strong>
    </div>
    <div class="placeholder-box">
      차트 및 데이터 준비 중입니다. 추후 업데이트 예정입니다.
    </div>
    <div class="footer">
      <span>SK Bioscience Bio연구본부 — 시스템 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>

  ${msPageHtml}
</body>
</html>`;
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

export interface BioReportResult {
  filePath:  string;
  filename:  string;
  fileSize:  number;
  pageCount: number;
}

export async function generateBioReport(jobId: string): Promise<BioReportResult> {
  const uploadDir  = process.env.UPLOAD_DIR ?? "uploads";
  const uploadPath = path.resolve(uploadDir, jobId, "uploads");

  logger.info(`[BIO Report] 보고서 생성 요청 — jobId: ${jobId}`);
  logger.info(`[BIO Report] 업로드 경로: ${uploadPath}`);

  // MS Timesheet — DB 에서 최신 파일 조회
  let msData:           MsTimesheetData | null = null;
  let msBarChartBase64: string | null          = null;

  try {
    const tsRows = await query<{ stored_path: string }>(
      `SELECT stored_path FROM uploaded_files
       WHERE original_name = 'SKB_Quallity_MS_Timesheet.xlsx'
       ORDER BY created_at DESC LIMIT 1`,
      []
    );

    if (tsRows.length && fs.existsSync(tsRows[0].stored_path)) {
      const tsPath = tsRows[0].stored_path;
      logger.info(`[BIO Report] Timesheet 파일: ${tsPath}`);

      msData = readMsTimesheetData(tsPath);

      if (msData.chartRows.length > 0) {
        const msChartPng = path.join(uploadPath, `ms_barchart_${Date.now()}.png`);
        fs.mkdirSync(uploadPath, { recursive: true });
        await renderMsBarChartToPng(msData.chartRows, msChartPng);
        if (fs.existsSync(msChartPng)) {
          msBarChartBase64 = fs.readFileSync(msChartPng).toString("base64");
        }
      } else {
        logger.warn("[BIO Report] Timesheet 에서 YYYY-MM 시트 데이터 없음 — MS 페이지 스킵");
        msData = null;
      }
    } else {
      logger.info("[BIO Report] Timesheet 파일 없음 — MS 페이지 생략");
    }
  } catch (e) {
    logger.error(`[BIO Report] Timesheet 처리 실패 (무시): ${(e as Error).message}`);
    msData = null;
  }

  // HTML → PDF 생성
  const { year, month } = getLastMonth();
  const titleDate  = `${year}년 ${String(month).padStart(2, "0")}월`;
  const html       = buildBioReportHtml(titleDate, msData, msBarChartBase64);
  const outputDir  = path.resolve(process.env.OUTPUT_DIR ?? "outputs");
  fs.mkdirSync(outputDir, { recursive: true });

  const mm       = String(month).padStart(2, "0");
  const filename = `${year}.${mm} Bio연구본부 시스템 운영 현황 Report.pdf`;
  const outputPath = path.join(outputDir, filename);

  logger.info(`[BIO Report] PDF 생성: ${outputPath}`);

  const result = await PdfGenerator.generate(html, outputPath, {
    format: "A4",
    margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
  });

  logger.info(`[BIO Report] 완료 — ${result.pageCount}p, ${result.fileSize.toLocaleString()} bytes`);

  return {
    filePath:  result.filePath,
    filename,
    fileSize:  result.fileSize,
    pageCount: result.pageCount,
  };
}
