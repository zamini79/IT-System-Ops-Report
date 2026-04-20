/**
 * LHOUSE 보고서 생성 서비스
 *
 * ── 차트 데이터 읽기 ────────────────────────────────────────────────────────
 *  Activity.xlsx → Category 시트
 *    D2 / D3 / D4 : 시스템 구분 이름 (레이블) — SheetJS 직접 읽기
 *    E2 / E3 / E4 : 총 Task 실행 수 (값)     — 직접 계산 (캐시값 불신)
 *
 *  ── E2:E4 캐시값이 항상 0인 이유 ────────────────────────────────────────
 *  E2 = COUNTIF(Export!B:B, "eQMS")
 *  Export!B = LOOKUP(A, Category!A, Category!B)  ← 결과 텍스트여야 하나
 *             xlsx 저장 시 t:"n"(숫자) 타입으로 캐시됨
 *  → COUNTIF 가 문자열 "eQMS"를 찾지 못해 항상 0
 *  → SheetJS 는 공식을 재계산하지 않으므로 캐시값 0을 그대로 반환
 *
 *  ── 직접 계산 방법 ───────────────────────────────────────────────────────
 *  ① Category!A/B → Name→Category 매핑 테이블 구성 (SheetJS)
 *  ② Export 시트 XML 직접 파싱 → A열 inlineStr 추출 (54,488개)
 *     (SheetJS 는 inlineStr 셀을 정상 파싱 못해 행수 1로 반환)
 *  ③ D2/D3/D4 레이블 순서대로 카운트 → E2/E3/E4 값으로 사용
 */

import fs   from "fs";
import path from "path";
import { execSync } from "child_process";

import * as XLSX    from "xlsx";
import { chromium } from "playwright";
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const sharp = require("sharp") as (input: any, options?: any) => any;

import { AppError }     from "../../utils/errors";
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

// ── 텍스트 정규화 헬퍼 ───────────────────────────────────────────────────────

/** XML inlineStr 값의 HTML 엔티티를 디코드하고 공백을 정규화합니다. */
function normalizeXmlText(s: string): string {
  return s
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim()
    .replace(/\s+/g, " ");   // 이중 공백 → 단일 공백
}

/** 일반 문자열 정규화 (SheetJS 읽기값, 매핑 키 통일용) */
function normalizeText(s: string): string {
  return String(s).trim().replace(/\s+/g, " ");
}

// ── 차트 데이터 집계 ──────────────────────────────────────────────────────────

interface CategoryCounts {
  labels: string[];   // D2, D3, D4 값
  values: number[];   // 직접 계산한 카운트
  total:  number;     // 합계
}

/** 헤드라인 메시지에 들어갈 통계 수치 */
interface HeadlineStats {
  activeUsers:   number;   // #1 — 사용자 등록 현황 Active User 최신값
  uniqueLogin:   number;   // #2 — 일일 사용 현황 Unique Login 최신값
  totalTasks:    number;   // #3 — 전체 Task 수 (도넛 합계)
  eLmsTasks:     number;   // #4 — eLMS Task 수
  eDmsTasks:     number;   // #5 — eDMS Task 수
  newDocuments:  number;   // #6 — 해당 월 신규 등록 문서 수 (Mar값-Feb값) × 1000
  qualityEvents: number;   // #7 — 해당 월 Quality Event 발생 건수 (막대 합산)
  trainings:     number;   // #8 — 해당 월 교육 실행 건수 (N.Nk × 1000)
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
  const d = new Date((serial - 25569) * 86400 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function trunc(s: unknown, n: number): string {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + "\u2026" : str;
}

function formatMonthKorean(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  return `${y}년 ${m}월`;
}

/**
 * Excel LOOKUP 근사 매칭을 재현합니다.
 *
 * LOOKUP(target, sortedKeys, values) 는 정렬된 키 목록에서
 * target 보다 알파벳순으로 크지 않은 마지막 항목의 값을 반환합니다.
 * 정확히 일치하지 않아도 모든 행에 카테고리를 할당합니다.
 */
function lookupApprox(
  target: string,
  table:  Array<{ name: string; cat: string }>,  // name 기준 오름차순 정렬 필수
): string | null {
  let result: string | null = null;
  for (const entry of table) {
    if (entry.name.localeCompare(target) <= 0) result = entry.cat;
    else break;
  }
  return result;
}

/**
 * Category 시트 D2:D4 레이블을 읽고,
 * Export 시트 A열 전체를 파싱하여 Excel LOOKUP 근사 매칭으로
 * eQMS / eDMS / eLMS 건수를 집계합니다.
 *
 * ── 왜 직접 계산하는가 ────────────────────────────────────────────────────
 * E2 = COUNTIF(Export!B:B, "eQMS")
 * Export!B = LOOKUP(A, Category!A, Category!B)  ← 결과가 텍스트여야 하나
 *            xlsx 저장 시 t:"n"(숫자) 타입으로 캐시되어 항상 0 반환
 * → SheetJS 캐시값 사용 불가, 서버에서 LOOKUP 공식을 직접 재현
 *
 * ── HTML 엔티티 & 공백 정규화 ────────────────────────────────────────────
 * Export A열 XML 에 &amp; 등 HTML 엔티티와 이중 공백이 포함될 수 있음
 * → normalizeXmlText / normalizeText 로 통일하여 매핑 오류 방지
 *
 * ── LOOKUP 근사 매칭으로 전체 집계 ──────────────────────────────────────
 * Category A열에 없는 activity name 도 LOOKUP 이 가장 가까운 값으로 카테고리 반환
 * → 정확 매칭만 하면 일부 행 누락; 근사 매칭으로 전체 54,488건 카운트
 */
function readCategorySheet(xlsxPath: string): CategoryCounts {
  logger.info(`[LHOUSE] Category 집계 시작: ${xlsxPath}`);

  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets["Category"];

  if (!ws) {
    logger.error("[LHOUSE] Category 시트 없음. 존재 시트: " + JSON.stringify(wb.SheetNames));
    return { labels: ["eQMS", "eDMS", "eLMS"], values: [0, 0, 0], total: 0 };
  }

  // ── ① D2:D4 레이블 읽기 (SheetJS — 정상 동작) ───────────────────────────
  const labels = ["D2", "D3", "D4"].map((addr) => {
    const c = ws[addr];
    const v = c ? String(c.v ?? "").trim() : "";
    logger.info(`[LHOUSE] 셀 ${addr}: "${v}"`);
    return v;
  }).filter(Boolean);

  if (labels.length === 0) {
    logger.error("[LHOUSE] D2:D4 레이블 읽기 실패");
    return { labels: ["eQMS", "eDMS", "eLMS"], values: [0, 0, 0], total: 0 };
  }
  logger.info(`[LHOUSE] 레이블: ${JSON.stringify(labels)}`);

  // ── ② Category A/B → LOOKUP 테이블 구성 (알파벳 오름차순 정렬) ──────────
  //    Excel LOOKUP 근사 매칭은 정렬된 배열 필수
  const raw        = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
  const lookupTable = raw
    .slice(1)
    .map((row) => ({
      name: normalizeText(String((row as unknown[])[0] ?? "")),
      cat:  normalizeText(String((row as unknown[])[1] ?? "")),
    }))
    .filter((e) => e.name && e.cat)
    .sort((a, b) => a.name.localeCompare(b.name));

  logger.info(`[LHOUSE] LOOKUP 테이블: ${lookupTable.length}개 항목`);

  // ── ③ Export 시트 A열 XML 직접 파싱 (inlineStr, 54,488행) ────────────────
  //    SheetJS 는 inlineStr 타입 셀을 읽지 못해 행수 1로 반환하므로
  //    xlsx(ZIP) 에서 Export 시트 XML 을 꺼내 정규식으로 파싱합니다.
  const tmpDir = path.join(path.dirname(xlsxPath), `_tmp_${Date.now()}`);
  let   exportAValues: string[] = [];

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // workbook.xml + rels 로 Export 시트 XML 파일명 확인
    execSync(
      `unzip -j "${xlsxPath}" "xl/workbook.xml" "xl/_rels/workbook.xml.rels" -d "${tmpDir}" 2>/dev/null`,
      { stdio: "pipe" }
    );
    const wbXml   = fs.readFileSync(path.join(tmpDir, "workbook.xml"),     "utf-8");
    const relsXml = fs.readFileSync(path.join(tmpDir, "workbook.xml.rels"), "utf-8");

    const sheetMatch = wbXml.match(/name="Export"[^>]+r:id="(rId\d+)"/);
    const rId        = sheetMatch?.[1];
    logger.info(`[LHOUSE] Export 시트 rId: ${rId ?? "미발견"}`);

    if (rId) {
      const relMatch  = relsXml.match(new RegExp(`Id="${rId}"[^>]*Target="([^"]+)"`));
      const relTarget = relMatch?.[1];   // e.g. "worksheets/sheet2.xml"
      const xmlPath   = relTarget
        ? (relTarget.startsWith("xl/") ? relTarget : `xl/${relTarget}`)
        : null;
      logger.info(`[LHOUSE] Export XML 경로: ${xmlPath ?? "미발견"}`);

      if (xmlPath) {
        execSync(`unzip -j "${xlsxPath}" "${xmlPath}" -d "${tmpDir}" 2>/dev/null`, { stdio: "pipe" });
        const sheetXml = fs.readFileSync(path.join(tmpDir, path.basename(xmlPath)), "utf-8");
        logger.info(`[LHOUSE] Export XML 크기: ${sheetXml.length.toLocaleString()} bytes`);

        for (const m of sheetXml.matchAll(
          /<c r="A\d+"[^>]*t="inlineStr"[^>]*><is><t>(.*?)<\/t><\/is><\/c>/g
        )) {
          // HTML 엔티티 디코드 + 공백 정규화 (예: &amp; → &, 이중공백 → 단일공백)
          exportAValues.push(normalizeXmlText(m[1]));
        }
        logger.info(`[LHOUSE] Export A열 추출: ${exportAValues.length.toLocaleString()}건`);
      }
    }
  } catch (e) {
    logger.error(`[LHOUSE] Export XML 파싱 실패: ${(e as Error).message}`);
  } finally {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── ④ 레이블별 카운트 (LOOKUP 근사 매칭으로 전체 행 카운트) ───────────────
  //    정확 매칭이 아닌 LOOKUP 근사 매칭 사용 → 모든 행이 카운트됨
  const counts = new Map<string, number>(labels.map((l) => [l, 0]));
  let noMatch = 0;

  for (const name of exportAValues) {
    const cat = lookupApprox(name, lookupTable);
    if (cat && counts.has(cat)) {
      counts.set(cat, counts.get(cat)! + 1);
    } else {
      noMatch++;
    }
  }
  if (noMatch > 0) {
    logger.warn(`[LHOUSE] LOOKUP 결과가 레이블 외 카테고리인 행: ${noMatch}건`);
  }

  const values = labels.map((l) => counts.get(l) ?? 0);
  const total  = values.reduce((s, v) => s + v, 0);

  logger.info(`[LHOUSE] 집계 완료 — ${labels.map((l, i) => `${l}:${values[i]}`).join(", ")}, 합계:${total}`);
  return { labels, values, total };
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
      logger.info(`[LHOUSE] Chart.js 로컬 번들: ${p}`);
      return fs.readFileSync(p, "utf-8");
    }
  }
  logger.warn("[LHOUSE] Chart.js 로컬 번들 없음 — CDN 사용");
  return "";
}

// ── 도넛 차트 렌더링 ──────────────────────────────────────────────────────────

/**
 * 도넛 차트 요구사항:
 *  - 각 항목: 건수 + % 표시 (범례 테이블)
 *  - 도넛 중앙: 전체 Task 수
 *  - 범례: 시스템명 / 건수 / 비율
 */
async function renderDoughnutToPng(counts: CategoryCounts, outputPng: string): Promise<void> {
  const { labels, values, total } = counts;
  const allZero = total === 0;

  logger.info(`[LHOUSE] 도넛 렌더링 시작 — allZero: ${allZero}, labels: ${JSON.stringify(labels)}, values: ${JSON.stringify(values)}, total: ${total}`);

  const colorMap: Record<string, string> = {
    eQMS: "#4472C4",
    eDMS: "#ED7D31",
    eLMS: "#A9D18E",
  };
  const fallback = ["#4472C4", "#ED7D31", "#A9D18E", "#5B9BD5", "#FFC000"];
  const bgColors = labels.map((l, i) => colorMap[l] ?? fallback[i % fallback.length]);

  // 값이 모두 0이면 동일 크기 회색 도넛으로 형태 유지
  const displayValues = allZero ? labels.map(() => 1)        : values;
  const displayColors = allZero ? labels.map(() => "#e5e7eb") : bgColors;

  const chartJs = loadChartJsScript();
  const scriptTag = chartJs
    ? `<script>${chartJs}</script>`
    : `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>`;

  // 캔버스 500×500, layout.padding:105 → 차트영역 290px(반지름 145px)
  // callout 선 끝이 최대 ~190px → 캔버스 절반 250px → 여유 60px 확보 (텍스트 클리핑 방지)
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#fff; font-family:"Malgun Gothic",Arial,sans-serif; }

  #chart-container {
    width: 400px;
    height: 400px;
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* 도넛 + 중앙 텍스트 */
  .donut-wrap {
    position: relative;
    width: 400px; height: 400px;
    flex-shrink: 0;
  }
  canvas { display:block; }
  .center-label {
    position:absolute; top:50%; left:50%;
    transform:translate(-50%,-50%);
    text-align:center; pointer-events:none;
  }
  .center-label .num  { font-size:18px; font-weight:700; color:#111827; line-height:1.1; }
  .center-label .desc { font-size:9px; color:#6b7280; margin-top:3px; }
  .no-data { font-size:10px; color:#9ca3af; margin-top:6px; }
</style>
</head>
<body>
<div id="chart-container">
  <div class="donut-wrap">
    <canvas id="myChart" width="400" height="400"></canvas>
    <div class="center-label">
      <div class="num">${total.toLocaleString()}</div>
      <div class="desc">전체 Task 수</div>
    </div>
  </div>
  ${allZero ? '<p class="no-data">이번 달 실행된 Task 가 없습니다.</p>' : ""}
</div>

${scriptTag}
<script>
(function () {
  var ctx = document.getElementById('myChart').getContext('2d');
  if (!window.Chart) {
    ctx.font = '12px Arial'; ctx.fillStyle = '#ef4444';
    ctx.fillText('Chart.js 로드 실패', 10, 30);
    return;
  }

  /*
   * calloutPlugin: 세그먼트 외부에 꺾임 선 + 3줄 텍스트(이름/퍼센트/건수)
   *
   * 텍스트를 한 줄로 합치면 "28,450건 46.8%" → ~100px 폭으로 클리핑됨.
   * 3줄로 분리하면 최대 폭 ~50px → 캔버스 여유 60px 안에 안전하게 표시.
   */
  var calloutPlugin = {
    id: 'callout',
    afterDatasetsDraw: function(chart) {
      if (${allZero ? 'true' : 'false'}) return;
      var c    = chart.ctx;
      var ds   = chart.data.datasets[0];
      var meta = chart.getDatasetMeta(0);
      var tot  = ds.data.reduce(function(a, b) { return a + b; }, 0);
      if (tot === 0) return;

      meta.data.forEach(function(arc, i) {
        var val = ds.data[i];
        if (val === 0) return;
        var lbl = chart.data.labels[i];
        var pct = ((val / tot) * 100).toFixed(1) + '%';
        var cnt = val.toLocaleString() + '건';
        var mid = (arc.startAngle + arc.endAngle) / 2;
        var rx  = arc.outerRadius;
        var cx  = arc.x, cy = arc.y;

        /* 꺾임 선: 외곽 → +22px 사선 → +16px 수평 */
        var x0 = cx + Math.cos(mid) * rx;
        var y0 = cy + Math.sin(mid) * rx;
        var x1 = cx + Math.cos(mid) * (rx + 22);
        var y1 = cy + Math.sin(mid) * (rx + 22);
        var isRight = Math.cos(mid) >= 0;
        var x2 = x1 + (isRight ? 16 : -16);
        var y2 = y1;
        var tx = x2 + (isRight ? 4 : -4);

        c.save();
        c.strokeStyle = '#9ca3af';
        c.lineWidth   = 1;
        c.beginPath();
        c.moveTo(x0, y0);
        c.lineTo(x1, y1);
        c.lineTo(x2, y2);
        c.stroke();

        var align = isRight ? 'left' : 'right';
        c.textAlign = align;

        /* 줄 1: 시스템명 (굵게) */
        c.fillStyle    = '#1f2937';
        c.font         = 'bold 12px Arial';
        c.textBaseline = 'bottom';
        c.fillText(lbl, tx, y2 - 2);

        /* 줄 2: 퍼센트 */
        c.fillStyle    = '#374151';
        c.font         = '11px Arial';
        c.textBaseline = 'top';
        c.fillText(pct, tx, y2 + 2);

        /* 줄 3: 건수 */
        c.fillStyle    = '#6b7280';
        c.font         = '10px Arial';
        c.fillText(cnt, tx, y2 + 16);

        c.restore();
      });
    }
  };

  Chart.register(calloutPlugin);

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ${JSON.stringify(labels)},
      datasets: [{
        data: ${JSON.stringify(displayValues)},
        backgroundColor: ${JSON.stringify(displayColors)},
        borderWidth: 3,
        borderColor: '#fff',
        hoverOffset: 0,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      cutout: '58%',
      layout: { padding: 80 },
      plugins: {
        legend:  { display: false },
        tooltip: { enabled: false },
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
    await page.setViewportSize({ width: 400, height: 400 });
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(400);

    const loaded = await page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>).Chart !== "undefined"
    );
    logger.info(`[LHOUSE] Chart.js 로드: ${loaded ? "성공" : "실패"}`);

    const container = page.locator("#chart-container");
    await container.screenshot({ path: outputPng, type: "png" });

    const size = fs.statSync(outputPng).size;
    logger.info(`[LHOUSE] PNG 저장: ${outputPng} (${size.toLocaleString()} bytes)`);
  } finally {
    await browser.close();
  }
}

// ── 차트 이미지 생성 ──────────────────────────────────────────────────────────

async function generateChartPng(
  xlsxPath: string,
  outDir:   string,
): Promise<{ png: string | null; counts: CategoryCounts }> {
  fs.mkdirSync(outDir, { recursive: true });
  const outputPng = path.join(outDir, `chart_${Date.now()}.png`);
  const counts    = readCategorySheet(xlsxPath);
  try {
    await renderDoughnutToPng(counts, outputPng);
    return { png: outputPng, counts };
  } catch (e) {
    logger.error(`[LHOUSE] 차트 PNG 생성 실패: ${(e as Error).message}`);
    return { png: null, counts };
  }
}

// ── Systemusage.jpg 6분할 ────────────────────────────────────────────────────

/**
 * 차트 순서별 고정 제목 (1~6번)
 *   [0] 업무 활용 현황   — Systemusage 원본 "Activity (Task) Count"  (도넛으로 대체)
 *   [1] 문서 관리 현황   — Systemusage 원본 "Total Document"
 *   [2] 품질 관리 현황   — Systemusage 원본 "Quality Event"
 *   [3] 교육 관리 현황   — Systemusage 원본 "Training"
 *   [4] 사용자 등록 현황 — Systemusage 원본 "Active User"
 *   [5] 일일 사용 현황   — Systemusage 원본 "Unique Login"
 */
const CHART_TITLES = [
  "업무 활용 현황",   // 1번 (도넛)
  "문서 관리 현황",   // 2번
  "품질 관리 현황",   // 3번
  "교육 관리 현황",   // 4번
  "사용자 등록 현황", // 5번
  "일일 사용 현황",   // 6번
] as const;

/**
 * Systemusage.jpg (3열 × 2행 대시보드)를 6개 차트로 분리합니다.
 * 상단 제목 제거 없이 셀 전체 영역을 그대로 반환합니다.
 * (PDF 셀 제목은 HTML cell-title 로 별도 표시하므로 이미지 크롭 불필요)
 *
 * @returns base64 PNG 배열 (인덱스 0~5)
 */
async function splitSystemusageCharts(
  jpgPath: string,
  outDir:  string,
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });

  const meta = await sharp(jpgPath).metadata();
  const W = meta.width  ?? 1478;
  const H = meta.height ?? 960;

  const SRC_COLS = 3;
  const SRC_ROWS = 2;
  const cellW = Math.floor(W / SRC_COLS);
  const cellH = Math.floor(H / SRC_ROWS);

  logger.info(`[LHOUSE] Systemusage 분할 — 원본: ${W}×${H}, 셀: ${cellW}×${cellH}`);

  const base64List: string[] = [];

  for (let row = 0; row < SRC_ROWS; row++) {
    for (let col = 0; col < SRC_COLS; col++) {
      const idx    = row * SRC_COLS + col;
      const left   = col * cellW;
      const top    = row * cellH;
      const width  = (col === SRC_COLS - 1) ? W - left : cellW;
      const height = (row === SRC_ROWS - 1) ? H - top  : cellH;

      const chartPath = path.join(outDir, `systemusage_chart_${idx}.png`);
      await sharp(jpgPath)
        .extract({ left, top, width, height })  // 상단 제거 없이 셀 전체 추출
        .png()
        .toFile(chartPath);

      const base64 = fs.readFileSync(chartPath).toString("base64");
      const size   = fs.statSync(chartPath).size;
      logger.info(`[LHOUSE] 셀 ${idx} (${CHART_TITLES[idx] ?? ""}): ${chartPath} (${size.toLocaleString()} bytes)`);

      base64List.push(base64);
    }
  }

  return base64List;
}

// ── 차트 이미지 OCR — 오른쪽 막대 상단 숫자 추출 ────────────────────────────────

/**
 * 3개 막대 그래프 중 가장 오른쪽 막대의 상단 숫자를 OCR로 추출합니다.
 *
 * 차트 구조 기반 크롭 전략:
 *
 *  ┌─────────────────────────────────────┐
 *  │ Y │  bar1  │  bar2  │[ bar3 ][숫자]│  ← 크롭 대상: 우측 30% × 상단 72%
 *  │축 │        │        │              │
 *  │   │   n    │   n    │     [n]      │
 *  ├───┴────────┴────────┴──────────────┤
 *  │        X축 레이블 (월/년)           │  ← 제외
 *  └─────────────────────────────────────┘
 *
 *  1. 우측 30% × 상단 72%  크롭 → 3번째 막대 + 그 위 숫자 영역만 포함
 *  2. 4× 업스케일 + 그레이스케일 + 정규화 → OCR 정확도 향상
 *  3. PSM 7 (단일 텍스트 줄) — 막대 위 숫자 하나만 읽는 데 최적
 *  4. 인식된 단어 중 순수 숫자만 필터, 신뢰도 내림차순 → 최상위 값 반환
 */
async function extractRightmostChartValue(imagePath: string): Promise<number> {
  if (!fs.existsSync(imagePath)) {
    logger.warn(`[LHOUSE OCR] 파일 없음: ${imagePath}`);
    return 0;
  }

  const meta    = await sharp(imagePath).metadata();
  const W       = meta.width  ?? 500;
  const H       = meta.height ?? 400;
  const SCALE   = 4;

  // 오른쪽 막대 영역: 우측 30%, 상단 72%
  const cropLeft = Math.floor(W * 0.70);
  const cropW    = W - cropLeft;
  const cropH    = Math.floor(H * 0.72);

  const tmpPath = imagePath.replace(/\.png$/, "_ocr_tmp.png");

  try {
    await sharp(imagePath)
      .extract({ left: cropLeft, top: 0, width: cropW, height: cropH })
      .resize(cropW * SCALE, cropH * SCALE, { kernel: "lanczos3" })
      .greyscale()
      .normalize()
      .png()
      .toFile(tmpPath);

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const Tesseract = require("tesseract.js") as any;
    const worker    = await Tesseract.createWorker("eng");
    // PSM 3: auto — 크롭 영역에 숫자 하나만 있어 깔끔하게 인식됨
    // (PSM 7 은 data.words 가 undefined 로 반환되어 사용 불가)
    await worker.setParameters({ tessedit_pageseg_mode: "3" });
    const { data } = await worker.recognize(tmpPath);
    await worker.terminate();

    const rawText = (data.text ?? "").replace(/\s+/g, " ").trim();
    logger.info(`[LHOUSE OCR] ${path.basename(imagePath)} 인식 텍스트: "${rawText}"`);

    // 텍스트에서 숫자만 추출, 합리적 범위(1 ~ 999,999) 필터
    const numbers = (rawText.match(/\d+/g) ?? [])
      .map((s: string) => parseInt(s, 10))
      .filter((n: number) => !isNaN(n) && n > 0 && n < 1_000_000);

    logger.info(`[LHOUSE OCR] ${path.basename(imagePath)} 추출 숫자: ${JSON.stringify(numbers)}, 결과: ${numbers[0] ?? 0}`);

    return numbers[0] ?? 0;
  } catch (e) {
    logger.error(`[LHOUSE OCR] 실패 (${path.basename(imagePath)}): ${(e as Error).message}`);
    return 0;
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ── 차트 OCR — 신규 문서 수 (Total Document 라인 차트, 해당 월 - 전월) ──────────

/**
 * Total Document 라인 차트에서 가운데(직전 월)와 오른쪽(해당 월) 데이터 레이블을
 * 각각 타이트한 크롭으로 추출하여 신규 등록 문서 수를 계산합니다.
 *
 *  이미지 크기: 492 × 480  (실측)
 *
 *  데이터 레이블 위치 (차트 직접 확인):
 *   Jan "191k" ─ x≈162, y≈316   (이번 달 계산에 불필요)
 *   Feb "194k" ─ x≈265, y≈220   ← 직전 달 (가운데 점)
 *   Mar "197k" ─ x≈390, y≈113   ← 해당 달 (오른쪽 점)
 *
 *  전략:
 *   ① Mar 타이트 크롭 (left=370, top=88, w=120, h=75): "197k" → 197
 *   ② Feb 타이트 크롭 (left=240, top=188, w=125, h=75): "194k" → 194
 *   ③ newDocuments = (197 - 194) × 1000 = 3,000
 *
 *  참고: 이미지 해상도가 바뀌면 좌표 비율(W/H)로 자동 스케일링
 */
async function extractNewDocuments(imagePath: string): Promise<number> {
  if (!fs.existsSync(imagePath)) {
    logger.warn(`[LHOUSE OCR] 파일 없음: ${imagePath}`);
    return 0;
  }

  const meta  = await sharp(imagePath).metadata();
  const W     = meta.width  ?? 492;
  const H     = meta.height ?? 480;
  const SCALE = 4;

  /** 지정 영역을 크롭·업스케일 후 OCR 로 "N.Nk"/"Nk" 첫 번째 값을 반환합니다. */
  async function cropK(label: string, left: number, top: number, w: number, h: number): Promise<number> {
    // 원본 비율로 좌표 스케일 (기준 492×480)
    const sl = Math.floor(left * W / 492);
    const st = Math.floor(top  * H / 480);
    const sw = Math.min(Math.floor(w * W / 492), W - sl);
    const sh = Math.min(Math.floor(h * H / 480), H - st);

    const tmp = imagePath.replace(/\.png$/, `_ocr_doc_${label}.png`);
    try {
      await sharp(imagePath)
        .extract({ left: sl, top: st, width: sw, height: sh })
        .resize(sw * SCALE, sh * SCALE, { kernel: "lanczos3" })
        .greyscale()
        .normalize()
        .png()
        .toFile(tmp);

      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
      const Tesseract = require("tesseract.js") as any;
      const worker    = await Tesseract.createWorker("eng");
      await worker.setParameters({ tessedit_pageseg_mode: "3" });
      const { data } = await worker.recognize(tmp);
      await worker.terminate();

      const rawText = (data.text ?? "").replace(/\s+/g, " ").trim();
      logger.info(`[LHOUSE OCR] chart2(doc) ${label} 텍스트: "${rawText}"`);

      const kMatch = rawText.match(/(\d+\.?\d*)\s*k/i);
      if (kMatch) {
        const val = parseFloat(kMatch[1]);
        logger.info(`[LHOUSE OCR] chart2(doc) ${label} = ${val}k`);
        return val;
      }
      logger.warn(`[LHOUSE OCR] chart2(doc) ${label} k값 미발견`);
      return 0;
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  try {
    // ① 오른쪽(해당 월) Mar 크롭: x=370~490, y=88~163
    const marVal = await cropK("mar", 370, 88, 120, 75);
    // ② 가운데(직전 월) Feb 크롭: x=240~365, y=188~263
    const febVal = await cropK("feb", 240, 188, 125, 75);

    if (marVal === 0) {
      logger.warn("[LHOUSE OCR] chart2(doc) Mar 값 0 — 신규 문서 0 반환");
      return 0;
    }

    const newDocs = Math.max(0, Math.round((marVal - febVal) * 1000));
    logger.info(`[LHOUSE OCR] chart2(doc) Mar=${marVal}k, Feb=${febVal}k → 신규=${newDocs}`);
    return newDocs;
  } catch (e) {
    logger.error(`[LHOUSE OCR] chart2(doc) 실패: ${(e as Error).message}`);
    return 0;
  }
}

// ── 차트 OCR — Quality Event 합계 (해당 월 막대 값 합산) ─────────────────────────

/**
 * Quality Event 멀티 막대 차트에서 해당 월(가장 오른쪽 그룹) 막대 레이블을 합산합니다.
 *
 * 전략:
 *  - 우측 35% × 상단 85% 크롭 → 마지막 달 막대 + 레이블 영역만 포함
 *  - PSM 3 (auto) 으로 OCR
 *  - 2 이상 500 이하 정수만 합산 (연도·OCR 잡음 제거)
 */
async function extractQualityEvents(imagePath: string): Promise<number> {
  if (!fs.existsSync(imagePath)) {
    logger.warn(`[LHOUSE OCR] 파일 없음: ${imagePath}`);
    return 0;
  }

  const meta  = await sharp(imagePath).metadata();
  const W     = meta.width  ?? 494;
  const H     = meta.height ?? 480;
  const SCALE = 4;

  const cropLeft = Math.floor(W * 0.65);
  const cropW    = W - cropLeft;
  const cropH    = Math.floor(H * 0.85);

  const tmpPath = imagePath.replace(/\.png$/, "_ocr_qe_tmp.png");

  try {
    await sharp(imagePath)
      .extract({ left: cropLeft, top: 0, width: cropW, height: cropH })
      .resize(cropW * SCALE, cropH * SCALE, { kernel: "lanczos3" })
      .greyscale()
      .normalize()
      .png()
      .toFile(tmpPath);

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const Tesseract = require("tesseract.js") as any;
    const worker    = await Tesseract.createWorker("eng");
    await worker.setParameters({ tessedit_pageseg_mode: "3" });
    const { data } = await worker.recognize(tmpPath);
    await worker.terminate();

    const rawText = (data.text ?? "").replace(/\s+/g, " ").trim();
    logger.info(`[LHOUSE OCR] chart3(qe) 인식 텍스트: "${rawText}"`);

    // 막대 레이블: 2 이상 500 이하 정수 (연도·1 같은 잡음 제거)
    const numbers = (rawText.match(/\d+/g) ?? [])
      .map((s: string) => parseInt(s, 10))
      .filter((n: number) => !isNaN(n) && n >= 2 && n <= 500);

    const sum = numbers.reduce((a: number, b: number) => a + b, 0);
    logger.info(`[LHOUSE OCR] chart3(qe) 추출 숫자: ${JSON.stringify(numbers)}, 합계: ${sum}`);
    return sum;
  } catch (e) {
    logger.error(`[LHOUSE OCR] chart3(qe) 실패: ${(e as Error).message}`);
    return 0;
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ── 차트 OCR — 교육 실행 건수 (N.Nk 형식 파싱) ───────────────────────────────────

/**
 * Training 막대 차트에서 가장 오른쪽 막대 상단의 "N.Nk" 레이블을 읽어
 * 정수 건수로 변환합니다. (예: "28.1k" → 28,100)
 *
 * 전략:
 *  - extractRightmostChartValue 와 동일한 크롭 전략 (우측 30%, 상단 72%)
 *  - "N.Nk" 또는 "Nk" 패턴을 먼저 탐색 → × 1000 변환
 *  - 패턴 없으면 순수 정수 첫 번째 값 반환
 */
async function extractTrainingCount(imagePath: string): Promise<number> {
  if (!fs.existsSync(imagePath)) {
    logger.warn(`[LHOUSE OCR] 파일 없음: ${imagePath}`);
    return 0;
  }

  const meta  = await sharp(imagePath).metadata();
  const W     = meta.width  ?? 492;
  const H     = meta.height ?? 480;
  const SCALE = 4;

  const cropLeft = Math.floor(W * 0.70);
  const cropW    = W - cropLeft;
  const cropH    = Math.floor(H * 0.72);

  const tmpPath = imagePath.replace(/\.png$/, "_ocr_train_tmp.png");

  try {
    await sharp(imagePath)
      .extract({ left: cropLeft, top: 0, width: cropW, height: cropH })
      .resize(cropW * SCALE, cropH * SCALE, { kernel: "lanczos3" })
      .greyscale()
      .normalize()
      .png()
      .toFile(tmpPath);

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const Tesseract = require("tesseract.js") as any;
    const worker    = await Tesseract.createWorker("eng");
    await worker.setParameters({ tessedit_pageseg_mode: "3" });
    const { data } = await worker.recognize(tmpPath);
    await worker.terminate();

    const rawText = (data.text ?? "").replace(/\s+/g, " ").trim();
    logger.info(`[LHOUSE OCR] chart4(train) 인식 텍스트: "${rawText}"`);

    // 먼저 "N.Nk" 또는 "Nk" 패턴 시도
    const kMatch = rawText.match(/(\d+\.?\d*)\s*k/i);
    if (kMatch) {
      const val = Math.round(parseFloat(kMatch[1]) * 1000);
      logger.info(`[LHOUSE OCR] chart4(train) k값: "${kMatch[0]}" → ${val}`);
      return val;
    }

    // 폴백: 순수 정수 첫 번째
    const numbers = (rawText.match(/\d+/g) ?? [])
      .map((s: string) => parseInt(s, 10))
      .filter((n: number) => !isNaN(n) && n > 0 && n < 1_000_000);
    logger.info(`[LHOUSE OCR] chart4(train) 폴백 숫자: ${JSON.stringify(numbers)}`);
    return numbers[0] ?? 0;
  } catch (e) {
    logger.error(`[LHOUSE OCR] chart4(train) 실패: ${(e as Error).message}`);
    return 0;
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
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
      const h = [4, 6, 7, 8, 9, 10, 11, 12].map((i) => String(hdr[i] ?? "").trim());
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
      logger.warn(`[LHOUSE MS] ${sheetName}: SKB GMP 행 없음`);
      continue;
    }

    const gmpRow = rows[gmpRowIdx] as unknown[];
    chartRows.push({
      month:     sheetName,
      possible:  Number(gmpRow[1]) || 0,
      used:      Number(gmpRow[2]) || 0,
      remaining: Number(gmpRow[3]) || 0,
    });
    logger.info(`[LHOUSE MS] ${sheetName} SKB GMP — B:${gmpRow[1]}, C:${gmpRow[2]}, D:${gmpRow[3]}`);

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
      logger.info(`[LHOUSE MS] ${sheetName} 테이블 행: ${tableRows.length}개`);
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
    logger.info(`[LHOUSE MS] Chart.js 로드: ${loaded ? "성공" : "실패"}`);
    await page.locator("#wrap").screenshot({ path: outputPng, type: "png" });
    logger.info(`[LHOUSE MS] Bar chart PNG: ${outputPng} (${fs.statSync(outputPng).size.toLocaleString()} bytes)`);
  } finally {
    await browser.close();
  }
}

// ── PDF HTML 빌드 ─────────────────────────────────────────────────────────────

function buildReportHtml(
  titleDate:         string,
  chartImgBase64:    string | null,
  chartImgMime:      "image/png" | "image/jpeg",
  /** Systemusage.jpg 에서 분리한 6개 차트 base64 */
  usageCharts:       string[],
  stats:             HeadlineStats,
  msData?:           MsTimesheetData | null,
  msBarChartBase64?: string | null,
): string {
  // 셀 HTML 생성 헬퍼 — msg 가 있으면 이미지 위에 개별 헤드메시지 표시
  const makeCell = (no: number, title: string, imgHtml: string, msg?: string) =>
    `<div class="usage-cell">
       <div class="cell-title"><span class="cell-no">${no}</span>${title}</div>
       ${msg ? `<div class="cell-msg">${msg}</div>` : ""}
       ${imgHtml}
     </div>`;

  // ── "xx월" 형식 추출 (titleDate 에서, cellMsgs 보다 먼저 선언) ───────────────
  const monthLabel = titleDate.replace(/^\d+년\s*/, "");   // "03월"

  // ── 1번: 도넛 차트 ─────────────────────────────────────────────────────────
  const donutImgHtml = chartImgBase64
    ? `<div class="img-wrap"><img src="data:${chartImgMime};base64,${chartImgBase64}" alt="업무 활용 현황" /></div>`
    : `<div class="img-wrap" style="color:#9ca3af;font-size:12px;">차트 없음</div>`;

  // ── 차트별 개별 헤드메시지 ─────────────────────────────────────────────────
  const cellMsgs: Record<number, string> = {
    1: `${monthLabel} 총 실행된 Task는 <strong>${stats.totalTasks.toLocaleString()}</strong>건`,
    2: `${monthLabel} 약 <strong>${stats.newDocuments.toLocaleString()}</strong>개의 신규 문서 등록`,
    3: `${monthLabel} <strong>${stats.qualityEvents.toLocaleString()}</strong>건의 Quality Event 발생`,
    4: `${monthLabel} 약 <strong>${stats.trainings.toLocaleString()}</strong>건의 교육이 실행됨`,
    5: `신규 등록 포함 안동공장 Quality System 총 사용자는 <strong>${stats.activeUsers.toLocaleString()}</strong>명 등록`,
    6: `매일 평균 <strong>${stats.uniqueLogin.toLocaleString()}</strong>명 시스템 사용 중`,
  };

  // ── 6개 차트 전체 (2열 × 3행, 단일 페이지) ───────────────────────────────────
  const allCells: string[] = [
    makeCell(1, CHART_TITLES[0], donutImgHtml, cellMsgs[1]),
  ];
  for (let i = 1; i <= 5 && i < usageCharts.length; i++) {
    const title  = CHART_TITLES[i] ?? "";
    const cellNo = i + 1;
    allCells.push(makeCell(
      cellNo, title,
      `<div class="img-wrap"><img src="data:image/png;base64,${usageCharts[i]}" alt="${title}" /></div>`,
      cellMsgs[cellNo],
    ));
  }
  const grid = `<div class="usage-grid grid-3row">${allCells.join("\n")}</div>`;

  const today = new Date().toLocaleDateString("ko-KR", {
    year: "numeric", month: "long", day: "numeric",
  });

  // 헤드라인 메시지 — 숫자는 <strong> 강조
  const headlineHtml = `<div class="headline">
    ${titleDate} L HOUSE Veeva Quality System (eQMS / eDMS/eLMS)에 등록된 총 사용자 수는
    <strong>${stats.activeUsers.toLocaleString()}</strong>명이며,
    일 평균 <strong>${stats.uniqueLogin.toLocaleString()}</strong>명이 시스템에 접근하여 업무를 진행하였습니다.<br>
    ${monthLabel} 실행된 총 Task는 <strong>${stats.totalTasks.toLocaleString()}</strong>건이었으며
    교육 관련 Task가 <strong>${stats.eLmsTasks.toLocaleString()}</strong>건,
    문서 관련 Task가 <strong>${stats.eDmsTasks.toLocaleString()}</strong>건 실행되었습니다.
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

    .page { break-before:page; padding:36px 44px 28px; }
    .page-header {
      display:flex; align-items:flex-end; justify-content:space-between;
      border-bottom:2.5px solid #0f2d55; padding-bottom:10px; margin-bottom:20px;
    }
    .page-header h2  { font-size:18px; font-weight:700; color:#0f2d55; }
    .page-header .pg { font-size:11px; color:#9ca3af; }
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

    /* ── MS 진행 현황 페이지 ── */
    .ms-section { margin-bottom: 22px; }
    .ms-section-title {
      font-size: 13px; font-weight: 700; color: #0f2d55;
      margin-bottom: 8px; padding-bottom: 4px;
      border-bottom: 1px solid #cbd5e1;
    }
    .ms-chart-subtitle {
      font-size: 10px; color: #6b7280; margin-bottom: 10px;
    }
    .ms-chart-wrap {
      display: flex; justify-content: center; align-items: center;
      background: #fafbfc; border: 1px solid #e5e7eb; border-radius: 6px;
      padding: 12px 8px 8px;
    }
    .ms-chart-wrap img { max-width: 100%; height: auto; display: block; }
    .ms-table-title {
      font-size: 12px; font-weight: 700; color: #0f2d55; margin-bottom: 8px;
    }
    .ms-table {
      width: 100%; border-collapse: collapse; font-size: 9px;
    }
    .ms-table th {
      background: #0f2d55; color: #fff; font-weight: 600;
      padding: 5px 6px; text-align: center; white-space: nowrap;
      border: 1px solid #1a4a8a;
    }
    .ms-table td {
      padding: 4px 6px; border: 1px solid #e5e7eb;
      vertical-align: middle; color: #374151; word-break: break-all;
    }
    .ms-table tr:nth-child(even) td { background: #f8fafc; }
    .ms-table .td-center { text-align: center; }
    .ms-table .td-num    { text-align: right;  }
    .ms-table .td-nowrap { white-space: nowrap; text-align: center; }
    .ms-table .td-detail { word-break: break-word; }
    .ms-no-data { font-size: 11px; color: #9ca3af; text-align: center; padding: 20px; }

    /* 차트 아래 요약 표 */
    .ms-summary-wrap { margin-top: 8px; }
    .ms-summary-table {
      margin: 0 auto; border-collapse: collapse; font-size: 10px;
    }
    .ms-summary-table th {
      background: #4472C4; color: #fff; font-weight: 600;
      padding: 5px 18px; text-align: center;
      border: 1px solid #3563b0; white-space: nowrap;
    }
    .ms-summary-table td {
      padding: 4px 18px; border: 1px solid #e5e7eb;
      text-align: center; color: #374151; white-space: nowrap;
    }
    .ms-summary-table tr:nth-child(even) td { background: #f8fafc; }
  </style>
</head>
<body>
  <div class="cover">
    <div class="cover-badge">SK Bioscience</div>
    <div class="cover-main">${titleDate}<br>L HOUSE Veeva System 현황</div>
    <div class="cover-rule"></div>
    <div class="cover-date">작성일: ${today}</div>
  </div>

  <!-- ── 콘텐츠 페이지: 차트 1~6 (단일 페이지) ── -->
  <div class="page">
    <div class="page-header">
      <h2>1. Veeva 시스템 사용 현황</h2>
      <span class="pg">${titleDate}</span>
    </div>
    ${headlineHtml}
    ${grid}
    <p class="caption">[ ${titleDate} Veeva 시스템 사용 현황 ]</p>
    <div class="footer">
      <span>SK Bioscience L HOUSE 공장 — Veeva System 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>

  ${msData ? (() => {
    const latestLabel = msData.latestMonth ? formatMonthKorean(msData.latestMonth) : titleDate;

    // ── 섹션 1: 막대 차트 + 요약 표 ─────────────────────────────────────────
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
      <div class="ms-chart-subtitle">안동공장 Quality System Managed Service 현황</div>
      <div class="ms-chart-wrap">
        ${msBarChartBase64
          ? `<img src="data:image/png;base64,${msBarChartBase64}" alt="MS 현황 막대 차트" />`
          : `<div class="ms-no-data">차트 생성 실패</div>`}
      </div>
      ${msChartSummaryTable}
    </div>`;

    // ── 섹션 2: 테이블 (시간 열을 마지막으로, 날짜·상태는 nowrap) ───────────
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
      <span>SK Bioscience L HOUSE 공장 — Veeva System 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>`;
  })() : ""}
</body>
</html>`;
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

export interface LhouseReportResult {
  filePath:       string;
  filename:       string;
  fileSize:       number;
  pageCount:      number;
  chartImagePath: string | null;
}

export async function generateLhouseReport(jobId: string): Promise<LhouseReportResult> {
  const uploadDir       = process.env.UPLOAD_DIR ?? "uploads";
  const uploadPath      = path.resolve(uploadDir, jobId, "uploads");
  const activityPath    = path.join(uploadPath, "Activity_LHOUSE.xlsx");

  // Systemusage 는 jpg / png 모두 허용 — 업로드된 확장자에 따라 파일명이 다를 수 있음
  const systemusagePathJpg = path.join(uploadPath, "Systemusage_LHOUSE.jpg");
  const systemusagePathPng = path.join(uploadPath, "Systemusage_LHOUSE.png");
  const systemusagePath =
    fs.existsSync(systemusagePathJpg) ? systemusagePathJpg :
    fs.existsSync(systemusagePathPng) ? systemusagePathPng :
    systemusagePathJpg; // 둘 다 없으면 jpg 경로로 설정 (이후 존재 체크에서 에러)

  logger.info(`[LHOUSE Report] 보고서 생성 요청 — jobId: ${jobId}`);
  logger.info(`[LHOUSE Report] Activity_LHOUSE.xlsx : ${activityPath} (존재: ${fs.existsSync(activityPath)})`);
  logger.info(`[LHOUSE Report] Systemusage_LHOUSE.*  : ${systemusagePath} (존재: ${fs.existsSync(systemusagePath)})`);

  if (!fs.existsSync(activityPath))    throw new AppError(400, "Activity_LHOUSE.xlsx 파일이 없습니다. 먼저 업로드해주세요.");
  if (!fs.existsSync(systemusagePath)) throw new AppError(400, "Systemusage_LHOUSE.jpg / .png 파일이 없습니다. 먼저 업로드해주세요.");

  // 1) 도넛 차트 PNG + CategoryCounts (#3 #4 #5 데이터)
  logger.info("[LHOUSE Report] ── 차트 생성 ──");
  const { png: chartPng, counts } = await generateChartPng(activityPath, uploadPath);
  if (!chartPng) logger.warn("[LHOUSE Report] 차트 이미지 생성 실패 — PDF 에 대체 텍스트 표시");
  else logger.info(`[LHOUSE Report] 차트 PNG: ${chartPng} (${fs.statSync(chartPng).size.toLocaleString()} bytes)`);

  // 2) base64
  let chartBase64: string | null              = null;
  let chartMime:   "image/png" | "image/jpeg" = "image/png";
  if (chartPng && fs.existsSync(chartPng)) {
    chartBase64 = fs.readFileSync(chartPng).toString("base64");
    chartMime   = /\.jpe?g$/i.test(chartPng) ? "image/jpeg" : "image/png";
  }

  // 2-b) Systemusage.jpg → 6개 차트 분리
  logger.info("[LHOUSE Report] ── Systemusage 분할 ──");
  const usageCharts = await splitSystemusageCharts(systemusagePath, uploadPath);
  logger.info(`[LHOUSE Report] 분할 차트 수: ${usageCharts.length}`);

  // 2-c) OCR — 6개 차트 이미지에서 통계 수치 추출
  logger.info("[LHOUSE Report] ── OCR 추출 ──");
  const chart2Path = path.join(uploadPath, "systemusage_chart_1.png");  // Total Document
  const chart3Path = path.join(uploadPath, "systemusage_chart_2.png");  // Quality Event
  const chart4Path = path.join(uploadPath, "systemusage_chart_3.png");  // Training
  const chart5Path = path.join(uploadPath, "systemusage_chart_4.png");  // Active User
  const chart6Path = path.join(uploadPath, "systemusage_chart_5.png");  // Unique Login

  const [activeUsers, uniqueLogin, newDocuments, qualityEvents, trainings] = await Promise.all([
    extractRightmostChartValue(chart5Path),   // #1
    extractRightmostChartValue(chart6Path),   // #2
    extractNewDocuments(chart2Path),           // #6
    extractQualityEvents(chart3Path),          // #7
    extractTrainingCount(chart4Path),          // #8
  ]);
  logger.info(
    `[LHOUSE Report] OCR 결과 — activeUsers:${activeUsers}, uniqueLogin:${uniqueLogin}, ` +
    `newDocuments:${newDocuments}, qualityEvents:${qualityEvents}, trainings:${trainings}`,
  );

  // 2-d) #3 #4 #5 — Activity.xlsx counts 에서 추출
  const findCount = (keyword: string) => {
    const idx = counts.labels.findIndex((l) => l.toLowerCase().includes(keyword.toLowerCase()));
    return idx >= 0 ? counts.values[idx] : 0;
  };
  const stats: HeadlineStats = {
    activeUsers,
    uniqueLogin,
    totalTasks:    counts.total,
    eLmsTasks:     findCount("eLMS"),
    eDmsTasks:     findCount("eDMS"),
    newDocuments,
    qualityEvents,
    trainings,
  };
  logger.info(`[LHOUSE Report] 헤드라인 통계: ${JSON.stringify(stats)}`);

  // 3) MS Timesheet — 최신 파일을 DB 에서 찾아 읽기 (파일 없으면 스킵)
  let msData:          MsTimesheetData | null = null;
  let msBarChartBase64: string | null         = null;

  try {
    const tsRows = await query<{ stored_path: string }>(
      `SELECT stored_path FROM uploaded_files
       WHERE original_name = 'SKB_Quallity_MS_Timesheet.xlsx'
       ORDER BY created_at DESC LIMIT 1`,
      []
    );

    if (tsRows.length && fs.existsSync(tsRows[0].stored_path)) {
      const tsPath = tsRows[0].stored_path;
      logger.info(`[LHOUSE Report] Timesheet 파일: ${tsPath}`);

      msData = readMsTimesheetData(tsPath);

      if (msData.chartRows.length > 0) {
        const msChartPng = path.join(uploadPath, `ms_barchart_${Date.now()}.png`);
        await renderMsBarChartToPng(msData.chartRows, msChartPng);
        if (fs.existsSync(msChartPng)) {
          msBarChartBase64 = fs.readFileSync(msChartPng).toString("base64");
        }
      } else {
        logger.warn("[LHOUSE Report] Timesheet 에서 YYYY-MM 시트 데이터 없음 — MS 페이지 스킵");
        msData = null;
      }
    } else {
      logger.info("[LHOUSE Report] Timesheet 파일 없음 — MS 페이지 생략");
    }
  } catch (e) {
    logger.error(`[LHOUSE Report] Timesheet 처리 실패 (무시): ${(e as Error).message}`);
    msData = null;
  }

  // 4) PDF
  const { year, month } = getLastMonth();
  const titleDate  = `${year}년 ${String(month).padStart(2, "0")}월`;
  const html       = buildReportHtml(titleDate, chartBase64, chartMime, usageCharts, stats, msData, msBarChartBase64);
  const outputDir  = path.resolve(process.env.OUTPUT_DIR ?? "outputs");
  fs.mkdirSync(outputDir, { recursive: true });
  const filename   = `${year}.${String(month).padStart(2, "0")} L HOUSE Veeva System Report.pdf`;
  const outputPath = path.join(outputDir, filename);

  logger.info(`[LHOUSE Report] PDF 생성: ${outputPath}`);
  const result = await PdfGenerator.generate(html, outputPath, {
    format: "A4",
    margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
  });

  logger.info(`[LHOUSE Report] 완료 — ${result.pageCount}p, ${result.fileSize.toLocaleString()} bytes`);
  return {
    filePath:       result.filePath,
    filename,
    fileSize:       result.fileSize,
    pageCount:      result.pageCount,
    chartImagePath: chartPng,
  };
}
