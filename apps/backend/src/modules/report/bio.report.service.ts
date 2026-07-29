/**
 * BIO (Bio연구본부) 보고서 생성 서비스
 *
 * 페이지 구성:
 *  - 표지: "Bio연구본부 시스템 운영 현황"
 *  - Page 1: "1. Veeva 시스템 사용현황" — 데이터 수집(BIO_Activity/PerfStats/DocType) 기반 5개 차트 그리드 + 인사이트
 *  - Page 2 (선택): "2. Managed Service 진행 현황"
 *                   MS Timesheet (DB 에서 최신 파일 조회)
 */

import fs   from "fs";
import path from "path";

import * as XLSX    from "xlsx";
import { chromium } from "playwright";

import { logger }       from "../../utils/logger";
import { AppError }     from "../../utils/errors";
import { PdfGenerator } from "../../engines/report/PdfGenerator";
import { query }        from "../../config/db";
import { renderGcpBarToPng, renderGcpGroupedBarToPng, parseGcpMonthGroups } from "./dev.report.service";

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
export interface MsChartRow {
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

export interface MsTimesheetData {
  chartRows:   MsChartRow[];
  tableRows:   MsTableRow[];
  latestMonth: string;    // e.g. "2026-03"
  colHeaders:  string[];  // E,G,H,I,J,K,L,M 열 헤더 (row 0 에서 읽음)
}

// ── 헬퍼 함수 ─────────────────────────────────────────────────────────────────

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

// ── Veeva RD 차트 제목 ────────────────────────────────────────────────────────

const VEEVA_RD_CHART_TITLES = [
  "업무 활용 현황",
  "문서 관리 현황",
  "생성 문서 구분",
  "사용자 현황",
  "일일 사용 현황",
] as const;

// ── 차트 이미지 타입 ──────────────────────────────────────────────────────────

type ChartImg = { base64: string; mime: "image/png" };

/** Bio Veeva 헤드라인용 통계 (데이터 수집 결과에서 산출) */
interface BioVeevaStats {
  totalUsers:    number;  // #1: chart4 사용자 현황 오른쪽 막대 상단
  dailyAvgLogin: number;  // #2: chart5 일일 사용 현황 오른쪽 막대 상단
  taskTotal:     number;  // #3: chart1 업무 활용 현황 10개 바 합산
  taskTop:       number;  // #4: chart1 업무 활용 현황 가장 위 막대 값
  burnedMs:      number;  // #5: SKB GMP Burned MS (C열)
}

// ── MS Timesheet 헬퍼 ────────────────────────────────────────────────────────

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
 *  - A열 = "SKB R&D" 인 첫 행 → B(가능)/C(사용)/D(잔여) 값 수집 (막대 차트용)
 *  - 최신 월 시트의 SKB R&D 그룹 하위 행 → E/G/H/I/J/K/L/M 수집 (표 용)
 */
export function readMsTimesheetData(xlsxPath: string): MsTimesheetData {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.readFile(xlsxPath);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/ecma-376|encrypt|password/i.test(msg)) {
      throw new AppError(
        400,
        "Timesheet 파일이 암호화(비밀번호 보호)되어 있습니다. " +
        "Excel에서 비밀번호를 제거한 후 다시 업로드해 주세요."
      );
    }
    throw e;
  }

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

    // A열 = "SKB R&D" 인 첫 행 찾기
    let gmpRowIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String((rows[i] as unknown[])[0] ?? "").trim() === "SKB R&D") {
        gmpRowIdx = i;
        break;
      }
    }
    if (gmpRowIdx < 0) {
      logger.warn(`[BIO Report MS] ${sheetName}: SKB R&D 행 없음`);
      continue;
    }

    const gmpRow = rows[gmpRowIdx] as unknown[];
    chartRows.push({
      month:     sheetName,
      possible:  Number(gmpRow[1]) || 0,
      used:      Number(gmpRow[2]) || 0,
      remaining: Number(gmpRow[3]) || 0,
    });
    logger.info(`[BIO Report MS] ${sheetName} SKB R&D — B:${gmpRow[1]}, C:${gmpRow[2]}, D:${gmpRow[3]}`);

    // 최신 월: SKB R&D 작업 행 수집
    // - row 0(헤더) 제외 후 전체 스캔
    // - inSKBRD 플래그: A = "SKB R&D" 등장 시 활성, 다른 그룹명 등장 시 종료
    // - A = "" 하위 행도 inSKBRD 구간이면 포함 (그룹 구조·플랫 구조 모두 대응)
    // - G열(시스템) 또는 I열(주제) 값이 있는 행만 작업 행으로 판단 (그룹 집계 행 제외)
    if (sheetName === monthSheets[monthSheets.length - 1]) {
      latestMonth = sheetName;
      let inSKBRD = false;
      for (let i = 1; i < rows.length; i++) {   // i=0 는 헤더 행
        const row  = rows[i] as unknown[];
        const aVal = String(row[0] ?? "").trim();

        if (aVal === "SKB R&D") {
          inSKBRD = true;
        } else if (aVal !== "") {
          if (inSKBRD) break;   // 다른 그룹 시작 → SKB R&D 구간 종료
          continue;
        }
        // aVal === "" : 빈 A 열 하위 행 — inSKBRD 가 true 면 포함

        if (!inSKBRD) continue;

        // G열(시스템) 또는 I열(주제) 값 있는 행 = 작업 내역 행
        const hasContent =
          String(row[6] ?? "").trim() !== "" ||
          String(row[8] ?? "").trim() !== "";
        if (!hasContent) continue;

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
      logger.info(`[BIO Report MS] ${sheetName} SKB R&D 테이블 행: ${tableRows.length}개`);
    }
  }

  return { chartRows, tableRows, latestMonth, colHeaders };
}

/**
 * SKB_Quallity_MS_Timesheet.xlsx 최신 YYYY-MM 시트에서
 * SKB GMP 그룹의 Burned MS (C열 = 사용 MS) 값을 반환합니다.
 * Managed Service 진행 현황 헤드라인 #5 에 사용합니다.
 */
function readBioGmpBurnedMs(xlsxPath: string): number {
  try {
    const wb = XLSX.readFile(xlsxPath);
    const monthSheets = wb.SheetNames
      .filter((n: string) => /^\d{4}-\d{2}$/.test(n))
      .sort() as string[];
    if (monthSheets.length === 0) { logger.warn("[BIO Report MS] readBioGmpBurnedMs: YYYY-MM 시트 없음"); return 0; }
    const latestSheet = monthSheets[monthSheets.length - 1];
    const ws = wb.Sheets[latestSheet];
    if (!ws) return 0;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];

    // 진단용: A열에 있는 모든 비어 있지 않은 값 로그
    const aColSample = rows.slice(0, 20).map(r => String((r as unknown[])[0] ?? "").trim()).filter(v => v !== "");
    logger.info(`[BIO Report MS] ${latestSheet} A열 샘플: ${JSON.stringify(aColSample)}`);

    for (let i = 0; i < rows.length; i++) {
      // 정확한 일치 우선, 공백·대소문자 차이 허용
      const aVal = String((rows[i] as unknown[])[0] ?? "").trim();
      if (aVal.toUpperCase() === "SKB GMP") {
        // C열 (index 2): XLSX 수식 결과값 우선, 없으면 raw 값
        const cell   = ws[XLSX.utils.encode_cell({ r: i, c: 2 })];
        const burned = cell ? (Number(cell.v) || 0) : 0;
        logger.info(`[BIO Report MS] ${latestSheet} row[${i}] SKB GMP C열 raw="${cell?.v}" → ${burned}`);
        return burned;
      }
    }
    logger.warn(`[BIO Report MS] ${latestSheet}: "SKB GMP" 행 없음 (burnedMs=0). A열값: ${JSON.stringify(aColSample)}`);
    return 0;
  } catch (e) {
    logger.error(`[BIO Report MS] readBioGmpBurnedMs 실패: ${(e as Error).message}`);
    return 0;
  }
}

// ── MS 막대 차트 렌더링 ──────────────────────────────────────────────────────

/**
 * 3개월 SKB R&D MS 현황을 그룹 막대 차트 PNG 로 렌더링합니다.
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
        { label: 'R&D 가능 MS', data: ${JSON.stringify(possible)},  backgroundColor: '#4472C4', borderRadius: 3, borderSkipped: false },
        { label: 'R&D 사용 MS', data: ${JSON.stringify(used)},      backgroundColor: '#A9D18E', borderRadius: 3, borderSkipped: false },
        { label: 'R&D 잔여 MS', data: ${JSON.stringify(remaining)}, backgroundColor: '#ED7D31', borderRadius: 3, borderSkipped: false },
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

// ── Veeva 데이터 수집(화면 스크래핑 JSON) 기반 차트 ─────────────────────────────
//   BIO_Activity.json / BIO_PerfStats.json / BIO_DocType.json ({headers, rows})를 읽어
//   #1 업무활용 · #2 문서관리 · #3 생성문서구분 · #4 사용자 · #5 일일사용 막대를 생성한다.

const BIO_MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export interface ScrapedTable { headers: string[]; rows: string[][]; }

export function readScrapedTable(p: string): ScrapedTable | null {
  try {
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<ScrapedTable>;
    return { headers: j.headers ?? [], rows: j.rows ?? [] };
  } catch (e) { logger.warn(`[BIO Report] 스크래핑 JSON 파싱 실패 (${path.basename(p)}): ${(e as Error).message}`); return null; }
}

const bioToNum = (s: unknown): number => {
  const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};
const bioColIdx = (headers: string[], re: RegExp): number => headers.findIndex((h) => re.test(h));

/** 월 라벨(2026 Mar / Mar 2026 / 2026-03) → "YYYY-MM" */
function parseBioMonthLabel(s: string): string | null {
  const t   = String(s ?? "").trim();
  const pad = (n: number) => String(n).padStart(2, "0");
  let m = t.match(/(\d{4})\s+([A-Za-z]{3,})/);
  if (m) { const mo = BIO_MONTH_ABBR[m[2].slice(0, 3).toLowerCase()]; if (mo) return `${m[1]}-${pad(mo)}`; }
  m = t.match(/([A-Za-z]{3,})\s+(\d{4})/);
  if (m) { const mo = BIO_MONTH_ABBR[m[1].slice(0, 3).toLowerCase()]; if (mo) return `${m[2]}-${pad(mo)}`; }
  m = t.match(/\b(\d{4})[-/.](\d{1,2})\b/);
  if (m) { const mo = parseInt(m[2], 10); if (mo >= 1 && mo <= 12) return `${m[1]}-${pad(mo)}`; }
  return null;
}

/** "<prefix>: <label> (N)" 그룹 행 분포 → {label, value}[] (paren 우선, 없으면 count 컬럼/첫 숫자) */
export function parseBioGroupDistribution(
  table: ScrapedTable, labelPrefixRe: RegExp, countHeaderRe?: RegExp,
): { label: string; value: number }[] {
  const ci = countHeaderRe ? bioColIdx(table.headers, countHeaderRe) : -1;
  const out: { label: string; value: number }[] = [];
  for (const r of table.rows) {
    let label: string | null = null, parenVal = NaN, labelIdx = -1;
    for (let i = 0; i < r.length; i++) {
      const mm = String(r[i] ?? "").match(labelPrefixRe);
      if (mm) { label = mm[1].trim(); parenVal = mm[2] ? Number(mm[2].replace(/,/g, "")) : NaN; labelIdx = i; break; }
    }
    if (label == null || /^all\b/i.test(label)) continue;   // 총계행 제외
    let val = parenVal;
    if (!Number.isFinite(val) && ci >= 0) val = bioToNum(r[ci]);
    if (!Number.isFinite(val)) {
      for (let i = 0; i < r.length; i++) { if (i === labelIdx) continue; const n = bioToNum(r[i]); if (Number.isFinite(n)) { val = n; break; } }
    }
    if (!Number.isFinite(val)) val = 0;
    out.push({ label, value: val });
  }
  return out;
}

interface BioVeevaCharts {
  activity:    string | null;  // #1 업무 활용
  docCount:    string | null;  // #2 문서 관리 (월 × Doc Count)
  docType:     string | null;  // #3 생성 문서 구분
  activeUser:  string | null;  // #4 사용자 (월 × Active User)
  uniqueLogin: string | null;  // #5 일일 사용 (월 × Unique Login)
  msgs: { activity: string; docCount: string; docType: string; user: string; login: string };
  insight: string[];
  stats: { totalUsers: number; dailyAvgLogin: number; taskTotal: number; taskTop: number };
}

async function buildBioVeevaCharts(uploadPath: string): Promise<BioVeevaCharts | null> {
  const actT     = readScrapedTable(path.join(uploadPath, "BIO_Activity.json"));
  const docT     = readScrapedTable(path.join(uploadPath, "BIO_DocType.json"));
  const perfXlsx = path.join(uploadPath, "BIO_PerfStats.xlsx");
  const hasPerf  = fs.existsSync(perfXlsx);
  if (!actT && !hasPerf && !docT) return null;

  const renderBar = async (labels: string[], vals: number[], color: string, name: string): Promise<string | null> => {
    if (!labels.length || vals.every((v) => v === 0)) return null;
    try {
      const p = path.join(uploadPath, `bio_bar_${name}_${Date.now()}.png`);
      await renderGcpBarToPng(labels, vals, color, p);
      return fs.readFileSync(p).toString("base64");
    } catch (e) { logger.warn(`[BIO Report] bar(${name}) 실패: ${(e as Error).message}`); return null; }
  };

  // #1 업무 활용 — Name: 카테고리 × Activity count
  const actDist = actT ? parseBioGroupDistribution(actT, /Name:\s*(.+?)\s*(?:\(([\d,]+)\))?\s*$/i, /activity\s*count|count/i) : [];
  const taskTotal = actDist.reduce((s, d) => s + d.value, 0);
  const taskTop   = actDist.reduce((m, d) => Math.max(m, d.value), 0);
  const activity  = await renderBar(actDist.map((d) => d.label), actDist.map((d) => d.value), "#4472C4", "activity");

  // #3 생성 문서 구분 — Type: 텍스트 × (xxx)
  const docDist = docT ? parseBioGroupDistribution(docT, /Type:\s*(.+?)\s*\(([\d,]+)\)/i) : [];
  const docType = await renderBar(docDist.map((d) => d.label), docDist.map((d) => d.value), "#ED7D31", "doctype");

  // #2/#4/#5 — PerfStats(Excel Formatted) 월별 평균: B(1)=Active User, D(3)=Unique Login, E(4)=Doc Count
  let docCount: string | null = null, activeUser: string | null = null, uniqueLogin: string | null = null;
  let docV: number[] = [], userV: number[] = [], loginV: number[] = [], perfLabels: string[] = [];
  if (hasPerf) {
    const docM   = parseGcpMonthGroups(perfXlsx, 4);  // E Doc Count (월평균)
    const userM  = parseGcpMonthGroups(perfXlsx, 1);  // B Active User Count (월평균)
    const loginM = parseGcpMonthGroups(perfXlsx, 3);  // D Unique Login Count (월평균)
    const monthsSet = new Set<string>([...Object.keys(docM), ...Object.keys(userM), ...Object.keys(loginM)]);
    const months = [...monthsSet].sort().slice(-3);
    perfLabels = months.map((ym) => `${parseInt(ym.slice(5, 7), 10)}월`);
    docV   = months.map((ym) => Math.round(docM[ym]   ?? 0));
    userV  = months.map((ym) => Math.round(userM[ym]  ?? 0));
    loginV = months.map((ym) => Math.round(loginM[ym] ?? 0));
    logger.info(`[BIO Report] PerfStats(xlsx) 파싱 — 월:${months.join(",")} doc:${docV} user:${userV} login:${loginV}`);
    docCount    = await renderBar(perfLabels, docV,   "#5B9BD5", "doc");
    activeUser  = await renderBar(perfLabels, userV,  "#70AD47", "user");
    uniqueLogin = await renderBar(perfLabels, loginV, "#FFC000", "login");
  }

  const last = (a: number[]) => a[a.length - 1] ?? 0;
  const lm   = perfLabels[perfLabels.length - 1] ?? "";
  const msgs = {
    activity: `최근 3개월 업무 활동 총 <strong>${taskTotal.toLocaleString()}</strong>건`,
    docCount: `${lm} 약 <strong>${last(docV).toLocaleString()}</strong>건 문서 관리 중`,
    docType:  `생성 문서 총 <strong>${docDist.reduce((s, d) => s + d.value, 0).toLocaleString()}</strong>건`,
    user:     `${lm} 등록 사용자 약 <strong>${last(userV).toLocaleString()}</strong>명`,
    login:    `${lm} 일평균 접속 약 <strong>${last(loginV).toLocaleString()}</strong>명`,
  };

  const insight = buildBioInsightLines({ perfLabels, docV, userV, loginV, actDist, docDist });

  logger.info(`[BIO Report] Veeva 차트 — activity:${actDist.length}종 doctype:${docDist.length}종 perf월:${perfLabels.join(",")}`);
  return {
    activity, docCount, docType, activeUser, uniqueLogin, msgs, insight,
    stats: { totalUsers: last(userV), dailyAvgLogin: last(loginV), taskTotal, taskTop },
  };
}

/** BIO 데이터 인사이트 — 연결어미로 잇고 마지막만 종결형 (GCP 인사이트와 동일 컨셉) */
export function buildBioInsightLines(a: {
  perfLabels: string[]; docV: number[]; userV: number[]; loginV: number[];
  actDist: { label: string; value: number }[]; docDist: { label: string; value: number }[];
}): string[] {
  const { perfLabels, docV, userV, loginV, actDist, docDist } = a;
  const fmt   = (n: number) => Math.round(n).toLocaleString();
  const first = (x: number[]) => x[0] ?? 0;
  const last  = (x: number[]) => x[x.length - 1] ?? 0;
  const sum   = (x: number[]) => x.reduce((s, v) => s + v, 0);
  const tword = (x: number[]) => last(x) > first(x) ? "증가" : last(x) < first(x) ? "감소" : "유지";
  const range = perfLabels.length ? `${perfLabels[0]}~${perfLabels[perfLabels.length - 1]}` : "";
  const lines: string[] = [];

  const actSum = actDist.reduce((s, d) => s + d.value, 0);
  if (actSum > 0) {
    const top = [...actDist].sort((x, y) => y.value - x.value)[0];
    lines.push(`최근 3개월(${range}) Bio연구본부 Veeva Quality System의 업무 활동은 총 ${fmt(actSum)}건으로 ${top ? `${top.label}(${fmt(top.value)}건)에 가장 집중되었으며,` : ""}`);
  }
  if (docV.some((v) => v > 0)) {
    lines.push(`관리 문서 수는 월평균 ${fmt(first(docV))}→${fmt(last(docV))}건으로 ${tword(docV)} 흐름을 보였고,`);
  }
  const dTop = [...docDist].sort((x, y) => y.value - x.value)[0];
  if (dTop) {
    lines.push(`생성 문서는 총 ${fmt(sum(docDist.map((d) => d.value)))}건 중 ${dTop.label}(${fmt(dTop.value)}건)가 가장 많았으며,`);
  }
  if (userV.some((v) => v > 0) || loginV.some((v) => v > 0)) {
    lines.push(`활성 사용자는 약 ${fmt(last(userV))}명, 일일 평균 접속은 약 ${fmt(last(loginV))}명 수준을 유지했습니다.`);
  }

  if (lines.length) {
    const i = lines.length - 1;
    lines[i] = lines[i]
      .replace(/집중되었으며,$/, "집중되었습니다.")
      .replace(/보였고,$/, "보였습니다.")
      .replace(/많았으며,$/, "많았습니다.");
  }
  return lines;
}

function buildBioReportHtml(
  titleDate:         string,
  veeva:             BioVeevaCharts | null,
  msData?:           MsTimesheetData | null,
  msBarChartBase64?: string | null,
  veevaStats?:       BioVeevaStats,
): string {
  const today = new Date().toLocaleDateString("ko-KR", {
    year: "numeric", month: "long", day: "numeric",
  });

  // ── "xx월" 형식 추출 ────────────────────────────────────────────────────────
  const monthLabel = titleDate.replace(/^\d+년\s*/, "");  // "03월"

  // ── 셀 HTML 생성 헬퍼 ────────────────────────────────────────────────────────
  const makeCell = (no: number, title: string, img: ChartImg | null, msg?: string) => {
    const imgHtml = img
      ? `<div class="img-wrap"><img src="data:${img.mime};base64,${img.base64}" alt="${escHtml(title)}" /></div>`
      : `<div class="img-wrap no-chart-wrap"><span>차트 미업로드</span></div>`;
    return `<div class="usage-cell">
      <div class="cell-title"><span class="cell-no">${no}</span>${escHtml(title)}</div>
      ${msg ? `<div class="cell-msg">${msg}</div>` : ""}
      ${imgHtml}
    </div>`;
  };

  // ── 전체 헤드라인 메시지 (OCR 통계 반영) ────────────────────────────────────
  const st = veevaStats ?? { totalUsers: 0, dailyAvgLogin: 0, taskTotal: 0, taskTop: 0, burnedMs: 0 };
  const headlineHtml = `<div class="headline">
    <p>${titleDate} Bio연구본부 Veeva Quality System (eDMS)에 등록된 총 사용자 수는 <strong>${st.totalUsers}</strong> 명이며, 일 평균 <strong>${st.dailyAvgLogin}</strong> 명이 시스템에 접근하여 업무를 진행하였습니다.</p>
    <p>${monthLabel} 진행된 Managed Service는 <strong>${st.burnedMs}</strong> 건입니다.</p>
  </div>`;

  // ── Page 2 (MS) HTML ──────────────────────────────────────────────────────
  const msPageHtml = msData ? (() => {
    const latestLabel = msData.latestMonth ? formatMonthKorean(msData.latestMonth) : titleDate;

    const msChartSummaryTable = msData.chartRows.length > 0 ? `
      <div class="ms-summary-wrap">
        <table class="ms-summary-table">
          <thead>
            <tr>
              <th>월</th>
              <th>R&D 가능 MS</th>
              <th>R&D 사용 MS</th>
              <th>R&D 잔여 MS</th>
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
        : `<div class="ms-no-data">해당 월 SKB R&D 세부 데이터가 없습니다.</div>`}
    </div>`;

    return `
  <!-- ── MS 진행 현황 페이지 ── -->
  <div class="page ms-page">
    <table class="ms-repeat-table">
      <thead>
        <tr><td>
          <div class="page-header">
            <h2>2. Managed Service 진행 현황</h2>
            <span class="pg">${titleDate}</span>
          </div>
        </td></tr>
      </thead>
      <tbody>
        <tr><td>
          ${chartSection}
          ${tableSection}
        </td></tr>
      </tbody>
      <tfoot>
        <tr><td>
          <div class="footer-repeating">
            <span>SK Bioscience Bio연구본부 — 시스템 운영 현황</span>
            <span>${titleDate}</span>
          </div>
        </td></tr>
      </tfoot>
    </table>
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
    /* MS 진행 현황 페이지: 좌우 여백만 — 상/하는 thead/tfoot 가 담당 */
    .ms-page { padding:0 44px; }
    .page-header {
      display:flex; align-items:flex-end; justify-content:space-between;
      border-bottom:2.5px solid #0f2d55; padding-bottom:10px; margin-bottom:20px;
    }
    .page-header h2  { font-size:18px; font-weight:700; color:#0f2d55; }
    .page-header .pg { font-size:11px; color:#9ca3af; }
    /* MS 진행 현황: 페이지 오버플로우 시 page-header(thead) / footer(tfoot) 가 자동 반복 */
    .ms-repeat-table { width:100%; border-collapse:collapse; }
    .ms-repeat-table > thead { display: table-header-group; }
    .ms-repeat-table > tfoot { display: table-footer-group; }
    .ms-repeat-table > thead > tr > td { padding:36px 0 0 0; border:none; vertical-align:top; }
    .ms-repeat-table > tbody > tr > td { padding:0; border:none; vertical-align:top; }
    .ms-repeat-table > tfoot > tr > td { padding:24px 0 36px 0; border:none; vertical-align:bottom; }
    .footer-repeating {
      padding-top:12px; border-top:1px solid #e5e7eb;
      font-size:10px; color:#d1d5db; display:flex; justify-content:space-between;
    }
    .section-desc { font-size:11px; color:#6b7280; margin-bottom:16px; line-height:1.6; }
    .headline {
      font-size: 11px;
      line-height: 1.8;
      color: #1f2937;
      background: #f0f4f8;
      border-left: 4px solid #0f2d55;
      padding: 10px 14px;
      margin-bottom: 14px;
      border-radius: 0 4px 4px 0;
    }
    .headline strong { color: #0f2d55; font-weight: 700; }
    .caption { font-size:10px; color:#9ca3af; text-align:center; margin-top:8px; }
    .footer {
      margin-top:24px; padding-top:12px; border-top:1px solid #e5e7eb;
      font-size:10px; color:#d1d5db; display:flex; justify-content:space-between;
    }

    /* 공통 그리드 — 2열 고정 */
    .usage-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    /* 단일 페이지: 2열 × 3행 */
    .grid-3row { grid-template-rows: repeat(3, 255px); }
    /* 인사이트 포함 시 한 페이지에 맞도록 행 높이 축소 */
    .grid-3row-gcp { grid-template-rows: repeat(3, 210px); }

    /* 데이터 인사이트 (GCP Quality System 보고서와 동일) */
    .gcp-insight {
      margin-top: 10px; padding: 9px 14px; background: #f0fdf4;
      border-left: 4px solid #16a34a; border-radius: 0 4px 4px 0;
      font-size: 10.5px; line-height: 1.65; color: #374151;
    }
    .gcp-insight .gcp-insight-label {
      font-weight: 700; color: #15803d; font-size: 11px; margin-bottom: 4px;
    }
    .gcp-insight p { margin: 0 0 3px; }
    .gcp-insight p:last-child { margin-bottom: 0; }

    .usage-cell {
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      overflow: hidden;
      background: #fff;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    /* 차트 제목 — 번호 + 텍스트 (높이 고정) */
    .cell-title {
      flex-shrink: 0;
      height: 26px;
      padding: 0 10px;
      font-size: 10px;
      font-weight: 700;
      color: #1f2937;
      background: #f0f4f8;
      border-bottom: 1px solid #e5e7eb;
      letter-spacing: 0.2px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .cell-no {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #0f2d55;
      color: #fff;
      font-size: 9px;
      font-weight: 700;
      flex-shrink: 0;
    }
    /* 차트 셀 개별 메시지 */
    .cell-msg {
      flex-shrink: 0;
      padding: 4px 10px;
      font-size: 9px;
      color: #374151;
      background: #f8fafc;
      border-bottom: 1px solid #e5e7eb;
      line-height: 1.45;
    }
    .cell-msg strong { color: #0f2d55; font-weight: 700; }
    /* 이미지 래퍼 — 제목 아래 남은 공간을 flex로 채우고 이미지를 하단에 배치 */
    .img-wrap {
      flex: 1;
      min-height: 0;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      padding: 4px 4px 0 4px;
      overflow: hidden;
    }
    .img-wrap img {
      display: block;
      max-width: 100%;
      height: 100%;
      width: auto;
      object-fit: contain;
      object-position: bottom center;
    }
    .no-chart-wrap {
      align-items: center;
      background: #f8fafc;
    }
    .no-chart-wrap span {
      font-size: 10px;
      color: #9ca3af;
    }
    .placeholder-box {
      border:2px dashed #cbd5e1; border-radius:8px; padding:40px;
      text-align:center; color:#9ca3af; font-size:12px;
      background:#f8fafc; margin-bottom:16px;
    }

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

  <!-- ── Page 1: Veeva 시스템 사용현황 ── -->
  <div class="page">
    <div class="page-header">
      <h2>1. Veeva 시스템 사용현황</h2>
      <span class="pg">${titleDate}</span>
    </div>
    ${headlineHtml}
    ${(() => {
      if (!veeva) {
        return `<div class="placeholder-box">먼저 '데이터 수집'을 실행하면 차트가 표시됩니다.</div>`;
      }
      const img = (b64: string | null): ChartImg | null => (b64 ? { base64: b64, mime: "image/png" } : null);
      const cells = [
        makeCell(1, VEEVA_RD_CHART_TITLES[0], img(veeva.activity),    veeva.msgs.activity),
        makeCell(2, VEEVA_RD_CHART_TITLES[1], img(veeva.docCount),    veeva.msgs.docCount),
        makeCell(3, VEEVA_RD_CHART_TITLES[2], img(veeva.docType),     veeva.msgs.docType),
        makeCell(4, VEEVA_RD_CHART_TITLES[3], img(veeva.activeUser),  veeva.msgs.user),
        makeCell(5, VEEVA_RD_CHART_TITLES[4], img(veeva.uniqueLogin), veeva.msgs.login),
        `<div></div>`,  // 6번째 빈 셀
      ];
      const insightHtml = veeva.insight.length > 0
        ? `<div class="gcp-insight">
            <div class="gcp-insight-label">데이터 인사이트 (최근 3개월 분석)</div>
            ${veeva.insight.map((l) => `<p>${l}</p>`).join("")}
          </div>`
        : "";
      return `<div class="usage-grid grid-3row-gcp">${cells.join("\n")}</div>${insightHtml}`;
    })()}
    <p class="caption">[ ${titleDate} Veeva 시스템 사용 현황 ]</p>
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

  // ── Veeva 데이터 수집(화면 스크래핑 JSON) → #1~#5 막대 차트 ──────────────────
  const veeva = await buildBioVeevaCharts(uploadPath);
  if (!veeva) {
    throw new AppError(
      400,
      "Veeva 수집 데이터(BIO_Activity/PerfStats/DocType.json)가 없습니다. 먼저 '데이터 수집'을 실행해주세요.",
    );
  }

  // 헤드라인 통계 — #1~#4 는 수집 데이터, burnedMs(#5)는 아래 MS Timesheet 에서 채움
  const veevaStats: BioVeevaStats = {
    totalUsers:    veeva.stats.totalUsers,
    dailyAvgLogin: veeva.stats.dailyAvgLogin,
    taskTotal:     veeva.stats.taskTotal,
    taskTop:       veeva.stats.taskTop,
    burnedMs:      0,
  };

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
        // #5 — SKB R&D 최신 월 Burned MS (C열 = used)
        const latestMsRow = msData.chartRows[msData.chartRows.length - 1];
        veevaStats.burnedMs = latestMsRow.used;
        logger.info(`[BIO Report] burnedMs(#5) SKB R&D ${latestMsRow.month}: ${veevaStats.burnedMs}`);

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
    if (e instanceof AppError) throw e;
    logger.error(`[BIO Report] Timesheet 처리 실패 (무시): ${(e as Error).message}`);
    msData = null;
  }

  // HTML → PDF 생성
  const { year, month } = getLastMonth();
  const titleDate  = `${year}년 ${String(month).padStart(2, "0")}월`;
  const html       = buildBioReportHtml(titleDate, veeva, msData, msBarChartBase64, veevaStats);
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

// ── Bio LIMS 보고서 생성 ──────────────────────────────────────────────────────

interface LimsServiceRow {
  initiatedAt:    string;  // 발의일자
  area:           string;  // 영역구분
  contentSummary: string;  // 내용요약
  detail:         string;  // 상세내용
  issueType:      string;  // 이슈구분
  status:         string;  // 진행상태
  hours:          string;  // 지원시간
}

function readLimsServiceData(xlsxPath: string): { rows: LimsServiceRow[]; description: string } {
  const wb  = XLSX.readFile(xlsxPath);
  const ws  = wb.Sheets[wb.SheetNames[0]];
  // raw: false → 날짜·숫자를 셀 표시값(문자열) 그대로 반환
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", raw: false });

  if (raw.length === 0) return { rows: [], description: "" };

  // 2행(index 1) → Description 텍스트
  const description = (raw[1] as unknown[] | undefined ?? [])
    .map(c => String(c ?? "").trim()).filter(Boolean).join(" ").trim();

  // 고정 열 인덱스 (A=0 기준): C=2, D=3, E=4, F=5, G=6, I=8, J=9
  const COL_INITIATED_AT    = 2;  // C: 발의일자
  const COL_AREA            = 3;  // D: 영역구분
  const COL_CONTENT_SUMMARY = 4;  // E: 내용요약
  const COL_DETAIL          = 5;  // F: 상세내용
  const COL_ISSUE_TYPE      = 6;  // G: 이슈구분
  const COL_STATUS          = 8;  // I: 진행상태
  const COL_HOURS           = 9;  // J: 지원시간

  const cell = (row: unknown[], idx: number) => String(row[idx] ?? "").trim();

  // 4행(index 3)부터 데이터 읽기 (1행 미사용, 2행은 description, 3행은 헤더)
  const rows: LimsServiceRow[] = [];
  for (let i = 3; i < raw.length; i++) {
    const row = raw[i] as unknown[];
    const area      = cell(row, COL_AREA);
    const issueType = cell(row, COL_ISSUE_TYPE);
    const detail    = cell(row, COL_DETAIL);
    if (!area && !issueType && !detail) continue;
    rows.push({
      initiatedAt:    cell(row, COL_INITIATED_AT),
      area,
      contentSummary: cell(row, COL_CONTENT_SUMMARY),
      detail,
      issueType,
      status:         cell(row, COL_STATUS),
      hours:          cell(row, COL_HOURS),
    });
  }

  return { rows, description };
}

// ─ 임검분 LIMS 운영 현황 (ELN_report.xlsx "browser export" 시트 기반) ────────────
//   월은 B열(CREATEDATE), 주차는 O열(week). 최근 3개월(M-3~M-1) 기준.
//   E(4)=Lifecyclestate, G(6)=Samplecount, I(8)=taskID, M(12)=Task Plan, O(14)=week

/** 보고서 기준 최근 3개월 [M-3, M-2, M-1] ("YYYY-MM") */
function recentThreeMonths(): string[] {
  const { year, month } = getLastMonth();   // M-1
  const out: string[] = [];
  for (let k = 2; k >= 0; k--) {
    let y = year, m = month - k;
    while (m <= 0) { m += 12; y -= 1; }
    out.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

/** 주차 라벨 → 정렬 키 (YYYY-Www / Www / nn 등) */
function weekSortKey(w: string): number {
  const ym = w.match(/(\d{4}).*?(\d{1,2})\s*$/);
  if (ym) return parseInt(ym[1], 10) * 100 + parseInt(ym[2], 10);
  const n = w.match(/(\d{1,2})/);
  return n ? parseInt(n[1], 10) : 0;
}

interface LimsElnData {
  monthLabels: string[];                 // ["3월","4월","5월"]
  taskPlan:    number[];                 // #1 M열 Task Plan 월별 종류(고유값) 개수
  taskCount:   number[];                 // #2 I열 taskID 월별 건수
  sample:      number[];                 // #3 G열 Samplecount 월별 합산
  latestLabel: string;                   // M-1 라벨
  statusDist:  { label: string; value: number }[];  // #4 M-1 Lifecyclestate 분포
  weeks:       string[];                 // #5 최근 3개월 주차(정렬)
  weekStates:  string[];                 // #5 Lifecyclestate 종류(총합 내림차순)
  weekMatrix:  Record<string, Record<string, number>>;  // #5 week×state 건수
  totals:      { taskPlan: number; taskCount: number; sample: number };
}

function readLimsElnData(xlsxPath: string): LimsElnData | null {
  const wb = XLSX.readFile(xlsxPath);
  // "PreprocessdData" 시트 사용 (오탈자 대비 preprocess 부분일치)
  const sheetName = wb.SheetNames.find((n: string) => /preprocess/i.test(n));
  if (!sheetName) {
    logger.warn(`[BIO LIMS] PreprocessdData 시트를 찾을 수 없습니다. 시트 목록: [${wb.SheetNames.join(", ")}]`);
    return null;
  }
  logger.info(`[BIO LIMS] 시트: "${sheetName}"`);
  const ws   = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
  if (rows.length < 2) return null;

  const num = (v: unknown): number => {
    const m = String(v ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  };
  const parseMonth = (raw: unknown): string => {
    if (raw === null || raw === undefined || raw === "") return "";
    if (typeof raw === "number") return excelDateToStr(raw).slice(0, 7);
    const s = String(raw).trim();
    const m = s.match(/(\d{4})[./-](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, "0")}` : "";
  };

  const months      = recentThreeMonths();
  const latestMonth = months[months.length - 1];
  const mlabel      = (ym: string) => `${parseInt(ym.slice(5, 7), 10)}월`;

  // 헤더 이름으로 컬럼 탐지 (실패 시 글자 인덱스로 폴백). 시트 구조가 가정과 달라도 대응.
  const headers = (rows[0] as unknown[]).map((h) => String(h ?? "").trim());
  const norm    = (s: string) => s.toLowerCase().replace(/[\s_()]/g, "");
  const findCol = (fallback: number, ...terms: string[]): number => {
    for (const t of terms) {
      const i = headers.findIndex((h) => norm(h).includes(norm(t)));
      if (i >= 0) return i;
    }
    return fallback;
  };
  const COL = {
    date:   findCol(1,  "createdate", "접수일", "생성일", "date"),
    state:  findCol(4,  "lifecyclestate", "lifecycle", "상태", "status"),
    sample: findCol(6,  "samplecount", "검체", "sample"),
    taskId: findCol(8,  "taskid"),
    plan:   findCol(12, "taskplan", "task plan", "plan", "수행", "계획"),
    week:   findCol(14, "week", "주차"),
  };
  const hname = (i: number) => (i >= 0 && i < headers.length ? headers[i] : "(범위밖)");
  logger.info(`[BIO LIMS] 컬럼 — date:${COL.date}(${hname(COL.date)}) state:${COL.state}(${hname(COL.state)}) sample:${COL.sample}(${hname(COL.sample)}) taskId:${COL.taskId}(${hname(COL.taskId)}) plan:${COL.plan}(${hname(COL.plan)}) week:${COL.week}(${hname(COL.week)})`);
  logger.info(`[BIO LIMS] 전체 헤더: [${headers.map((h, i) => `${i}:${h}`).join(" | ")}]`);
  if (rows.length > 1) {
    const r1 = rows[1] as unknown[];
    logger.info(`[BIO LIMS] 첫 데이터행 값 — plan(${COL.plan})="${r1[COL.plan] ?? ""}" sample(${COL.sample})="${r1[COL.sample] ?? ""}" taskId(${COL.taskId})="${r1[COL.taskId] ?? ""}" state(${COL.state})="${r1[COL.state] ?? ""}"`);
  }

  const sampleBy: Record<string, number> = {}, taskCntBy: Record<string, number> = {};
  const planTypesBy: Record<string, Set<string>> = {};   // 월별 Task Plan 고유 종류
  for (const m of months) { sampleBy[m] = 0; taskCntBy[m] = 0; planTypesBy[m] = new Set<string>(); }
  const statusMap: Record<string, number> = {};
  const weekMatrix: Record<string, Record<string, number>> = {};
  const stateSet = new Set<string>(), weekSet = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const r  = rows[i] as unknown[];
    const ym = parseMonth(r[COL.date]);
    if (!months.includes(ym)) continue;

    const planVal = String(r[COL.plan] ?? "").trim();
    if (planVal) planTypesBy[ym].add(planVal);                    // 월별 Task Plan 종류(고유값)
    sampleBy[ym]   += num(r[COL.sample]);
    if (String(r[COL.taskId] ?? "").trim()) taskCntBy[ym] += 1;

    const state = String(r[COL.state] ?? "").trim();
    if (ym === latestMonth && state) statusMap[state] = (statusMap[state] ?? 0) + 1;

    const week = String(r[COL.week] ?? "").trim();
    if (week && state) {
      weekSet.add(week); stateSet.add(state);
      weekMatrix[week] = weekMatrix[week] ?? {};
      weekMatrix[week][state] = (weekMatrix[week][state] ?? 0) + 1;
    }
  }

  const weeks = [...weekSet].sort((a, b) => weekSortKey(a) - weekSortKey(b) || (a < b ? -1 : 1));
  const stateTotals: Record<string, number> = {};
  for (const s of stateSet) stateTotals[s] = weeks.reduce((t, w) => t + (weekMatrix[w]?.[s] ?? 0), 0);
  const weekStates = Object.entries(stateTotals).sort((a, b) => b[1] - a[1]).map(([s]) => s);

  const taskPlan  = months.map((m) => planTypesBy[m].size);   // 월별 Task Plan 종류 개수
  const taskCount = months.map((m) => taskCntBy[m]);
  const sample    = months.map((m) => Math.round(sampleBy[m]));

  logger.info(`[BIO LIMS] 월:${months.join(",")} taskPlan:${taskPlan} taskCount:${taskCount} sample:${sample} 상태(${latestMonth}):${Object.keys(statusMap).length}종 주차:${weeks.length}`);
  return {
    monthLabels: months.map(mlabel),
    taskPlan, taskCount, sample,
    latestLabel: mlabel(latestMonth),
    statusDist:  Object.entries(statusMap).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
    weeks, weekStates, weekMatrix,
    totals: {
      taskPlan:  taskPlan.reduce((s, v) => s + v, 0),
      taskCount: taskCount.reduce((s, v) => s + v, 0),
      sample:    sample.reduce((s, v) => s + v, 0),
    },
  };
}

/** Lifecyclestate 분포 도넛 차트 PNG (범례에 건수 표기) */
async function renderLimsDonutToPng(dist: { label: string; value: number }[], outputPng: string): Promise<void> {
  const chartJs   = loadChartJsScript();
  const scriptTag = chartJs
    ? `<script>${chartJs}</script>`
    : `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>`;
  const labels = dist.map((d) => `${d.label} (${d.value})`);
  const values = dist.map((d) => d.value);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;} body{background:#fff;font-family:"Malgun Gothic",Arial,sans-serif;}
    #c{width:440px;height:300px;background:#fff;}
  </style></head><body><div id="c"><canvas id="ch" width="440" height="300"></canvas></div>
  ${scriptTag}<script>(function(){
    var ctx=document.getElementById('ch').getContext('2d');
    if(!window.Chart){ctx.fillText('Chart.js load fail',10,30);return;}
    new Chart(ctx,{type:'doughnut',data:{labels:${JSON.stringify(labels)},datasets:[{data:${JSON.stringify(values)},backgroundColor:${JSON.stringify(ELN_PALETTE)},borderColor:'#fff',borderWidth:1}]},
      options:{responsive:false,animation:false,cutout:'52%',layout:{padding:8},
        plugins:{legend:{display:true,position:'right',labels:{font:{size:10},boxWidth:10,padding:6}},tooltip:{enabled:false}}}});
  })();</script></body></html>`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 440, height: 300 });
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(400);
    await page.locator("#c").screenshot({ path: outputPng, type: "png" });
  } finally {
    await browser.close();
  }
}

/** 임검분 LIMS 데이터 인사이트 (GCP 컨셉) */
function buildLimsInsightLines(d: LimsElnData): string[] {
  const fmt = (n: number) => Math.round(n).toLocaleString();
  const first = (x: number[]) => x[0] ?? 0;
  const last  = (x: number[]) => x[x.length - 1] ?? 0;
  const tword = (x: number[]) => last(x) > first(x) ? "증가" : last(x) < first(x) ? "감소" : "유지";
  const range = d.monthLabels.length ? `${d.monthLabels[0]}~${d.monthLabels[d.monthLabels.length - 1]}` : "";
  const lines: string[] = [];

  lines.push(`최근 3개월(${range}) 임검분 LIMS는 수행 Task Plan 총 ${fmt(d.totals.taskPlan)}건(월 ${fmt(first(d.taskPlan))}→${fmt(last(d.taskPlan))}, ${tword(d.taskPlan)}), 생성 Task 총 ${fmt(d.totals.taskCount)}건으로 집계되었으며,`);
  lines.push(`시험 검체는 총 ${fmt(d.totals.sample)}개가 처리되었고,`);
  if (d.statusDist.length) {
    const topS = d.statusDist[0];
    lines.push(`${d.latestLabel} Task 상태는 ${topS.label}(${fmt(topS.value)}건)이 가장 많은 비중을 차지했습니다.`);
  } else {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/처리되었고,$/, "처리되었습니다.");
  }
  return lines;
}

function buildBioLimsReportHtml(
  titleDate:       string,
  today:           string,
  charts:          { taskPlan: string | null; taskCount: string | null; sample: string | null; status: string | null; weekly: string | null },
  data:            LimsElnData | null,
): string {
  const monthRange = data && data.monthLabels.length
    ? `${data.monthLabels[0]}~${data.monthLabels[data.monthLabels.length - 1]}`
    : "";

  const cell = (no: number, title: string, img: string | null, msg?: string) => `
    <div class="lims-cell">
      <div class="lims-cell-title"><span class="lims-no">${no}</span>${escHtml(title)}</div>
      ${msg ? `<div class="lims-cell-msg">${msg}</div>` : ""}
      <div class="lims-img-wrap">${
        img
          ? `<img src="data:image/png;base64,${img}" alt="${escHtml(title)}" />`
          : `<div class="lims-no-data">데이터 없음</div>`
      }</div>
    </div>`;

  const wide = (no: number, title: string, img: string | null, msg?: string) => `
    <div class="lims-cell lims-wide">
      <div class="lims-cell-title"><span class="lims-no">${no}</span>${escHtml(title)}</div>
      ${msg ? `<div class="lims-cell-msg">${msg}</div>` : ""}
      <div class="lims-img-wrap lims-img-wide">${
        img
          ? `<img src="data:image/png;base64,${img}" alt="${escHtml(title)}" />`
          : `<div class="lims-no-data">데이터 없음</div>`
      }</div>
    </div>`;

  const msgs = data ? {
    taskPlan:  `월별 수행된 Task Plan 종류 수 (최근 3개월)`,
    taskCount: `최근 3개월 합 <strong>${data.totals.taskCount.toLocaleString()}</strong>건`,
    sample:    `최근 3개월 합 <strong>${data.totals.sample.toLocaleString()}</strong>개`,
    status:    `${data.latestLabel} 기준 Task 상태 분포`,
    weekly:    `최근 3개월 주차별 Task 상태 현황`,
  } : { taskPlan: "", taskCount: "", sample: "", status: "", weekly: "" };

  const insight = data ? buildLimsInsightLines(data) : [];
  const insightHtml = insight.length > 0
    ? `<div class="gcp-insight">
        <div class="gcp-insight-label">데이터 인사이트 (최근 3개월 분석)</div>
        ${insight.map((l) => `<p>${l}</p>`).join("")}
      </div>`
    : "";

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
    .page { break-before:page; padding:32px 40px 24px; }
    .page-header {
      display:flex; align-items:flex-end; justify-content:space-between;
      border-bottom:2.5px solid #0f2d55; padding-bottom:10px; margin-bottom:14px;
    }
    .page-header h2  { font-size:18px; font-weight:700; color:#0f2d55; }
    .page-header .pg { font-size:11px; color:#9ca3af; }
    .headline {
      background:#f0f4ff; border-left:4px solid #1a4a8a; padding:9px 14px;
      font-size:11px; line-height:1.6; color:#1e3a5f; margin-bottom:12px; border-radius:0 4px 4px 0;
    }
    /* 4개 차트(2×2) + 전폭(주차) */
    .lims-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .lims-grid-rows { grid-template-rows:repeat(2, 200px); }
    .lims-wide { grid-column:1 / -1; }
    .lims-cell {
      border:1px solid #e5e7eb; border-radius:6px; overflow:hidden;
      background:#fff; display:flex; flex-direction:column; min-width:0;
    }
    .lims-cell-title {
      flex-shrink:0; height:24px; padding:0 10px; gap:6px;
      font-size:10px; font-weight:700; color:#1f2937;
      background:#f0f4f8; border-bottom:1px solid #e5e7eb;
      display:flex; align-items:center; justify-content:center;
    }
    .lims-no {
      display:inline-flex; align-items:center; justify-content:center;
      width:16px; height:16px; border-radius:50%;
      background:#0f2d55; color:#fff; font-size:9px; font-weight:700; flex-shrink:0;
    }
    .lims-cell-msg {
      flex-shrink:0; padding:3px 10px; font-size:9px; color:#374151;
      background:#f8fafc; border-bottom:1px solid #e5e7eb; line-height:1.4; text-align:center;
    }
    .lims-cell-msg strong { color:#0f2d55; font-weight:700; }
    .lims-img-wrap { flex:1; min-height:0; display:flex; align-items:center; justify-content:center; padding:4px; overflow:hidden; }
    .lims-img-wrap img { display:block; max-width:100%; max-height:100%; height:auto; width:auto; object-fit:contain; }
    .lims-img-wide { align-items:stretch; }
    .lims-img-wide img { width:100%; height:auto; max-height:none; }
    .lims-no-data { color:#9ca3af; font-size:11px; }
    .gcp-insight {
      margin-top:10px; padding:9px 14px; background:#f0fdf4;
      border-left:4px solid #16a34a; border-radius:0 4px 4px 0;
      font-size:10.5px; line-height:1.6; color:#374151;
    }
    .gcp-insight .gcp-insight-label { font-weight:700; color:#15803d; font-size:11px; margin-bottom:4px; }
    .gcp-insight p { margin:0 0 3px; }
    .gcp-insight p:last-child { margin-bottom:0; }
    .footer {
      margin-top:14px; padding-top:10px; border-top:1px solid #e5e7eb;
      font-size:10px; color:#d1d5db; display:flex; justify-content:space-between;
    }
  </style>
</head>
<body>
  <div class="cover">
    <div class="cover-badge">SK Bioscience</div>
    <div class="cover-main">${titleDate}<br>Bio연구본부 임검분 LIMS 운영 현황</div>
    <div class="cover-rule"></div>
    <div class="cover-date">작성일: ${today}</div>
  </div>

  <div class="page">
    <div class="page-header">
      <h2>임검분 LIMS 운영 현황</h2>
      <span class="pg">${titleDate}</span>
    </div>
    <div class="headline">최근 3개월(${monthRange}) 임검분 LIMS 운영 현황입니다. (ELN_report.xlsx 기준)</div>
    <div class="lims-grid lims-grid-rows">
      ${cell(1, "수행된 Task Plan", charts.taskPlan, msgs.taskPlan)}
      ${cell(2, "생성된 Task",      charts.taskCount, msgs.taskCount)}
      ${cell(3, "시험 검체 개수",   charts.sample, msgs.sample)}
      ${cell(4, "Task Status 요약", charts.status, msgs.status)}
    </div>
    <div class="lims-grid" style="margin-top:8px;">
      ${wide(5, "주차 별 Task 생성 개수 및 현황", charts.weekly, msgs.weekly)}
    </div>
    ${insightHtml}
    <div class="footer">
      <span>SK Bioscience Bio연구본부 — 임검분 LIMS 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>
</body>
</html>`;
}

export async function generateBioLimsReport(jobId: string): Promise<BioReportResult> {
  logger.info(`[BIO LIMS Report] 보고서 생성 요청 — jobId: ${jobId}`);

  const { year, month } = getLastMonth();
  const titleDate = `${year}년 ${String(month).padStart(2, "0")}월`;
  const today     = new Date().toISOString().slice(0, 10);

  const uploadPath = path.resolve(process.env.UPLOAD_DIR ?? "uploads", jobId, "uploads");
  fs.mkdirSync(uploadPath, { recursive: true });

  let data: LimsElnData | null = null;
  const charts: { taskPlan: string | null; taskCount: string | null; sample: string | null; status: string | null; weekly: string | null } =
    { taskPlan: null, taskCount: null, sample: null, status: null, weekly: null };

  try {
    const srcRows = await query<{ stored_path: string }>(
      `SELECT stored_path FROM uploaded_files
       WHERE report_job_id = $1 AND LOWER(original_name) = 'lims_dashboard.xlsx'
       ORDER BY created_at DESC LIMIT 1`,
      [jobId]
    );
    if (srcRows.length && fs.existsSync(srcRows[0].stored_path)) {
      logger.info(`[BIO LIMS Report] LIMS_Dashboard.xlsx: ${srcRows[0].stored_path}`);
      data = readLimsElnData(srcRows[0].stored_path);
    } else {
      logger.info("[BIO LIMS Report] LIMS_Dashboard.xlsx 없음 — 차트 생략");
    }
  } catch (e) {
    logger.error(`[BIO LIMS Report] LIMS_Dashboard.xlsx 처리 실패: ${(e as Error).message}`);
  }

  if (data) {
    const d  = data;
    const ts = Date.now();
    const renderBar = async (vals: number[], color: string, name: string): Promise<string | null> => {
      if (vals.every((v) => v === 0)) return null;
      try {
        const p = path.join(uploadPath, `lims_${name}_${ts}.png`);
        await renderGcpBarToPng(d.monthLabels, vals, color, p);
        return fs.readFileSync(p).toString("base64");
      } catch (e) { logger.warn(`[BIO LIMS] bar(${name}) 실패: ${(e as Error).message}`); return null; }
    };
    charts.taskPlan  = await renderBar(d.taskPlan,  "#4472C4", "taskplan");   // #1 Task Plan 월별 합산
    charts.taskCount = await renderBar(d.taskCount, "#5B9BD5", "taskcount");  // #2 생성 Task 월별 건수
    charts.sample    = await renderBar(d.sample,    "#70AD47", "sample");     // #3 검체 월별 합산

    // #4 도넛 — M-1 Lifecyclestate 분포
    if (d.statusDist.length) {
      try {
        const p = path.join(uploadPath, `lims_status_${ts}.png`);
        await renderLimsDonutToPng(d.statusDist, p);
        charts.status = fs.readFileSync(p).toString("base64");
      } catch (e) { logger.warn(`[BIO LIMS] donut 실패: ${(e as Error).message}`); }
    }

    // #5 주차별 Task 생성 개수 및 현황 — Lifecyclestate × week (전폭 그룹 막대)
    if (d.weeks.length && d.weekStates.length) {
      const series = d.weekStates.map((s, i) => ({
        name: s, color: ELN_PALETTE[i % ELN_PALETTE.length],
        values: d.weeks.map((w) => d.weekMatrix[w]?.[s] ?? 0),
      }));
      try {
        const p  = path.join(uploadPath, `lims_weekly_${ts}.png`);
        const gw = Math.min(2600, Math.max(1400, d.weeks.length * Math.max(1, d.weekStates.length) * 26 + 240));
        await renderGcpGroupedBarToPng(d.weeks, series, p, gw, 420);
        charts.weekly = fs.readFileSync(p).toString("base64");
      } catch (e) { logger.warn(`[BIO LIMS] weekly 실패: ${(e as Error).message}`); }
    }
  }

  const html = buildBioLimsReportHtml(titleDate, today, charts, data);

  const outputDir  = path.resolve(process.env.OUTPUT_DIR ?? "outputs");
  fs.mkdirSync(outputDir, { recursive: true });

  const mm         = String(month).padStart(2, "0");
  const filename   = `${year}.${mm} Bio연구본부 임검분 LIMS 운영 현황 Report.pdf`;
  const outputPath = path.join(outputDir, filename);

  logger.info(`[BIO LIMS Report] PDF 생성: ${outputPath}`);

  const result = await PdfGenerator.generate(html, outputPath, {
    format: "A4",
    margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
  });

  logger.info(`[BIO LIMS Report] 완료 — ${result.pageCount}p, ${result.fileSize.toLocaleString()} bytes`);

  return {
    filePath:  result.filePath,
    filename,
    fileSize:  result.fileSize,
    pageCount: result.pageCount,
  };
}

// ── Bio ELN 보고서 생성 ───────────────────────────────────────────────────────

// ─ ELN 차트 팔레트 (12색) ────────────────────────────────────────────────────
const ELN_PALETTE = [
  "#4472C4","#ED7D31","#A9D18E","#FFC000","#5B9BD5",
  "#70AD47","#FF6384","#7030A0","#C00000","#00B0F0",
  "#92D050","#FF6600",
];

// ─ ELN 데이터 구조 ────────────────────────────────────────────────────────────

interface ElnReportData {
  /** 가장 최근 3개월 (오름차순, "YYYY-MM") */
  months:      string[];
  /** 3개월 내 PRJCODE 목록 (총합 내림차순) */
  projects:    string[];
  /** chart1[month][prjCode] = 건수 */
  chart1:      Record<string, Record<string, number>>;
  /** 가장 최근 월 ("YYYY-MM") */
  latestMonth: string;
  /** chart2[lastName] = 건수 (최근 월만) */
  chart2:      Record<string, number>;
  /** 3개월 내 LASTNAME(팀) 목록 (총합 내림차순) */
  teams:        string[];
  /** chart2Monthly[month][lastName] = 건수 (3개월 인사이트용) */
  chart2Monthly: Record<string, Record<string, number>>;
}

/**
 * ELN_report.xlsx "browser export (xx년)" 시트를 파싱합니다.
 *  - B열(index 1): CREATEDATE — Excel 시리얼 또는 날짜 문자열
 *  - F열(index 5): LASTNAME
 *  - H열(index 7): PRJCODE
 */
function readElnReportData(xlsxPath: string): ElnReportData {
  const wb = XLSX.readFile(xlsxPath);

  // 첫 번째 시트명 "팀별_xx월(yy년)" 에서 기준 월(cutoff) 추출
  // 예: "팀별_04월(26년)" → "2026-04"
  let cutoffMonth: string | null = null;
  const firstSheetName = wb.SheetNames[0] ?? "";
  const cutoffMatch = firstSheetName.match(/팀별_(\d{1,2})월\((\d{2})년\)/);
  if (cutoffMatch) {
    const mm       = cutoffMatch[1].padStart(2, "0");
    const fullYear = 2000 + parseInt(cutoffMatch[2], 10);
    cutoffMonth    = `${fullYear}-${mm}`;
    logger.info(`[BIO ELN] 기준 시트: "${firstSheetName}" → cutoff: ${cutoffMonth}`);
  } else {
    logger.warn(`[BIO ELN] 첫 번째 시트명에서 기준 월을 파악할 수 없습니다: "${firstSheetName}"`);
  }

  const sheetName = wb.SheetNames.find((n: string) => /browser\s+export/i.test(n));
  if (!sheetName) throw new Error("ELN_report.xlsx: 'browser export' 시트를 찾을 수 없습니다.");
  logger.info(`[BIO ELN] 시트: "${sheetName}"`);

  const ws   = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];

  /** raw → "YYYY-MM" */
  const parseMonth = (raw: unknown): string => {
    if (raw === null || raw === undefined || raw === "") return "";
    if (typeof raw === "number") return excelDateToStr(raw).slice(0, 7);
    const s = String(raw).trim();
    const m = s.match(/(\d{4})[./-](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, "0")}` : "";
  };

  // row 0 = 헤더, row 1~ = 데이터
  // cutoffMonth 가 있으면 해당 월 이하 데이터만 포함
  const records: { month: string; lastName: string; prjCode: string }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row      = rows[i] as unknown[];
    const month    = parseMonth(row[1]);
    const lastName = String(row[5] ?? "").trim();
    const prjCode  = String(row[7] ?? "").trim();
    if (!month) continue;
    if (cutoffMonth && month > cutoffMonth) continue;
    records.push({ month, lastName, prjCode });
  }
  logger.info(`[BIO ELN] 파싱 행 수: ${records.length} (cutoff: ${cutoffMonth ?? "없음"})`);

  // 최근 3개월 (오름차순)
  const allMonths = [...new Set(records.map((r) => r.month))].sort();
  const months    = allMonths.slice(-3);
  const latestMonth = months[months.length - 1] ?? "";

  // 과제별 총합 → 내림차순 정렬
  const projectTotals: Record<string, number> = {};
  for (const r of records) {
    if (!months.includes(r.month) || !r.prjCode) continue;
    projectTotals[r.prjCode] = (projectTotals[r.prjCode] ?? 0) + 1;
  }
  const projects = Object.entries(projectTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);

  // Chart1 행렬 초기화 + 집계
  const chart1: Record<string, Record<string, number>> = {};
  for (const m of months) {
    chart1[m] = {};
    for (const p of projects) chart1[m][p] = 0;
  }
  for (const r of records) {
    if (!months.includes(r.month) || !r.prjCode) continue;
    chart1[r.month][r.prjCode] = (chart1[r.month][r.prjCode] ?? 0) + 1;
  }

  // Chart2: 최근 월 LASTNAME 분포
  const chart2: Record<string, number> = {};
  for (const r of records) {
    if (r.month !== latestMonth || !r.lastName) continue;
    chart2[r.lastName] = (chart2[r.lastName] ?? 0) + 1;
  }

  // 팀(LASTNAME)별 3개월 집계 (인사이트용)
  const teamTotals: Record<string, number> = {};
  for (const r of records) {
    if (!months.includes(r.month) || !r.lastName) continue;
    teamTotals[r.lastName] = (teamTotals[r.lastName] ?? 0) + 1;
  }
  const teams = Object.entries(teamTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  const chart2Monthly: Record<string, Record<string, number>> = {};
  for (const m of months) {
    chart2Monthly[m] = {};
    for (const t of teams) chart2Monthly[m][t] = 0;
  }
  for (const r of records) {
    if (!months.includes(r.month) || !r.lastName) continue;
    chart2Monthly[r.month][r.lastName] = (chart2Monthly[r.month][r.lastName] ?? 0) + 1;
  }

  logger.info(`[BIO ELN] 월: ${months.join(", ")}, 과제: ${projects.length}개, 최근월 LASTNAME: ${Object.keys(chart2).length}개, 팀(3개월): ${teams.length}개`);
  return { months, projects, chart1, latestMonth, chart2, teams, chart2Monthly };
}

// ─ Chart 1: 과제별 100% 누적 막대형 ─────────────────────────────────────────

async function renderElnChart1ToPng(data: ElnReportData, outputPng: string): Promise<void> {
  const { months, projects, chart1 } = data;

  const labels   = months.map((m) => m.replace("-", "."));   // "2025.03"
  const datasets = projects.map((prj, i) => {
    const values = months.map((m) => {
      const total = projects.reduce((s, p) => s + (chart1[m][p] ?? 0), 0);
      if (total === 0) return 0;
      return Math.round((chart1[m][prj] ?? 0) / total * 1000) / 10;  // 소수 1자리 %
    });
    return {
      label:           prj,
      data:            values,
      backgroundColor: ELN_PALETTE[i % ELN_PALETTE.length],
      borderWidth:     0,
    };
  });

  const chartJs   = loadChartJsScript();
  const scriptTag = chartJs
    ? `<script>${chartJs}</script>`
    : `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>`;

  const legendRows = Math.ceil(projects.length / 4);
  const canvasH    = 300 + legendRows * 20;

  const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#fff; font-family:"Malgun Gothic",Arial,sans-serif; }
  #wrap { width:640px; height:${canvasH}px; }
</style></head>
<body>
<div id="wrap"><canvas id="chart" width="640" height="${canvasH}"></canvas></div>
${scriptTag}
<script>
(function(){
  var ctx = document.getElementById('chart').getContext('2d');
  if (!window.Chart) { ctx.fillText('Chart.js 로드 실패', 10, 20); return; }

  /* 세그먼트 내 % 레이블 — 5% 미만은 생략 */
  Chart.register({
    id: 'pctLabels',
    afterDatasetsDraw: function(chart) {
      var c = chart.ctx;
      chart.data.datasets.forEach(function(ds, di) {
        var meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        meta.data.forEach(function(bar, bi) {
          var v = Number(ds.data[bi]);
          if (!v || v < 5) return;
          var segH = Math.abs(bar.base - bar.y);
          if (segH < 14) return;
          c.save();
          c.fillStyle = '#fff';
          c.font = 'bold 10px Arial';
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText(v + '%', bar.x, bar.y + (bar.base - bar.y) / 2);
          c.restore();
        });
      });
    }
  });

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(labels)},
      datasets: ${JSON.stringify(datasets)},
    },
    options: {
      responsive: false,
      animation: false,
      layout: { padding: { top: 10, right: 10 } },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { size: 10 }, padding: 8, usePointStyle: true, boxWidth: 10 }
        },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { font: { size: 13 }, color: '#374151' },
        },
        y: {
          stacked: true,
          min: 0, max: 100,
          grid: { color: '#f0f4f8' },
          ticks: {
            font: { size: 11 }, color: '#6b7280',
            callback: function(v) { return v + '%'; }
          },
        },
      },
    },
  });
})();
</script></body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 640, height: canvasH });
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(500);
    await page.locator("#wrap").screenshot({ path: outputPng, type: "png" });
    logger.info(`[BIO ELN] Chart1 PNG: ${outputPng} (${fs.statSync(outputPng).size.toLocaleString()} bytes)`);
  } finally {
    await browser.close();
  }
}

// ─ Chart 2: 팀별(LASTNAME) 막대 차트 ─────────────────────────────────────────

async function renderElnChart2ToPng(data: ElnReportData, outputPng: string): Promise<void> {
  const { chart2, latestMonth } = data;

  const entries   = Object.entries(chart2).sort((a, b) => b[1] - a[1]);
  const labels    = entries.map(([name]) => name);
  const values    = entries.map(([, cnt])  => cnt);
  const barColors = labels.map((_, i) => ELN_PALETTE[i % ELN_PALETTE.length]);

  const chartJs   = loadChartJsScript();
  const scriptTag = chartJs
    ? `<script>${chartJs}</script>`
    : `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>`;

  const canvasH = Math.max(260, 80 + labels.length * 24);

  const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#fff; font-family:"Malgun Gothic",Arial,sans-serif; }
  #wrap { width:640px; height:${canvasH}px; }
</style></head>
<body>
<div id="wrap"><canvas id="chart" width="640" height="${canvasH}"></canvas></div>
${scriptTag}
<script>
(function(){
  var ctx = document.getElementById('chart').getContext('2d');
  if (!window.Chart) { ctx.fillText('Chart.js 로드 실패', 10, 20); return; }

  /* 막대 상단 숫자 레이블 */
  Chart.register({
    id: 'barTop',
    afterDatasetsDraw: function(chart) {
      var c = chart.ctx;
      chart.data.datasets.forEach(function(ds, di) {
        var meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        meta.data.forEach(function(bar, bi) {
          var v = ds.data[bi];
          if (!v) return;
          c.save();
          c.fillStyle = '#1f2937';
          c.font = 'bold 11px Arial';
          c.textAlign = 'center';
          c.textBaseline = 'bottom';
          c.fillText(String(v), bar.x, bar.y - 3);
          c.restore();
        });
      });
    }
  });

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(labels)},
      datasets: [{
        label: ${JSON.stringify(formatMonthKorean(latestMonth) + " 연구노트 생성 건수")},
        data:  ${JSON.stringify(values)},
        backgroundColor: ${JSON.stringify(barColors)},
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      layout: { padding: { top: 24, right: 20 } },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11 }, color: '#374151', maxRotation: 45 },
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f0f4f8' },
          ticks: { font: { size: 11 }, color: '#6b7280', stepSize: 1 },
        },
      },
    },
  });
})();
</script></body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 640, height: canvasH });
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(500);
    await page.locator("#wrap").screenshot({ path: outputPng, type: "png" });
    logger.info(`[BIO ELN] Chart2 PNG: ${outputPng} (${fs.statSync(outputPng).size.toLocaleString()} bytes)`);
  } finally {
    await browser.close();
  }
}

// ─ ELN_service.xlsx 파싱 ──────────────────────────────────────────────────────

interface ElnServiceRow {
  requestId:    string;   // 요청ID
  requestTeam:  string;   // 요청팀
  summary:      string;   // 요청내용(요약)
  serviceType:  string;   // Hypercare/Managed Service/Support
  receptionDate: string;  // 접수일 (표시용 문자열)
  description:  string;   // Description
  status:       string;   // 처리유무
}

/**
 * ELN_service.xlsx 첫 번째 시트를 파싱합니다.
 *  - 헤더 행(row 0)에서 열 이름으로 인덱스를 자동 탐색
 *  - G열(index 6) = "접수일" — 탐색 실패 시 폴백
 *  - 보고서 기준 대상 월(M-1, "YYYY-MM") 접수 행만 반환
 *
 * @param targetMonth 보고서 대상 월 "YYYY-MM" (전월 = M-1)
 * @returns { rows, latestMonth } (latestMonth = targetMonth)
 */
function readElnServiceData(xlsxPath: string, targetMonth: string): { rows: ElnServiceRow[]; latestMonth: string } {
  const wb = XLSX.readFile(xlsxPath);

  // 첫 번째 시트 사용 (또는 데이터가 있는 첫 시트)
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("ELN_service.xlsx: 시트가 없습니다.");
  logger.info(`[BIO ELN Svc] 시트: "${sheetName}"`);

  const ws   = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
  if (rows.length < 2) return { rows: [], latestMonth: "" };

  // 헤더 행에서 열 인덱스 탐색
  const headers = (rows[0] as unknown[]).map((h) => String(h ?? "").trim());
  const findCol = (...terms: string[]): number => {
    for (const term of terms) {
      const i = headers.findIndex((h) =>
        h.toLowerCase().includes(term.toLowerCase())
      );
      if (i >= 0) return i;
    }
    return -1;
  };

  const colRequestId   = findCol("요청ID", "요청 ID", "ID");
  const colRequestTeam = findCol("요청팀", "팀");
  const colSummary     = findCol("요청내용", "내용(요약)", "내용");
  const colServiceType = findCol("Hypercare", "Managed Service", "Support", "서비스유형", "구분");
  const colReception   = findCol("접수일") !== -1 ? findCol("접수일") : 6;  // G열 폴백
  const colDescription = findCol("Description", "설명", "비고");
  const colStatus      = findCol("처리유무", "처리 유무", "처리", "상태");

  logger.info(`[BIO ELN Svc] 컬럼 인덱스 — 요청ID:${colRequestId} 요청팀:${colRequestTeam} 요약:${colSummary} 서비스:${colServiceType} 접수일:${colReception} Desc:${colDescription} 처리:${colStatus}`);

  /** raw → "YYYY-MM-DD" 문자열 (표시용) */
  const toDateStr = (raw: unknown): string => {
    if (raw === null || raw === undefined || raw === "") return "";
    if (typeof raw === "number") return excelDateToStr(raw);
    const s = String(raw).trim();
    // 이미 날짜 문자열이면 그대로
    return s;
  };

  /** raw → "YYYY-MM" (필터용) */
  const toMonth = (raw: unknown): string => {
    const s = toDateStr(raw);
    const m = s.match(/(\d{4})[./-](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, "0")}` : "";
  };

  const cell = (row: unknown[], idx: number) =>
    idx >= 0 ? String(row[idx] ?? "").trim() : "";

  logger.info(`[BIO ELN Svc] 대상 월(보고서 M-1): ${targetMonth}`);

  // 대상 월(M-1) 접수 행만 필터링
  const result: ElnServiceRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    if (toMonth(row[colReception]) !== targetMonth) continue;
    result.push({
      requestId:    cell(row, colRequestId),
      requestTeam:  cell(row, colRequestTeam),
      summary:      cell(row, colSummary),
      serviceType:  cell(row, colServiceType),
      receptionDate: toDateStr(row[colReception]),
      description:  cell(row, colDescription),
      status:       cell(row, colStatus),
    });
  }
  logger.info(`[BIO ELN Svc] ${targetMonth} 접수 행: ${result.length}개`);
  return { rows: result, latestMonth: targetMonth };
}

// ─ 인사이트 분석 (공통) ────────────────────────────────────────────────────────
// 최근 3개월 시계열(month → key → 건수)을 분석해 변화점(급증/급감/지속 추세/집중도)을
// 약 300자 분량의 한국어 문장으로 요약한다. (과제별·팀별 차트 공용)

function analyzeMonthlyTrendInsight(
  months: string[],
  keys:   string[],
  matrix: Record<string, Record<string, number>>,
  unit:   string,
): string[] {
  if (months.length < 2 || keys.length === 0) {
    return ["분석 가능한 월별 데이터가 충분하지 않아 변화 추이를 산출하지 못했습니다."];
  }

  const first  = months[0];
  const last   = months[months.length - 1];
  const mLabel = (m: string) => `${parseInt(m.slice(5, 7), 10)}월`;
  const monthTotal = (m: string) => keys.reduce((s, k) => s + (matrix[m]?.[k] ?? 0), 0);

  const totalFirst = monthTotal(first);
  const totalLast  = monthTotal(last);
  const pct   = totalFirst > 0 ? Math.round(((totalLast - totalFirst) / totalFirst) * 100) : 0;
  const trend = totalLast > totalFirst ? "증가" : totalLast < totalFirst ? "감소" : "유지";

  // key별 시계열 / 변화량 / 연속 추세
  const stats = keys.map((k) => {
    const series = months.map((m) => matrix[m]?.[k] ?? 0);
    const head   = series[0];
    const tail   = series[series.length - 1];
    let inc = true, dec = true;
    for (let i = 1; i < series.length; i++) {
      if (!(series[i] > series[i - 1])) inc = false;
      if (!(series[i] < series[i - 1])) dec = false;
    }
    return { code: k, head, tail, delta: tail - head, inc, dec };
  });

  const byDelta = [...stats].sort((a, b) => b.delta - a.delta);
  const topInc  = byDelta[0];
  const topDec  = byDelta[byDelta.length - 1];
  const contInc = stats.filter((s) => s.inc && s.delta > 0).map((s) => s.code);
  const contDec = stats.filter((s) => s.dec && s.delta < 0).map((s) => s.code);

  // 최근 월 기준 상위 집중도
  const lastRank = keys.map((k) => ({ k, v: matrix[last]?.[k] ?? 0 })).sort((a, b) => b.v - a.v);
  const top3     = lastRank.slice(0, 3).filter((x) => x.v > 0);
  const top3Sum  = top3.reduce((s, x) => s + x.v, 0);
  const top3Pct  = totalLast > 0 ? Math.round((top3Sum / totalLast) * 100) : 0;

  // 받침 유무에 따라 조사(이/가, 은/는)를 선택해 자연스러운 문장을 만든다.
  const hasJong = (s: string): boolean => {
    const c    = s.trim().slice(-1) || "";
    const code = c.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0; // 한글 음절
    if (/[0-9]/.test(c)) return ![2, 4, 5, 9].includes(Number(c));          // 숫자 발음 받침
    return true;                                                            // 영문 등은 받침 있음으로 간주
  };
  const iGa     = (s: string) => `${s}${hasJong(s) ? "이" : "가"}`;
  const eunNeun = (s: string) => `${s}${hasJong(s) ? "은" : "는"}`;

  // 각 원소 = 한 줄. 중간 줄은 연결어미로 잇고 마지막 줄만 종결형으로 끝낸다.
  const lines: string[] = [];

  // 1) 전체 추세
  const overall = totalLast === totalFirst
    ? `${totalFirst}건에서 ${totalLast}건으로 비슷한 수준을 유지했으며,`
    : `${totalFirst}건에서 ${totalLast}건으로 약 ${Math.abs(pct)}% ${trend}했으며,`;
  lines.push(`최근 3개월(${mLabel(first)}~${mLabel(last)}) ${unit}별 연구노트 생성 건수는 ${overall}`);

  // 2) 급증 / 급감
  const hasInc = !!(topInc && topInc.delta > 0);
  const hasDec = !!(topDec && topDec.delta < 0 && topDec.code !== topInc?.code);
  if (hasInc && hasDec) {
    lines.push(
      `그중 ${iGa(topInc!.code)} ${topInc!.head}→${topInc!.tail}건으로 가장 큰 폭으로 늘어난 반면, ` +
      `${eunNeun(topDec!.code)} ${topDec!.head}→${topDec!.tail}건으로 가장 크게 줄었고,`
    );
  } else if (hasInc) {
    lines.push(`그중 ${iGa(topInc!.code)} ${topInc!.head}→${topInc!.tail}건으로 가장 큰 폭으로 늘었고,`);
  } else if (hasDec) {
    lines.push(`그중 ${eunNeun(topDec!.code)} ${topDec!.head}→${topDec!.tail}건으로 가장 크게 줄었고,`);
  }

  // 3) 연속 추세
  if (contInc.length > 0 && contDec.length > 0) {
    lines.push(
      `${contInc.slice(0, 3).join(", ")} 등은 3개월 연속 증가세가 이어진 반면 ` +
      `${contDec.slice(0, 3).join(", ")} 등은 꾸준한 감소세를 보이는 등 ${unit}별 편차가 뚜렷했으며,`
    );
  } else if (contInc.length > 0) {
    lines.push(`${contInc.slice(0, 3).join(", ")} 등은 3개월 연속 증가세가 이어졌으며,`);
  } else if (contDec.length > 0) {
    lines.push(`${contDec.slice(0, 3).join(", ")} 등은 꾸준한 감소세를 보였으며,`);
  }

  // 4) 집중도 (마무리 문장)
  if (top3.length > 0) {
    lines.push(
      `최근 월 기준 상위 ${top3.length}개 ${iGa(unit)} 전체의 약 ${top3Pct}%를 차지해 ` +
      `생성이 일부 ${unit}에 집중되는 경향을 보입니다.`
    );
  }

  // 마지막 줄이 연결어미(쉼표)로 끝나면 종결형으로 자연스럽게 마무리한다.
  if (lines.length > 0) {
    const i = lines.length - 1;
    lines[i] = lines[i]
      .replace(/했으며,$/, "했습니다.")
      .replace(/늘었고,$/, "늘었습니다.")
      .replace(/줄었고,$/, "줄었습니다.")
      .replace(/이어졌으며,$/, "이어졌습니다.")
      .replace(/보였으며,$/, "보였습니다.");
  }

  return lines;
}

function analyzeElnChart1Insight(data: ElnReportData): string[] {
  return analyzeMonthlyTrendInsight(data.months, data.projects, data.chart1, "과제");
}

function analyzeElnChart2Insight(data: ElnReportData): string[] {
  return analyzeMonthlyTrendInsight(data.months, data.teams, data.chart2Monthly, "팀");
}

// ─ HTML 조립 ─────────────────────────────────────────────────────────────────

function buildBioElnReportHtml(
  titleDate:    string,
  today:        string,
  chart1Base64: string | null,
  chart2Base64: string | null,
  elnData:      ElnReportData | null,
  serviceRows:  ElnServiceRow[],
  svcLatestMonth: string,
): string {
  const latestLabel = elnData?.latestMonth
    ? formatMonthKorean(elnData.latestMonth)
    : titleDate;

  const svcLabel = svcLatestMonth ? formatMonthKorean(svcLatestMonth) : titleDate;

  const mkImg = (b64: string | null, alt: string) =>
    b64
      ? `<img src="data:image/png;base64,${b64}" alt="${alt}" style="width:100%;display:block;" />`
      : `<div class="placeholder-box">차트 생성 실패 — ELN_report.xlsx 파일을 확인하세요.</div>`;

  // 3페이지: IT서비스 진행 현황 표
  const svcTableBody = serviceRows.length > 0
    ? serviceRows.map((r, i) => `<tr class="${i % 2 === 1 ? "row-alt" : ""}">
        <td class="td-center td-nowrap">${escHtml(r.requestId)}</td>
        <td class="td-center td-nowrap">${escHtml(r.requestTeam)}</td>
        <td class="td-wrap">${escHtml(r.summary)}</td>
        <td class="td-center">${escHtml(r.serviceType)}</td>
        <td class="td-center td-nowrap">${escHtml(r.receptionDate)}</td>
        <td class="td-wrap">${escHtml(r.description)}</td>
        <td class="td-center">${escHtml(r.status)}</td>
      </tr>`).join("\n")
    : `<tr><td colspan="7" class="td-center" style="color:#9ca3af;padding:20px;">데이터 없음 — ELN_service.xlsx를 확인하세요.</td></tr>`;

  const page3Html = `
  <!-- 3페이지: IT서비스 진행 현황 -->
  <div class="page">
    <div class="page-header">
      <h2>${svcLabel} IT서비스 진행 현황</h2>
      <span class="pg">${titleDate}</span>
    </div>
    <table class="svc-table">
      <thead>
        <tr>
          <th style="width:7%">요청ID</th>
          <th style="width:9%">요청팀</th>
          <th style="width:20%">요청내용(요약)</th>
          <th style="width:14%">Hypercare/<br>Managed Service/<br>Support</th>
          <th style="width:9%">접수일</th>
          <th style="width:30%">Description</th>
          <th style="width:8%">처리유무</th>
        </tr>
      </thead>
      <tbody>${svcTableBody}</tbody>
    </table>
    <div class="footer">
      <span>SK Bioscience Bio연구본부 — 전자연구노트(ELN) 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>`;

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
    .page { break-before:page; padding:32px 44px 24px; }
    .page-header {
      display:flex; align-items:flex-end; justify-content:space-between;
      border-bottom:2.5px solid #0f2d55; padding-bottom:10px; margin-bottom:14px;
    }
    .page-header h2  { font-size:18px; font-weight:700; color:#0f2d55; }
    .page-header .pg { font-size:11px; color:#9ca3af; }
    .headline { font-size:12px; color:#374151; line-height:1.7; margin-bottom:14px; }
    .chart-block { margin-bottom:14px; }
    .chart-title {
      font-size:12px; font-weight:700; color:#0f2d55; margin-bottom:6px;
      padding:4px 10px; background:#f0f4ff; border-left:3px solid #4472C4;
    }
    .placeholder-box {
      border:2px dashed #cbd5e1; border-radius:8px; padding:24px;
      text-align:center; color:#9ca3af; font-size:11px; background:#f8fafc;
    }
    .insight-box {
      margin-top:8px; padding:10px 14px; background:#f0fdf4;
      border-left:3px solid #16a34a; border-radius:0 6px 6px 0;
      font-size:13.5px; line-height:1.7; color:#374151;
    }
    .insight-box .insight-label {
      font-weight:700; color:#15803d; font-size:13px; margin-bottom:6px;
    }
    .insight-box p { margin:0 0 5px; }
    .insight-box p:last-child { margin-bottom:0; }
    /* IT서비스 표 */
    .svc-table {
      width:100%; border-collapse:collapse; font-size:9.5px; table-layout:fixed;
    }
    .svc-table th {
      background:#0f2d55; color:#fff; padding:5px 4px; text-align:center;
      font-size:9px; font-weight:700; border:1px solid #1e3f72; line-height:1.3;
      word-break:keep-all;
    }
    .svc-table td {
      padding:4px 5px; border:1px solid #e5e7eb; vertical-align:top;
      font-size:9px; line-height:1.4; color:#374151;
    }
    .svc-table .row-alt td { background:#f8fafc; }
    .td-center  { text-align:center; }
    .td-nowrap  { white-space:nowrap; }
    .td-wrap    { word-break:break-all; }
    .footer {
      margin-top:14px; padding-top:10px; border-top:1px solid #e5e7eb;
      font-size:10px; color:#d1d5db; display:flex; justify-content:space-between;
    }
  </style>
</head>
<body>
  <!-- 표지 -->
  <div class="cover">
    <div class="cover-badge">SK Bioscience</div>
    <div class="cover-main">${titleDate}<br>Bio연구본부 전자연구노트(ELN) 운영 현황</div>
    <div class="cover-rule"></div>
    <div class="cover-date">작성일: ${today}</div>
  </div>

  <!-- 2페이지: ELN 사용현황 -->
  <div class="page">
    <div class="page-header">
      <h2>1. 전자연구노트(ELN) 사용현황</h2>
      <span class="pg">${titleDate}</span>
    </div>

    <div class="headline">
      <p>Bio연구본부에서 사용 중인 전자연구노트(ELN) 시스템 Report 입니다.</p>
    </div>

    <!-- Chart 1: 과제별 연구노트 생성 현황 -->
    <div class="chart-block">
      <div class="chart-title">과제별 연구노트 생성 현황</div>
      ${mkImg(chart1Base64, "과제별 연구노트 생성 현황")}
      ${elnData ? `<div class="insight-box">
        <div class="insight-label">데이터 인사이트 (최근 3개월 변화 분석)</div>
        ${analyzeElnChart1Insight(elnData).map((l) => `<p>${escHtml(l)}</p>`).join("")}
      </div>` : ""}
    </div>

    <div class="footer">
      <span>SK Bioscience Bio연구본부 — 전자연구노트(ELN) 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>

  <!-- 3페이지: 팀별 연구노트 생성 현황 (별도 페이지) -->
  <div class="page">
    <div class="page-header">
      <h2>${latestLabel} 팀별 연구노트 생성 현황</h2>
      <span class="pg">${titleDate}</span>
    </div>

    <div class="chart-block">
      <div class="chart-title">${latestLabel} 팀별 연구노트 생성 현황</div>
      ${mkImg(chart2Base64, "팀별 연구노트 생성 현황")}
      ${elnData ? `<div class="insight-box">
        <div class="insight-label">데이터 인사이트 (최근 3개월 변화 분석)</div>
        ${analyzeElnChart2Insight(elnData).map((l) => `<p>${escHtml(l)}</p>`).join("")}
      </div>` : ""}
    </div>

    <div class="footer">
      <span>SK Bioscience Bio연구본부 — 전자연구노트(ELN) 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>

  ${page3Html}
</body>
</html>`;
}

// ─ 공개 API ──────────────────────────────────────────────────────────────────

export async function generateBioElnReport(jobId: string): Promise<BioReportResult> {
  logger.info(`[BIO ELN Report] 보고서 생성 요청 — jobId: ${jobId}`);

  const uploadPath = path.resolve(process.env.UPLOAD_DIR ?? "uploads", jobId, "uploads");
  fs.mkdirSync(uploadPath, { recursive: true });

  const { year, month } = getLastMonth();
  const titleDate   = `${year}년 ${String(month).padStart(2, "0")}월`;
  const targetMonth = `${year}-${String(month).padStart(2, "0")}`;   // 보고서 대상 월 (M-1)
  const today       = new Date().toISOString().slice(0, 10);

  let chart1Base64: string | null = null;
  let chart2Base64: string | null = null;
  let elnData:      ElnReportData | null = null;
  let serviceRows:  ElnServiceRow[] = [];
  let svcLatestMonth = "";

  try {
    const elnRows = await query<{ stored_path: string }>(
      `SELECT stored_path FROM uploaded_files
       WHERE report_job_id = $1 AND original_name = 'ELN_report.xlsx'
       ORDER BY created_at DESC LIMIT 1`,
      [jobId]
    );

    if (elnRows.length && fs.existsSync(elnRows[0].stored_path)) {
      const elnPath = elnRows[0].stored_path;
      logger.info(`[BIO ELN Report] ELN_report.xlsx: ${elnPath}`);

      elnData = readElnReportData(elnPath);

      if (elnData.months.length > 0) {
        const c1Png = path.join(uploadPath, `eln_chart1_${Date.now()}.png`);
        await renderElnChart1ToPng(elnData, c1Png);
        if (fs.existsSync(c1Png)) {
          chart1Base64 = fs.readFileSync(c1Png).toString("base64");
        }
      }

      if (elnData.latestMonth && Object.keys(elnData.chart2).length > 0) {
        const c2Png = path.join(uploadPath, `eln_chart2_${Date.now()}.png`);
        await renderElnChart2ToPng(elnData, c2Png);
        if (fs.existsSync(c2Png)) {
          chart2Base64 = fs.readFileSync(c2Png).toString("base64");
        }
      }
    } else {
      logger.info("[BIO ELN Report] ELN_report.xlsx 없음 — 차트 생략");
    }
  } catch (e) {
    logger.error(`[BIO ELN Report] ELN_report 처리 실패 (무시): ${(e as Error).message}`);
  }

  try {
    const svcRows = await query<{ stored_path: string }>(
      `SELECT stored_path FROM uploaded_files
       WHERE report_job_id = $1 AND original_name = 'ELN_service.xlsx'
       ORDER BY created_at DESC LIMIT 1`,
      [jobId]
    );

    if (svcRows.length && fs.existsSync(svcRows[0].stored_path)) {
      const svcPath = svcRows[0].stored_path;
      logger.info(`[BIO ELN Report] ELN_service.xlsx: ${svcPath}`);
      const svcData = readElnServiceData(svcPath, targetMonth);
      serviceRows    = svcData.rows;
      svcLatestMonth = svcData.latestMonth;
      logger.info(`[BIO ELN Report] IT서비스 행 수: ${serviceRows.length}, 최근월: ${svcLatestMonth}`);
    } else {
      logger.info("[BIO ELN Report] ELN_service.xlsx 없음 — 3페이지 빈 테이블");
    }
  } catch (e) {
    logger.error(`[BIO ELN Report] ELN_service 처리 실패 (무시): ${(e as Error).message}`);
  }

  const html = buildBioElnReportHtml(titleDate, today, chart1Base64, chart2Base64, elnData, serviceRows, svcLatestMonth);

  const outputDir  = path.resolve(process.env.OUTPUT_DIR ?? "outputs");
  fs.mkdirSync(outputDir, { recursive: true });

  const mm         = String(month).padStart(2, "0");
  const filename   = `${year}.${mm} Bio연구본부 전자연구노트(ELN) 운영 현황 Report.pdf`;
  const outputPath = path.join(outputDir, filename);

  logger.info(`[BIO ELN Report] PDF 생성: ${outputPath}`);

  const result = await PdfGenerator.generate(html, outputPath, {
    format: "A4",
    margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
  });

  logger.info(`[BIO ELN Report] 완료 — ${result.pageCount}p, ${result.fileSize.toLocaleString()} bytes`);

  return {
    filePath:  result.filePath,
    filename,
    fileSize:  result.fileSize,
    pageCount: result.pageCount,
  };
}
