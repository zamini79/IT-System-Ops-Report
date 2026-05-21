/**
 * DEV (개발본부) 보고서 생성 서비스
 *
 * 페이지 구성:
 *  - 표지  : "개발본부 시스템 운영 현황"
 *  - Page 1: "1. GCP Quality System (eDMS / eQMS / eLMS)" — 이미지 6개 그리드
 *  - Page 2: "2. Medical contents management System (Medcomms)" — 이미지 6개 그리드
 *  - Page 3: "3. Clinical trial management System (CTMS / eTMF)"
 *            — 좌우 2개 + 하단 가로 1개
 *  - Page 4: "4. Managed Service 진행 현황"
 *            — SKB Clinical / SKB GCP / Medcomms 3개 그룹 차트 + 테이블
 */

import fs   from "fs";
import path from "path";
import { execSync } from "child_process";

import * as XLSX    from "xlsx";
import { chromium } from "playwright";
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const sharp = require("sharp") as (input: any, options?: any) => any;

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

// ── 차트 제목 ─────────────────────────────────────────────────────────────────

const GCP_CHART_TITLES = [
  "업무 활용 현황",
  "문서 관리 현황",
  "품질 관리 현황",
  "교육 관리 현황",
  "사용자 등록 현황",
  "일일 사용 현황",
] as const;

const MEDCOMMS_CHART_TITLES = [
  "Medcomms 사용자 현황",
  "Medcomms 일일 사용 현황",
  "Medcomms 생성 문서 구분",
  "Medcomms 문서 관리 현황",
  "Medcomms 업무 활용 현황",
  "Medcomms 월 별 문서 리뷰 시간",
] as const;

const CTMS_CHART_TITLES = [
  "CTMS, eTMF 사용자 현황",
  "CTMS, eTMF 일일 사용자 현황",
  "CTMS, eTMF - Study별 사용자 현황",
] as const;

// ── MS Timesheet 데이터 구조 ─────────────────────────────────────────────────

const DEV_MS_GROUP_NAMES = ["SKB Clinical", "SKB GCP", "Medcomms"] as const;

interface GcpStats {
  newDocuments: number;  // chart 2 OCR — 신규 문서 수
  deviation:    number;  // chart 3 OCR — Deviation 건수
  finding:      number;  // chart 3 OCR — Finding 건수
  trainings:    number;  // chart 4 OCR — 교육 실행 건수
  activeUsers:  number;  // chart 5 OCR — 사용자 등록 현황 (오른쪽 막대)
  uniqueLogin:  number;  // chart 6 OCR — 일일 사용 현황 (오른쪽 막대)
}

interface MedcommsStats {
  activeUsers:  number;  // chart 1 OCR — 사용자 현황 (오른쪽 막대)
  uniqueLogin:  number;  // chart 2 OCR — 일일 사용 현황 (오른쪽 막대)
  topDocType:   { name: string; count: number };  // chart 3 OCR — 가장 많은 문서 구분
  newDocuments: number;  // chart 4 OCR — 신규 문서 (오른쪽 - 가운데)
  taskTotal:    number;  // chart 5 OCR — Task 합계
  recordCount:  number;  // chart 6 OCR — Record Count (해당 월)
  timeInReview: number;  // chart 6 OCR — Time in Review (해당 월)
}

interface MsChartRow {
  month:     string;  // e.g. "2026-03"
  possible:  number;  // B열 = 가능 MS
  used:      number;  // C열 = 사용 MS
  remaining: number;  // D열 = 잔여 MS
}

interface MsTableRow {
  hours:     string;
  system:    string;
  category:  string;
  subject:   string;
  detail:    string;
  startDate: string;
  endDate:   string;
  status:    string;
}

interface DevMsGroupData {
  groupName:  string;
  chartRows:  MsChartRow[];
  tableRows:  MsTableRow[];
}

interface DevMsTimesheetData {
  groups:      DevMsGroupData[];
  latestMonth: string;
  colHeaders:  string[];
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

function formatMonthKorean(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  return `${y}년 ${m}월`;
}

// ── Activity.xlsx 도넛 차트 데이터 구조 ──────────────────────────────────────

interface CategoryCounts {
  labels: string[];   // D2, D3, D4 값 (e.g. eQMS / eDMS / eLMS)
  values: number[];   // 직접 계산한 카운트
  total:  number;
}

/** XML inlineStr 디코드 + 공백 정규화 */
function normalizeXmlText(s: string): string {
  return s
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeText(s: string): string {
  return String(s).trim().replace(/\s+/g, " ");
}

/**
 * Excel LOOKUP 근사 매칭 (정렬된 테이블 필수).
 * target 보다 알파벳순으로 크지 않은 마지막 항목의 카테고리를 반환합니다.
 */
function lookupApprox(
  target: string,
  table:  Array<{ name: string; cat: string }>,
): string | null {
  let result: string | null = null;
  for (const entry of table) {
    if (entry.name.localeCompare(target) <= 0) result = entry.cat;
    else break;
  }
  return result;
}

/**
 * Activity_GCP.xlsx — Category 시트에서 레이블(D2:D4) 읽기 + Export 시트 A열
 * XML 직접 파싱 → LOOKUP 근사 매칭으로 eQMS / eDMS / eLMS 건수 집계.
 * (LHOUSE의 readCategorySheet 와 동일한 방식)
 */
function readGcpCategorySheet(xlsxPath: string): CategoryCounts {
  logger.info(`[DEV Report] Category 집계 시작: ${xlsxPath}`);

  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets["Category"];

  if (!ws) {
    logger.error("[DEV Report] Category 시트 없음. 시트 목록: " + JSON.stringify(wb.SheetNames));
    return { labels: ["eQMS", "eDMS", "eLMS"], values: [0, 0, 0], total: 0 };
  }

  // ① D2:D4 레이블 읽기
  const labels = ["D2", "D3", "D4"].map((addr) => {
    const c = ws[addr];
    const v = c ? String(c.v ?? "").trim() : "";
    logger.info(`[DEV Report] 셀 ${addr}: "${v}"`);
    return v;
  }).filter(Boolean);

  if (labels.length === 0) {
    logger.error("[DEV Report] D2:D4 레이블 읽기 실패");
    return { labels: ["eQMS", "eDMS", "eLMS"], values: [0, 0, 0], total: 0 };
  }
  logger.info(`[DEV Report] 레이블: ${JSON.stringify(labels)}`);

  // ② Category A/B → LOOKUP 테이블 구성 (오름차순 정렬)
  const raw         = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
  const lookupTable = raw
    .slice(1)
    .map((row) => ({
      name: normalizeText(String((row as unknown[])[0] ?? "")),
      cat:  normalizeText(String((row as unknown[])[1] ?? "")),
    }))
    .filter((e) => e.name && e.cat)
    .sort((a, b) => a.name.localeCompare(b.name));
  logger.info(`[DEV Report] LOOKUP 테이블: ${lookupTable.length}개 항목`);

  // ③ Export 시트 A열 XML 직접 파싱 (inlineStr)
  const tmpDir = path.join(path.dirname(xlsxPath), `_tmp_dev_${Date.now()}`);
  let   exportAValues: string[] = [];

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(
      `unzip -j "${xlsxPath}" "xl/workbook.xml" "xl/_rels/workbook.xml.rels" -d "${tmpDir}" 2>/dev/null`,
      { stdio: "pipe" }
    );
    const wbXml   = fs.readFileSync(path.join(tmpDir, "workbook.xml"),      "utf-8");
    const relsXml = fs.readFileSync(path.join(tmpDir, "workbook.xml.rels"), "utf-8");

    const sheetMatch = wbXml.match(/name="Export"[^>]+r:id="(rId\d+)"/);
    const rId        = sheetMatch?.[1];
    logger.info(`[DEV Report] Export 시트 rId: ${rId ?? "미발견"}`);

    if (rId) {
      const relMatch  = relsXml.match(new RegExp(`Id="${rId}"[^>]*Target="([^"]+)"`));
      const relTarget = relMatch?.[1];
      const xmlPath   = relTarget
        ? (relTarget.startsWith("xl/") ? relTarget : `xl/${relTarget}`)
        : null;
      logger.info(`[DEV Report] Export XML 경로: ${xmlPath ?? "미발견"}`);

      if (xmlPath) {
        execSync(`unzip -j "${xlsxPath}" "${xmlPath}" -d "${tmpDir}" 2>/dev/null`, { stdio: "pipe" });
        const sheetXml = fs.readFileSync(path.join(tmpDir, path.basename(xmlPath)), "utf-8");
        logger.info(`[DEV Report] Export XML 크기: ${sheetXml.length.toLocaleString()} bytes`);

        for (const m of sheetXml.matchAll(
          /<c r="A\d+"[^>]*t="inlineStr"[^>]*><is><t>(.*?)<\/t><\/is><\/c>/g
        )) {
          exportAValues.push(normalizeXmlText(m[1]));
        }
        logger.info(`[DEV Report] Export A열 추출: ${exportAValues.length.toLocaleString()}건`);
      }
    }
  } catch (e) {
    logger.error(`[DEV Report] Export XML 파싱 실패: ${(e as Error).message}`);
  } finally {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ④ LOOKUP 근사 매칭으로 레이블별 카운트
  const counts  = new Map<string, number>(labels.map((l) => [l, 0]));
  let noMatch = 0;
  for (const name of exportAValues) {
    const cat = lookupApprox(name, lookupTable);
    if (cat && counts.has(cat)) counts.set(cat, counts.get(cat)! + 1);
    else noMatch++;
  }
  if (noMatch > 0) logger.warn(`[DEV Report] LOOKUP 외 카테고리: ${noMatch}건`);

  const values = labels.map((l) => counts.get(l) ?? 0);
  const total  = values.reduce((s, v) => s + v, 0);
  logger.info(`[DEV Report] 집계 완료 — ${labels.map((l, i) => `${l}:${values[i]}`).join(", ")}, 합계:${total}`);
  return { labels, values, total };
}

/**
 * CategoryCounts 데이터를 도넛 차트 PNG 로 렌더링합니다.
 * LHOUSE renderDoughnutToPng 와 동일한 스타일.
 */
async function renderGcpDoughnutToPng(counts: CategoryCounts, outputPng: string): Promise<void> {
  const { labels, values, total } = counts;
  const allZero = total === 0;

  const colorMap: Record<string, string> = {
    eQMS: "#4472C4",
    eDMS: "#ED7D31",
    eLMS: "#A9D18E",
  };
  const fallback     = ["#4472C4", "#ED7D31", "#A9D18E", "#5B9BD5", "#FFC000"];
  const bgColors     = labels.map((l, i) => colorMap[l] ?? fallback[i % fallback.length]);
  const displayValues = allZero ? labels.map(() => 1)         : values;
  const displayColors = allZero ? labels.map(() => "#e5e7eb") : bgColors;

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
  #chart-container {
    width:400px; height:400px; background:#fff;
    display:flex; align-items:center; justify-content:center;
  }
  .donut-wrap { position:relative; width:400px; height:400px; flex-shrink:0; }
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
(function() {
  var ctx = document.getElementById('myChart').getContext('2d');
  if (!window.Chart) { ctx.font='12px Arial'; ctx.fillStyle='#ef4444'; ctx.fillText('Chart.js 로드 실패',10,30); return; }
  var calloutPlugin = {
    id: 'callout',
    afterDatasetsDraw: function(chart) {
      if (${allZero ? 'true' : 'false'}) return;
      var c=chart.ctx, ds=chart.data.datasets[0], meta=chart.getDatasetMeta(0);
      var tot=ds.data.reduce(function(a,b){return a+b;},0);
      if(tot===0) return;
      meta.data.forEach(function(arc,i){
        var val=ds.data[i]; if(val===0) return;
        var lbl=chart.data.labels[i];
        var pct=((val/tot)*100).toFixed(1)+'%';
        var cnt=val.toLocaleString()+'건';
        var mid=(arc.startAngle+arc.endAngle)/2;
        var rx=arc.outerRadius, cx=arc.x, cy=arc.y;
        var x0=cx+Math.cos(mid)*rx, y0=cy+Math.sin(mid)*rx;
        var x1=cx+Math.cos(mid)*(rx+22), y1=cy+Math.sin(mid)*(rx+22);
        var isRight=Math.cos(mid)>=0;
        var x2=x1+(isRight?16:-16), y2=y1;
        var tx=x2+(isRight?4:-4);
        c.save();
        c.strokeStyle='#9ca3af'; c.lineWidth=1;
        c.beginPath(); c.moveTo(x0,y0); c.lineTo(x1,y1); c.lineTo(x2,y2); c.stroke();
        var align=isRight?'left':'right'; c.textAlign=align;
        c.fillStyle='#1f2937'; c.font='bold 12px Arial'; c.textBaseline='bottom'; c.fillText(lbl,tx,y2-2);
        c.fillStyle='#374151'; c.font='11px Arial'; c.textBaseline='top'; c.fillText(pct,tx,y2+2);
        c.fillStyle='#6b7280'; c.font='10px Arial'; c.fillText(cnt,tx,y2+16);
        c.restore();
      });
    }
  };
  Chart.register(calloutPlugin);
  new Chart(ctx, {
    type:'doughnut',
    data:{
      labels:${JSON.stringify(labels)},
      datasets:[{
        data:${JSON.stringify(displayValues)},
        backgroundColor:${JSON.stringify(displayColors)},
        borderWidth:3, borderColor:'#fff', hoverOffset:0,
      }],
    },
    options:{
      responsive:false, animation:false, cutout:'58%',
      layout:{padding:80},
      plugins:{ legend:{display:false}, tooltip:{enabled:false} },
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
    logger.info(`[DEV Report] 도넛 Chart.js 로드: ${loaded ? "성공" : "실패"}`);
    const container = page.locator("#chart-container");
    await container.screenshot({ path: outputPng, type: "png" });
    logger.info(`[DEV Report] 도넛 PNG: ${outputPng} (${fs.statSync(outputPng).size.toLocaleString()} bytes)`);
  } finally {
    await browser.close();
  }
}

async function generateGcpChartPng(
  xlsxPath: string,
  outDir:   string,
): Promise<{ png: string | null; counts: CategoryCounts }> {
  fs.mkdirSync(outDir, { recursive: true });
  const outputPng = path.join(outDir, `gcp_donut_${Date.now()}.png`);
  const counts    = readGcpCategorySheet(xlsxPath);
  try {
    await renderGcpDoughnutToPng(counts, outputPng);
    return { png: outputPng, counts };
  } catch (e) {
    logger.error(`[DEV Report] 도넛 PNG 생성 실패: ${(e as Error).message}`);
    return { png: null, counts };
  }
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
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  }
  logger.warn("[DEV Report] Chart.js 로컬 번들 없음 — CDN 사용");
  return "";
}

// ── 이미지 헬퍼 ──────────────────────────────────────────────────────────────

type ChartImg = { base64: string; mime: "image/png" };

/** 업로드 경로에서 지정 파일명의 실제 경로 탐색 (.jpg / .jpeg / .png 순서) */
function resolveImagePath(dir: string, baseName: string): string | null {
  for (const ext of [".jpg", ".jpeg", ".png"]) {
    const p = path.join(dir, baseName + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 대시보드 이미지를 3열×2행(6개)으로 분할합니다.
 * GCP / Medcomms 페이지에 사용 (LHOUSE 와 동일한 분할 방식).
 */
async function split6Charts(
  imgPath: string,
  prefix:  string,
  outDir:  string,
): Promise<ChartImg[]> {
  fs.mkdirSync(outDir, { recursive: true });

  const meta = await sharp(imgPath).metadata();
  const W    = (meta.width  as number) ?? 1478;
  const H    = (meta.height as number) ?? 960;
  const COLS = 3, ROWS = 2;
  const cellW = Math.floor(W / COLS);
  const cellH = Math.floor(H / ROWS);

  logger.info(`[DEV Report] ${prefix} 분할 — 원본: ${W}×${H}, 셀: ${cellW}×${cellH}`);

  const results: ChartImg[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const idx    = row * COLS + col;
      const left   = col * cellW;
      const top    = row * cellH;
      const width  = col === COLS - 1 ? W - left : cellW;
      const height = row === ROWS - 1 ? H - top  : cellH;
      const out    = path.join(outDir, `${prefix}_split_${idx}.png`);
      await sharp(imgPath).extract({ left, top, width, height }).png().toFile(out);
      results.push({ base64: fs.readFileSync(out).toString("base64"), mime: "image/png" });
      logger.info(`[DEV Report] ${prefix} 셀 ${idx}: ${out} (${fs.statSync(out).size.toLocaleString()} B)`);
    }
  }
  return results;
}

/**
 * CTMS 대시보드 이미지를 3개 영역으로 분할합니다.
 *   chart1 = 상단 좌 (width/2 × height/2)
 *   chart2 = 상단 우 (width/2 × height/2)
 *   chart3 = 하단 전폭 (width × height/2)
 */
async function split3Charts(
  imgPath: string,
  outDir:  string,
): Promise<ChartImg[]> {
  fs.mkdirSync(outDir, { recursive: true });

  const meta  = await sharp(imgPath).metadata();
  const W     = (meta.width  as number) ?? 1000;
  const H     = (meta.height as number) ?? 800;
  const halfW = Math.floor(W / 2);
  const halfH = Math.floor(H / 2);

  logger.info(`[DEV Report] CTMS 분할 — 원본: ${W}×${H}`);

  const regions = [
    { left: 0,     top: 0,     width: halfW,    height: halfH,     label: "top-left"  },
    { left: halfW, top: 0,     width: W - halfW, height: halfH,    label: "top-right" },
    { left: 0,     top: halfH, width: W,         height: H - halfH, label: "bottom"   },
  ];

  const results: ChartImg[] = [];
  for (let i = 0; i < regions.length; i++) {
    const { label, ...region } = regions[i];
    const out = path.join(outDir, `ctms_split_${i}.png`);
    await sharp(imgPath).extract(region).png().toFile(out);
    results.push({ base64: fs.readFileSync(out).toString("base64"), mime: "image/png" });
    logger.info(`[DEV Report] CTMS 셀 ${i} (${label}): ${out} (${fs.statSync(out).size.toLocaleString()} B)`);
  }
  return results;
}

// ── GCP 차트 OCR 함수 ─────────────────────────────────────────────────────────

/**
 * OCR 공통 헬퍼 — 크롭 → 업스케일 → 전처리 → Tesseract 인식 → 텍스트 반환
 *
 * @param mode  "norm"   : normalize + sharpen  (밝기 편차가 큰 이미지)
 *              "thresh" : threshold(180)        (단순 흑백 — 고대비 레이블에 최적)
 */
async function ocrCrop(
  imagePath: string,
  region: { left: number; top: number; width: number; height: number },
  scale: number,
  psm: string,
  mode: "norm" | "thresh",
  tmpSuffix: string,
): Promise<string> {
  const tmp = imagePath.replace(/\.png$/, `_ocr_${tmpSuffix}.png`);
  try {
    let pipeline = sharp(imagePath)
      .extract(region)
      .resize(region.width * scale, region.height * scale, { kernel: "lanczos3" })
      .greyscale();
    if (mode === "norm")   pipeline = (pipeline as unknown as ReturnType<typeof sharp>).normalize().sharpen() as typeof pipeline;
    if (mode === "thresh") pipeline = (pipeline as unknown as ReturnType<typeof sharp>).threshold(180) as typeof pipeline;
    await (pipeline as unknown as ReturnType<typeof sharp>).png().toFile(tmp);

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const Tesseract = require("tesseract.js") as any;
    const worker    = await Tesseract.createWorker("eng");
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(tmp);
    await worker.terminate();
    return (data.text ?? "").replace(/\s+/g, " ").trim();
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 임시 파일 삭제 실패는 무시 */ }
  }
}

/** 콤마 포함 숫자 파싱: "1,014" → 1014  */
function parseCommaInt(s: string): number {
  return parseInt(s.replace(/,/g, ""), 10);
}

/**
 * 막대/꺾은선 차트에서 가장 오른쪽 막대 상단 숫자를 추출합니다.
 * (chart5: Active User, chart6: Unique Login)
 *
 * 전략: 우측 30% × 상단 72% 크롭 → PSM 11 (sparse) + normalize
 *   - 연도값(2000~2030) 및 y축 눈금 노이즈 필터
 */
async function extractGcpRightmostChartValue(imagePath: string): Promise<number> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[DEV OCR] 파일 없음: ${imagePath}`); return 0; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();
  const left = Math.floor(W * 0.70), top = 0;
  const width = W - left, height = Math.floor(H * 0.72);
  try {
    const text = await ocrCrop(imagePath, { left, top, width, height }, 6, "11", "norm", "rmost");
    logger.info(`[DEV OCR] chart5/6 ${path.basename(imagePath)} 텍스트: "${text}"`);
    const numbers = (text.match(/\d[\d,]*/g) ?? [])
      .map(parseCommaInt)
      .filter(n => !isNaN(n) && n >= 1 && n <= 99_999 && !(n >= 2000 && n <= 2030));
    logger.info(`[DEV OCR] chart5/6 추출: ${JSON.stringify(numbers)}`);
    return numbers[0] ?? 0;
  } catch (e) {
    logger.error(`[DEV OCR] chart5/6 실패: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * 문서 관리 현황 꺾은선 차트 — 신규 문서 수 = (오른쪽달 값 - 가운데달 값)
 *
 * 전략 (실측 기반):
 *  ① 차트 좌측 13%(Y축) 제외 → 3등분
 *  ② 중간 구간(가운데 달) / 오른쪽 구간(해당 달) 각각 OCR
 *  ③ 정수 직접 파싱 — 연도값(2000~2030) 필터
 *  ④ 오른쪽 - 가운데
 */
async function extractGcpNewDocuments(imagePath: string): Promise<number> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[DEV OCR] 파일 없음: ${imagePath}`); return 0; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();
  const chartLeft = Math.floor(W * 0.13);
  const secW      = Math.floor((W - chartLeft) / 3);
  const cropTop = Math.floor(H * 0.073);
  const cropH   = Math.floor(H * 0.78) - cropTop;

  async function scanSection(label: string, left: number, width: number): Promise<number> {
    const safeW = Math.min(width, W - left);
    try {
      const text = await ocrCrop(imagePath, { left, top: cropTop, width: safeW, height: cropH }, 6, "11", "norm", `doc_${label}`);
      logger.info(`[DEV OCR] chart2(doc) ${label}: "${text}"`);
      const numbers = (text.match(/\d[\d,]*/g) ?? [])
        .map(parseCommaInt)
        .filter(n => !isNaN(n) && n >= 50 && n <= 99_999 && !(n >= 2000 && n <= 2030));
      logger.info(`[DEV OCR] chart2(doc) ${label} 숫자: ${JSON.stringify(numbers)}`);
      return numbers[0] ?? 0;
    } catch (e) {
      logger.error(`[DEV OCR] chart2(doc) ${label} 실패: ${(e as Error).message}`);
      return 0;
    }
  }

  const midVal   = await scanSection("mid",   chartLeft + secW,     secW);
  const rightVal = await scanSection("right", chartLeft + secW * 2, W - chartLeft - secW * 2);

  if (rightVal === 0) {
    logger.warn("[DEV OCR] chart2(doc) 오른쪽 값 0");
    return 0;
  }
  const newDocs = Math.max(0, rightVal - midVal);
  logger.info(`[DEV OCR] chart2(doc) 오른쪽=${rightVal}, 가운데=${midVal} → 신규=${newDocs}`);
  return newDocs;
}

/**
 * 품질 관리 현황 막대 차트 — 현재 월(오른쪽 바 그룹) Deviation / Finding 추출
 *
 * 전략 (실측 기반):
 *  ① 오른쪽 29% (x≈71~100%) × 상단 8~66% 크롭 → 현재 월 막대 레이블 영역
 *  ② PSM 6 + threshold(180) + scale 8x  → 작은 숫자(1~99)도 안정 인식
 *  ③ 유효 정수 순서대로: 첫째 = Deviation, 둘째 = Finding(없으면 0)
 */
async function extractGcpQualityStats(imagePath: string): Promise<{ deviation: number; finding: number }> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[DEV OCR] 파일 없음: ${imagePath}`); return { deviation: 0, finding: 0 }; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();
  const left   = Math.floor(W * 0.712);
  const top    = Math.floor(H * 0.105);
  const width  = Math.floor(W * 0.237);
  const height = Math.floor(H * 0.556);
  try {
    const text = await ocrCrop(imagePath, { left, top, width, height }, 8, "6", "thresh", "qe");
    logger.info(`[DEV OCR] chart3(qe) 텍스트: "${text}"`);
    const numbers = (text.match(/\d+/g) ?? [])
      .map((s: string) => parseInt(s, 10))
      .filter((n: number) => !isNaN(n) && n >= 1 && n <= 999);
    logger.info(`[DEV OCR] chart3(qe) 숫자: ${JSON.stringify(numbers)}`);
    return { deviation: numbers[0] ?? 0, finding: numbers[1] ?? 0 };
  } catch (e) {
    logger.error(`[DEV OCR] chart3(qe) 실패: ${(e as Error).message}`);
    return { deviation: 0, finding: 0 };
  }
}

/**
 * 교육 관리 현황 막대 차트 — 가장 오른쪽 막대 상단 숫자 (콤마 포함 정수 지원)
 *
 * 전략: 우측 45% × 상단 75% 크롭 → PSM 11 + normalize
 *   - "1,014" 형식 → 콤마 제거 후 정수 파싱
 */
async function extractGcpTrainingCount(imagePath: string): Promise<number> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[DEV OCR] 파일 없음: ${imagePath}`); return 0; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();
  const left = Math.floor(W * 0.55), top = 0;
  const width = W - left, height = Math.floor(H * 0.75);
  try {
    const text = await ocrCrop(imagePath, { left, top, width, height }, 6, "11", "norm", "train");
    logger.info(`[DEV OCR] chart4(train) 텍스트: "${text}"`);
    const numbers = (text.match(/\d[\d,]*/g) ?? [])
      .map(parseCommaInt)
      .filter(n => !isNaN(n) && n >= 1 && n <= 999_999 && !(n >= 2000 && n <= 2030));
    logger.info(`[DEV OCR] chart4(train) 숫자: ${JSON.stringify(numbers)}`);
    return numbers[0] ?? 0;
  } catch (e) {
    logger.error(`[DEV OCR] chart4(train) 실패: ${(e as Error).message}`);
    return 0;
  }
}

// ── Medcomms 차트 OCR 함수 ───────────────────────────────────────────────────

/**
 * Chart 1 — 사용자 현황: 세로 막대 3개 중 가장 오른쪽 막대 상단 숫자
 *
 * 전략: 우측 30% × 상단 72% 크롭 → PSM 11 + normalize
 */
async function extractMedcommsRightmostBar(imagePath: string, label: string): Promise<number> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[MC OCR] 파일 없음: ${imagePath}`); return 0; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();
  const left = Math.floor(W * 0.70), top = 0;
  const width = W - left, height = Math.floor(H * 0.72);
  try {
    const text = await ocrCrop(imagePath, { left, top, width, height }, 6, "11", "norm", `mc_${label}`);
    logger.info(`[MC OCR] ${label} 텍스트: "${text}"`);
    const numbers = (text.match(/\d[\d,]*/g) ?? [])
      .map(parseCommaInt)
      .filter(n => !isNaN(n) && n >= 1 && n <= 999_999 && !(n >= 2000 && n <= 2030));
    logger.info(`[MC OCR] ${label} 추출: ${JSON.stringify(numbers)}`);
    return numbers[0] ?? 0;
  } catch (e) {
    logger.error(`[MC OCR] ${label} 실패: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * Chart 2 — 일일 사용 현황: 세로 막대 3개 중 가장 오른쪽 막대 상단 숫자 추출
 *
 * ※ nested async function(bboxStrategy) 제거 → 반환값이 외부 함수로 전달되지 않는
 *   구조적 문제를 방지하기 위해 flat 구조로 재작성.
 *
 * 전략 순서 (모두 전체 높이 크롭 — 막대 값이 작아도 놓치지 않음):
 *   1: 우측 50% × 전체 높이, PSM 11, norm  → 마지막 유효 숫자 (오른쪽 막대)
 *   2: 우측 50% × 전체 높이, PSM 11, thresh
 *   3: 우측 30% × 전체 높이, PSM 11, norm  → 더 좁은 영역
 *   4: 전체 이미지,           PSM 11, norm  → 마지막 숫자 폴백
 */
async function extractMedcommsUniqueLogin(imagePath: string): Promise<number> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[MC OCR] 파일 없음: ${imagePath}`); return 0; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();
  logger.info(`[MC OCR] chart2 이미지 크기: ${W}×${H}`);

  /** 텍스트에서 유효 정수 배열 추출 (연도 제외) */
  const parseNums = (text: string): number[] =>
    (text.match(/\d[\d,]*/g) ?? [])
      .map(parseCommaInt)
      .filter(n => !isNaN(n) && n >= 1 && n <= 999_999 && !(n >= 2000 && n <= 2030));

  // ── 전략 1: 우측 50% × 전체 높이, norm ──────────────────────────────────────
  try {
    const left = Math.floor(W * 0.50);
    const text = await ocrCrop(imagePath, { left, top: 0, width: W - left, height: H }, 7, "11", "norm", "mc2_s1");
    const nums = parseNums(text);
    logger.info(`[MC OCR] chart2 [S1] 텍스트: "${text}" / 숫자: ${JSON.stringify(nums)}`);
    if (nums.length > 0) {
      const v = nums[nums.length - 1];          // 오른쪽 막대 레이블 = 마지막
      logger.info(`[MC OCR] chart2 ✓ S1 → ${v}`);
      return v;
    }
  } catch (e) { logger.error(`[MC OCR] chart2 S1 실패: ${(e as Error).message}`); }

  // ── 전략 2: 우측 50% × 전체 높이, thresh ─────────────────────────────────────
  try {
    const left = Math.floor(W * 0.50);
    const text = await ocrCrop(imagePath, { left, top: 0, width: W - left, height: H }, 7, "11", "thresh", "mc2_s2");
    const nums = parseNums(text);
    logger.info(`[MC OCR] chart2 [S2] 텍스트: "${text}" / 숫자: ${JSON.stringify(nums)}`);
    if (nums.length > 0) {
      const v = nums[nums.length - 1];
      logger.info(`[MC OCR] chart2 ✓ S2 → ${v}`);
      return v;
    }
  } catch (e) { logger.error(`[MC OCR] chart2 S2 실패: ${(e as Error).message}`); }

  // ── 전략 3: 우측 30% × 전체 높이, norm ──────────────────────────────────────
  try {
    const left = Math.floor(W * 0.70);
    const text = await ocrCrop(imagePath, { left, top: 0, width: W - left, height: H }, 8, "11", "norm", "mc2_s3");
    const nums = parseNums(text);
    logger.info(`[MC OCR] chart2 [S3] 텍스트: "${text}" / 숫자: ${JSON.stringify(nums)}`);
    if (nums.length > 0) {
      const v = nums[nums.length - 1];
      logger.info(`[MC OCR] chart2 ✓ S3 → ${v}`);
      return v;
    }
  } catch (e) { logger.error(`[MC OCR] chart2 S3 실패: ${(e as Error).message}`); }

  // ── 전략 4: 전체 이미지, norm (최후 폴백) ────────────────────────────────────
  try {
    const text = await ocrCrop(imagePath, { left: 0, top: 0, width: W, height: H }, 5, "11", "norm", "mc2_s4");
    const nums = parseNums(text);
    logger.info(`[MC OCR] chart2 [S4] 텍스트: "${text}" / 숫자: ${JSON.stringify(nums)}`);
    if (nums.length > 0) {
      const v = nums[nums.length - 1];
      logger.info(`[MC OCR] chart2 ✓ S4 → ${v}`);
      return v;
    }
  } catch (e) { logger.error(`[MC OCR] chart2 S4 실패: ${(e as Error).message}`); }

  logger.warn("[MC OCR] chart2 ✗ 모든 전략 실패 → 0");
  return 0;
}

/**
 * Chart 3 — 가로 막대 차트 (4개): 가장 값이 높은 index와 값 추출
 *
 * 레이아웃: [왼쪽 = index명] [██ 막대 body ██] [오른쪽 끝 = 수치]
 *
 * 전략: Tesseract 단어 바운딩박스(bbox) 기반 공간 분석
 *   - 텍스트만으로는 레이블·수치의 위치를 알 수 없어 bbox를 사용
 *   ① 차트 전체 영역을 scale 5 업스케일 + greyscale normalize
 *   ② PSM 6 인식 → data.words (text, bbox, confidence) 수집
 *   ③ xCentre < midX(45%) → 레이블 단어 / xCentre ≥ midX → 수치 단어
 *   ④ yCentre 가 ROW_THRESHOLD(막대간격/2) 이내인 단어들을 같은 행으로 묶음
 *   ⑤ 행별 최댓값 비교 → 가장 큰 수치의 {name, count} 반환
 */
async function extractMedcommsTopDocType(imagePath: string): Promise<{ name: string; count: number }> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[MC OCR] 파일 없음: ${imagePath}`); return { name: "-", count: 0 }; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();

  const chartTopY = Math.floor(H * 0.07);
  const chartBotY = Math.floor(H * 0.93);
  const region    = { left: 0, top: chartTopY, width: W, height: chartBotY - chartTopY };
  const SCALE     = 5;
  const scaledW   = region.width  * SCALE;
  const scaledH   = region.height * SCALE;

  // 막대 4개 기준: 행 간격의 절반을 임계값으로 사용 (인접 행 미합산)
  const ROW_THRESHOLD = Math.floor(scaledH / 4 / 2);
  // x < midX → 레이블 영역 / x ≥ midX → 수치 영역
  const midX = Math.floor(scaledW * 0.45);

  const tmp = imagePath.replace(/\.png$/, "_ocr_mc3_bbox.png");

  try {
    await (sharp(imagePath)
      .extract(region)
      .resize(scaledW, scaledH, { kernel: "lanczos3" })
      .greyscale()
      .normalize()
      .sharpen() as ReturnType<typeof sharp>)
      .png()
      .toFile(tmp);

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const Tesseract = require("tesseract.js") as any;
    const worker    = await Tesseract.createWorker("eng");
    await worker.setParameters({ tessedit_pageseg_mode: "6" });
    const { data } = await worker.recognize(tmp);
    await worker.terminate();

    type TWord = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence: number };
    const words: TWord[] = data.words ?? [];
    logger.info(`[MC OCR] chart3 bbox: 단어 ${words.length}개 인식`);

    interface Row { yCentre: number; labels: string[]; values: number[] }
    const rows: Row[] = [];

    for (const word of words) {
      const text = (word.text ?? "").trim();
      if (!text || word.confidence < 20) continue;

      const yCentre = (word.bbox.y0 + word.bbox.y1) / 2;
      const xCentre = (word.bbox.x0 + word.bbox.x1) / 2;

      let row = rows.find(r => Math.abs(r.yCentre - yCentre) < ROW_THRESHOLD);
      if (!row) {
        row = { yCentre, labels: [], values: [] };
        rows.push(row);
      }
      row.yCentre = (row.yCentre + yCentre) / 2;

      if (xCentre < midX) {
        // 레이블 영역: 숫자 전용 문자열 제외
        if (!/^\d[\d,.]*$/.test(text)) row.labels.push(text);
      } else {
        // 수치 영역: "5 67" → "567" 자릿수 병합 후 파싱
        const merged = text.replace(/(\d)\s+(\d)/g, "$1$2");
        const num = parseCommaInt(merged);
        if (!isNaN(num) && num >= 1 && num <= 9_999_999 && !(num >= 2000 && num <= 2030)) {
          row.values.push(num);
        }
      }
    }

    rows.sort((a, b) => a.yCentre - b.yCentre);
    logger.info(`[MC OCR] chart3 행 분석: ${JSON.stringify(
      rows.map(r => ({ label: r.labels.join(" "), value: r.values[0] ?? 0 }))
    )}`);

    const best = rows.reduce<{ name: string; count: number }>(
      (b, row) => {
        const val = row.values[0] ?? 0;
        return val > b.count ? { name: row.labels.join(" ").trim() || "-", count: val } : b;
      },
      { name: "-", count: 0 }
    );

    logger.info(`[MC OCR] chart3 최댓값: ${JSON.stringify(best)}`);
    return best;

  } catch (e) {
    logger.error(`[MC OCR] chart3 bbox 실패: ${(e as Error).message}`);
    return { name: "-", count: 0 };
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

/**
 * Chart 4 — 꺾은선 그래프: 신규 문서 수 = (오른쪽 달 값 - 가운데 달 값)
 *
 * GCP extractGcpNewDocuments 와 동일한 전략 (3등분, 가운데/오른쪽 비교).
 */
async function extractMedcommsNewDocuments(imagePath: string): Promise<number> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[MC OCR] 파일 없음: ${imagePath}`); return 0; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();
  const chartLeft = Math.floor(W * 0.13);
  const secW      = Math.floor((W - chartLeft) / 3);
  const cropTop   = Math.floor(H * 0.073);
  const cropH     = Math.floor(H * 0.78) - cropTop;

  async function scanSection(label: string, left: number, width: number): Promise<number> {
    const safeW = Math.min(width, W - left);
    try {
      const text = await ocrCrop(imagePath, { left, top: cropTop, width: safeW, height: cropH }, 6, "11", "norm", `mc4_${label}`);
      logger.info(`[MC OCR] chart4(doc) ${label}: "${text}"`);
      const numbers = (text.match(/\d[\d,]*/g) ?? [])
        .map(parseCommaInt)
        .filter(n => !isNaN(n) && n >= 50 && n <= 999_999 && !(n >= 2000 && n <= 2030));
      return numbers[0] ?? 0;
    } catch (e) {
      logger.error(`[MC OCR] chart4(doc) ${label} 실패: ${(e as Error).message}`);
      return 0;
    }
  }

  const midVal   = await scanSection("mid",   chartLeft + secW,     secW);
  const rightVal = await scanSection("right", chartLeft + secW * 2, W - chartLeft - secW * 2);
  const newDocs  = Math.max(0, rightVal - midVal);
  logger.info(`[MC OCR] chart4(doc) 오른쪽=${rightVal}, 가운데=${midVal} → 신규=${newDocs}`);
  return newDocs;
}

/**
 * Chart 5 — 세로 막대 차트: 막대 상단 숫자 전체 합산
 *
 * 전략: y축 제외 (좌 8%), 상단 72% 크롭 → PSM 11 norm → 모든 숫자 합산
 */
async function extractMedcommsTaskTotal(imagePath: string): Promise<number> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[MC OCR] 파일 없음: ${imagePath}`); return 0; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();
  const left   = Math.floor(W * 0.08);
  const top    = 0;
  const width  = W - left;
  const height = Math.floor(H * 0.72);
  try {
    const text = await ocrCrop(imagePath, { left, top, width, height }, 6, "11", "norm", "mc5_task");
    logger.info(`[MC OCR] chart5 텍스트: "${text}"`);
    const numbers = (text.match(/\d[\d,]*/g) ?? [])
      .map(parseCommaInt)
      .filter(n => !isNaN(n) && n >= 1 && n <= 999_999 && !(n >= 2000 && n <= 2030));
    logger.info(`[MC OCR] chart5 숫자: ${JSON.stringify(numbers)}`);
    return numbers.reduce((s, n) => s + n, 0);
  } catch (e) {
    logger.error(`[MC OCR] chart5 실패: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * Chart 6 — 월 별 문서 리뷰 시간 (이중 막대): 해당 월 Record Count / Time in Review 추출
 *
 * 전략: 우측 30% × 상단 80% 크롭 → PSM 11 norm → 첫째 = Record Count, 둘째 = Time in Review
 */
async function extractMedcommsReviewStats(imagePath: string): Promise<{ recordCount: number; timeInReview: number }> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[MC OCR] 파일 없음: ${imagePath}`); return { recordCount: 0, timeInReview: 0 }; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();
  const left   = Math.floor(W * 0.65);
  const top    = 0;
  const width  = W - left;
  const height = Math.floor(H * 0.80);
  try {
    const text = await ocrCrop(imagePath, { left, top, width, height }, 7, "11", "norm", "mc6_review");
    logger.info(`[MC OCR] chart6 텍스트: "${text}"`);
    const numbers = (text.match(/\d[\d,.]+/g) ?? [])
      .map(s => parseFloat(s.replace(/,/g, "")))
      .filter(n => !isNaN(n) && n >= 1 && !(n >= 2000 && n <= 2030));
    logger.info(`[MC OCR] chart6 숫자: ${JSON.stringify(numbers)}`);
    return {
      recordCount:  Math.round(numbers[0] ?? 0),
      timeInReview: Math.round(numbers[1] ?? 0),
    };
  } catch (e) {
    logger.error(`[MC OCR] chart6 실패: ${(e as Error).message}`);
    return { recordCount: 0, timeInReview: 0 };
  }
}

// ── MS Timesheet 읽기 (3개 그룹) ─────────────────────────────────────────────

/**
 * SKB_Quallity_MS_Timesheet.xlsx 에서
 * SKB Clinical / SKB GCP / Medcomms 3개 그룹 데이터를 추출합니다.
 */
function readDevMsTimesheetData(xlsxPath: string): DevMsTimesheetData {
  const wb = XLSX.readFile(xlsxPath);

  const monthSheets = wb.SheetNames
    .filter((n: string) => /^\d{4}-\d{2}$/.test(n))
    .sort() as string[];

  let latestMonth = "";
  let colHeaders: string[] = ["시간(h)", "시스템", "카테고리", "주제", "세부내용", "시작일", "종료일", "상태"];

  // 그룹별 데이터 초기화
  const groupMap = new Map<string, DevMsGroupData>(
    DEV_MS_GROUP_NAMES.map((name) => [name, { groupName: name, chartRows: [], tableRows: [] }])
  );

  for (const sheetName of monthSheets) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];

    // 최신 시트에서 컬럼명 읽기
    if (sheetName === monthSheets[monthSheets.length - 1]) {
      latestMonth = sheetName;
      if (rows.length > 0) {
        const hdr = rows[0] as unknown[];
        const h   = [4, 6, 7, 8, 9, 10, 11, 12].map((i) => String(hdr[i] ?? "").trim());
        if (h.some((v) => v !== "")) colHeaders = h.map((v, i) => v || colHeaders[i]);
      }
    }

    // 각 그룹의 헤더 행 탐색
    const foundGroupRows = new Map<string, number>(); // groupName → rowIdx

    for (let i = 0; i < rows.length; i++) {
      const aVal = String((rows[i] as unknown[])[0] ?? "").trim();
      for (const groupName of DEV_MS_GROUP_NAMES) {
        if (aVal === groupName && !foundGroupRows.has(groupName)) {
          foundGroupRows.set(groupName, i);
        }
      }
    }

    for (const [groupName, gmpRowIdx] of foundGroupRows.entries()) {
      const gmpRow = rows[gmpRowIdx] as unknown[];
      const group  = groupMap.get(groupName)!;

      group.chartRows.push({
        month:     sheetName,
        possible:  Number(gmpRow[1]) || 0,
        used:      Number(gmpRow[2]) || 0,
        remaining: Number(gmpRow[3]) || 0,
      });
      logger.info(`[DEV Report MS] ${sheetName} ${groupName} — B:${gmpRow[1]}, C:${gmpRow[2]}, D:${gmpRow[3]}`);

      // 최신 월: 세부 행 수집
      if (sheetName === monthSheets[monthSheets.length - 1]) {
        // 다음 그룹 시작 위치 파악
        const nextGroupRow = (() => {
          let min = rows.length;
          for (const [otherGroup, otherIdx] of foundGroupRows.entries()) {
            if (otherGroup !== groupName && otherIdx > gmpRowIdx && otherIdx < min) {
              min = otherIdx;
            }
          }
          return min;
        })();

        // 그룹 헤더 행 자체가 첫 번째 작업 행을 겸하는 케이스를 포함하기 위해
        // gmpRowIdx 부터 시작 (헤더 행도 E열에 시간 값이 있으면 작업 행으로 수집)
        for (let i = gmpRowIdx; i < nextGroupRow; i++) {
          const row  = rows[i] as unknown[];
          const aVal = String(row[0] ?? "").trim();
          if (aVal !== "" && aVal !== groupName) break;
          if (String(row[4] ?? "").trim() === "") continue;
          group.tableRows.push({
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
        logger.info(`[DEV Report MS] ${sheetName} ${groupName} 테이블 행: ${group.tableRows.length}개`);
      }
    }
  }

  return {
    groups:      [...groupMap.values()],
    latestMonth,
    colHeaders,
  };
}

// ── MS 막대 차트 렌더링 ──────────────────────────────────────────────────────

async function renderMsBarChartToPng(
  chartRows:  MsChartRow[],
  groupName:  string,
  outputPng:  string,
): Promise<void> {
  const labels    = chartRows.map((r) => r.month.replace("-", "."));
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
  #wrap { width:520px; height:280px; }
</style>
</head>
<body>
<div id="wrap">
  <canvas id="chart" width="520" height="280"></canvas>
</div>
${scriptTag}
<script>
(function() {
  var ctx = document.getElementById('chart').getContext('2d');
  if (!window.Chart) { ctx.fillStyle='#ef4444'; ctx.font='12px Arial'; ctx.fillText('Chart.js 로드 실패',10,20); return; }
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
          c.save(); c.fillStyle='#1f2937'; c.font='bold 9px Arial';
          c.textAlign='center'; c.textBaseline='bottom';
          c.fillText(String(val), bar.x, bar.y - 2); c.restore();
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
        { label: '가능 MS', data: ${JSON.stringify(possible)},  backgroundColor: '#4472C4', borderRadius:3, borderSkipped:false },
        { label: '사용 MS', data: ${JSON.stringify(used)},      backgroundColor: '#A9D18E', borderRadius:3, borderSkipped:false },
        { label: '잔여 MS', data: ${JSON.stringify(remaining)}, backgroundColor: '#ED7D31', borderRadius:3, borderSkipped:false },
      ],
    },
    options: {
      responsive:false, animation:false,
      layout:{ padding:{ top:16 } },
      plugins:{
        legend:{ position:'bottom', labels:{ font:{size:9}, padding:10, usePointStyle:true } },
        tooltip:{ enabled:false },
      },
      scales:{
        x:{ grid:{display:false}, ticks:{font:{size:10}, color:'#374151'} },
        y:{ beginAtZero:true, grid:{color:'#f0f4f8'},
            ticks:{font:{size:9}, color:'#6b7280'},
            title:{display:true, text:'(MD)', font:{size:9}, color:'#9ca3af'} },
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
    await page.setViewportSize({ width: 520, height: 280 });
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(400);
    await page.locator("#wrap").screenshot({ path: outputPng, type: "png" });
    logger.info(`[DEV Report MS] ${groupName} bar chart: ${outputPng} (${fs.statSync(outputPng).size.toLocaleString()} B)`);
  } finally {
    await browser.close();
  }
}

// ── PDF HTML 빌드 ─────────────────────────────────────────────────────────────

function buildDevReportHtml(
  titleDate:      string,
  gcpDonutBase64: string | null,              // Activity_GCP.xlsx → 도넛 차트 PNG
  gcpCounts:      CategoryCounts,             // 도넛 집계 수치 (cell-msg 표시용)
  gcpCharts:      Array<{ base64: string; mime: string } | null>,  // 분할 이미지 [0]=미사용(도넛대체), [1-5] 사용
  medcommsCharts: Array<{ base64: string; mime: string } | null>,
  ctmsCharts:     Array<{ base64: string; mime: string } | null>,
  msData?:        DevMsTimesheetData | null,
  msBarCharts?:      Map<string, string | null>,
  gcpStats?:         GcpStats | null,
  medcommsStats?:    MedcommsStats | null,
): string {
  const today      = new Date().toLocaleDateString("ko-KR", {
    year: "numeric", month: "long", day: "numeric",
  });
  const monthLabel = titleDate.replace(/^\d+년\s*/, "");  // "03월"

  // ── 셀 HTML 생성 헬퍼 (이미지 + 선택적 cell-msg) ─────────────────────────────
  const makeCell = (
    no:      number,
    title:   string,
    img:     { base64: string; mime: string } | null,
    msg?:    string,
  ) => {
    const imgHtml = img
      ? `<div class="img-wrap"><img src="data:${img.mime};base64,${img.base64}" alt="${escHtml(title)}" /></div>`
      : `<div class="img-wrap" style="align-items:center;justify-content:center;color:#9ca3af;font-size:11px;flex-direction:column;">
           <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="#d1d5db" style="margin-bottom:6px">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
               d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M14 8h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
           </svg>
           차트 미업로드
         </div>`;
    return `<div class="usage-cell">
      <div class="cell-title"><span class="cell-no">${no}</span>${escHtml(title)}</div>
      ${msg !== undefined ? `<div class="cell-msg">${msg}</div>` : ""}
      ${imgHtml}
    </div>`;
  };

  // ── 헤드라인 — MS 건/시간 집계 ─────────────────────────────────────────────────
  const msGroupStat = (name: string) => {
    const g = msData?.groups.find((gr) => gr.groupName === name);
    if (!g) return { count: 0, hours: 0 };
    const count = g.tableRows.length;
    const hours = Math.round(
      g.tableRows.reduce((s, r) => s + (parseFloat(r.hours) || 0), 0)
    );
    return { count, hours };
  };
  const qualityMs  = msGroupStat("SKB GCP");
  const clinicalMs = msGroupStat("SKB Clinical");
  const medicalMs  = msGroupStat("Medcomms");

  const qualityUsers  = gcpStats?.activeUsers ?? 0;

  const devHeadlineHtml = `<div class="headline">
    ${monthLabel} 진행된 Managed Service는
    Quality System <strong>${qualityMs.count}</strong>건 (<strong>${qualityMs.hours.toLocaleString()}</strong>시간),
    Clinical System <strong>${clinicalMs.count}</strong>건 (<strong>${clinicalMs.hours.toLocaleString()}</strong>시간),
    Medical System <strong>${medicalMs.count}</strong>건 (<strong>${medicalMs.hours.toLocaleString()}</strong>시간) 진행하였습니다.<br>
    Veeva System MS시간은 월 별 유연하게 사용 가능하도록 전사 통합 관리 중입니다.
  </div>`;

  // ── Page 1: GCP 6개 그리드 — 셀 1은 도넛, 셀 2~6은 분할 이미지 ───────────────
  const donutImg = gcpDonutBase64
    ? { base64: gcpDonutBase64, mime: "image/png" as const }
    : null;

  const gcpCellMsgs: Record<number, string> = {
    1: `${monthLabel} 총 실행된 Task는 <strong>${gcpCounts.total.toLocaleString()}</strong>건`,
    2: gcpStats
      ? `${monthLabel} 약 <strong>${gcpStats.newDocuments.toLocaleString()}</strong>개의 신규 문서 등록`
      : "",
    3: gcpStats
      ? `${monthLabel} Deviation <strong>${gcpStats.deviation.toLocaleString()}</strong>건 발생, Finding <strong>${gcpStats.finding.toLocaleString()}</strong>건 발생`
      : "",
    4: gcpStats
      ? `${monthLabel} 약 <strong>${gcpStats.trainings.toLocaleString()}</strong>건의 교육이 실행됨`
      : "",
    5: gcpStats
      ? `신규 등록 포함 개발본부 Quality System 총 사용자는 <strong>${gcpStats.activeUsers.toLocaleString()}</strong>명 등록`
      : "",
    6: gcpStats
      ? `매일 평균 <strong>${gcpStats.uniqueLogin.toLocaleString()}</strong>명 시스템 사용 중`
      : "",
  };

  const gcpCells = [
    makeCell(1, GCP_CHART_TITLES[0], donutImg, gcpCellMsgs[1]),
    ...gcpCharts.slice(1, 6).map((img, i) =>
      makeCell(i + 2, GCP_CHART_TITLES[i + 1] ?? `차트 ${i + 2}`, img, gcpCellMsgs[i + 2] || undefined)
    ),
  ];

  const gcpGrid = `<div class="usage-grid grid-3row-md">
    ${gcpCells.join("\n")}
  </div>`;

  // ── Page 2: Medcomms 6개 그리드 ─────────────────────────────────────────────
  logger.info(`[HTML] buildDevReportHtml 진입 — medcommsStats.uniqueLogin=${medcommsStats?.uniqueLogin ?? "null"}`);
  const medcommsGrid = `<div class="usage-grid grid-3row-lg">
    ${medcommsCharts.slice(0, 6).map((img, i) => makeCell(i + 1, MEDCOMMS_CHART_TITLES[i] ?? `차트 ${i + 1}`, img)).join("\n")}
  </div>`;

  // ── Page 3: CTMS 2+1 레이아웃 ───────────────────────────────────────────────
  // charts[0] = Clinical1 좌측 절반, charts[1] = Clinical1 우측 절반
  // charts[2] = Clinical2 전체 (하단 전폭)
  const ctmsGrid = (() => {
    const c1 = ctmsCharts[0] ?? null;
    const c2 = ctmsCharts[1] ?? null;
    const c3 = ctmsCharts[2] ?? null;

    const imgHtml = (img: { base64: string; mime: string } | null, title: string) =>
      img
        ? `<img src="data:${img.mime};base64,${img.base64}" alt="${escHtml(title)}" style="width:100%;height:100%;object-fit:contain;object-position:center;display:block;" />`
        : `<div style="display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:11px;height:100%;">차트 미업로드</div>`;

    return `<div class="ctms-grid">
      <!-- 좌우 2개 (Clinical1 분할) -->
      <div class="usage-cell">
        <div class="cell-title"><span class="cell-no">1</span>${escHtml(CTMS_CHART_TITLES[0])}</div>
        <div class="img-wrap">${imgHtml(c1, CTMS_CHART_TITLES[0])}</div>
      </div>
      <div class="usage-cell">
        <div class="cell-title"><span class="cell-no">2</span>${escHtml(CTMS_CHART_TITLES[1])}</div>
        <div class="img-wrap">${imgHtml(c2, CTMS_CHART_TITLES[1])}</div>
      </div>
      <!-- 하단 전폭 (Clinical2) -->
      <div class="usage-cell ctms-wide">
        <div class="cell-title"><span class="cell-no">3</span>${escHtml(CTMS_CHART_TITLES[2])}</div>
        <div class="img-wrap" style="padding:4px;">${imgHtml(c3, CTMS_CHART_TITLES[2])}</div>
      </div>
    </div>`;
  })();

  // ── Page 4: MS 진행 현황 ──────────────────────────────────────────────────────
  const msPageHtml = msData ? (() => {
    const latestLabel = msData.latestMonth ? formatMonthKorean(msData.latestMonth) : titleDate;
    const [hE, hG, hH, hI, hJ, hK, hL, hM] = msData.colHeaders;

    // 그룹별 막대 차트 섹션 (3열 배치)
    const chartsRowHtml = `
    <div class="ms-section">
      <div class="ms-section-title">1) 시스템 별 MS 현황</div>
      <div class="ms-three-charts">
        ${msData.groups.map((g) => {
          const chartBase64 = msBarCharts?.get(g.groupName) ?? null;
          const summaryRows = g.chartRows.map((r) => `<tr>
            <td>${escHtml(formatMonthKorean(r.month))}</td>
            <td>${r.possible}</td><td>${r.used}</td><td>${r.remaining}</td>
          </tr>`).join("");
          return `
          <div class="ms-chart-group">
            <div class="ms-chart-subtitle">${escHtml(g.groupName)}</div>
            <div class="ms-chart-wrap">
              ${chartBase64
                ? `<img src="data:image/png;base64,${chartBase64}" alt="${escHtml(g.groupName)} MS 차트" />`
                : `<div class="ms-no-data">차트 없음</div>`}
            </div>
            ${g.chartRows.length > 0 ? `
            <table class="ms-summary-table" style="font-size:8px;margin-top:4px;">
              <thead><tr><th>월</th><th>가능</th><th>사용</th><th>잔여</th></tr></thead>
              <tbody>${summaryRows}</tbody>
            </table>` : ""}
          </div>`;
        }).join("")}
      </div>
    </div>`;

    // 그룹별 상세 테이블
    const tableHeaderRow = `<tr>
      <th>${escHtml(hG)}</th><th>${escHtml(hH)}</th>
      <th style="min-width:80px">${escHtml(hI)}</th><th>${escHtml(hJ)}</th>
      <th style="white-space:nowrap">${escHtml(hK)}</th>
      <th style="white-space:nowrap">${escHtml(hL)}</th>
      <th style="white-space:nowrap">${escHtml(hM)}</th>
      <th style="white-space:nowrap">${escHtml(hE)}</th>
    </tr>`;

    const tablesHtml = msData.groups.map((g) => {
      const bodyRows = g.tableRows.map((r) => `<tr>
        <td class="td-center">${escHtml(r.system)}</td>
        <td class="td-center">${escHtml(r.category)}</td>
        <td>${escHtml(r.subject)}</td>
        <td class="td-detail">${escHtml(r.detail)}</td>
        <td class="td-nowrap">${escHtml(r.startDate)}</td>
        <td class="td-nowrap">${escHtml(r.endDate)}</td>
        <td class="td-nowrap">${escHtml(r.status)}</td>
        <td class="td-nowrap td-num">${escHtml(r.hours)}</td>
      </tr>`).join("");

      return `
    <div class="ms-section">
      <div class="ms-table-title">${escHtml(latestLabel)} ${escHtml(g.groupName)} Managed Service 주요 현황</div>
      ${g.tableRows.length > 0
        ? `<table class="ms-table">
             <thead>${tableHeaderRow}</thead>
             <tbody>${bodyRows}</tbody>
           </table>`
        : `<div class="ms-no-data">해당 월 ${escHtml(g.groupName)} 세부 데이터가 없습니다.</div>`}
    </div>`;
    }).join("");

    return `
  <!-- ── MS 진행 현황 페이지 ── -->
  <div class="page ms-page">
    <table class="ms-repeat-table">
      <thead>
        <tr><td>
          <div class="page-header">
            <h2>4. Managed Service 진행 현황</h2>
            <span class="pg">${titleDate}</span>
          </div>
        </td></tr>
      </thead>
      <tbody>
        <tr><td>
          ${chartsRowHtml}
          ${tablesHtml}
        </td></tr>
      </tbody>
      <tfoot>
        <tr><td>
          <div class="footer-repeating">
            <span>SK Bioscience 개발본부 — 시스템 운영 현황</span>
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

    /* ── 표지 ── */
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

    /* ── 공통 페이지 ── */
    .page { break-before:page; padding:36px 44px 28px; }
    /* MS 진행 현황 페이지: 좌우 여백만 — 상/하는 thead/tfoot 가 담당 */
    .ms-page { padding:0 44px; }
    .page-header {
      display:flex; align-items:flex-end; justify-content:space-between;
      border-bottom:2.5px solid #0f2d55; padding-bottom:10px; margin-bottom:14px;
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
    .headline {
      font-size:11px; line-height:1.8; color:#1f2937;
      background:#f0f4f8; border-left:4px solid #0f2d55;
      padding:10px 14px; margin-bottom:12px; border-radius:0 4px 4px 0;
    }
    .headline strong { color:#0f2d55; font-weight:700; }
    .footer {
      margin-top:16px; padding-top:10px; border-top:1px solid #e5e7eb;
      font-size:10px; color:#d1d5db; display:flex; justify-content:space-between;
    }

    /* ── 6-차트 그리드 (2열 × 3행) ── */
    .usage-grid {
      display:grid; grid-template-columns:1fr 1fr; gap:8px;
    }
    .grid-3row    { grid-template-rows:repeat(3,230px); }
    .grid-3row-md { grid-template-rows:repeat(3,265px); }
    .grid-3row-lg { grid-template-rows:repeat(3,285px); }

    .usage-cell {
      border:1px solid #e5e7eb; border-radius:6px; overflow:hidden;
      background:#fff; display:flex; flex-direction:column; min-width:0;
    }
    .cell-title {
      flex-shrink:0; height:26px; padding:0 10px;
      font-size:10px; font-weight:700; color:#1f2937;
      background:#f0f4f8; border-bottom:1px solid #e5e7eb;
      display:flex; align-items:center; justify-content:center; gap:6px;
    }
    .cell-no {
      display:inline-flex; align-items:center; justify-content:center;
      width:16px; height:16px; border-radius:50%;
      background:#0f2d55; color:#fff; font-size:9px; font-weight:700; flex-shrink:0;
    }
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
    .img-wrap {
      flex:1; min-height:0; display:flex;
      align-items:flex-end; justify-content:center;
      padding:4px 4px 0 4px; overflow:hidden;
    }
    .img-wrap img {
      display:block; max-width:100%; height:100%; width:auto;
      object-fit:contain; object-position:bottom center;
    }

    /* ── CTMS 2+1 레이아웃 ── */
    .ctms-grid {
      display:grid; grid-template-columns:1fr 1fr;
      grid-template-rows:290px 220px; gap:8px;
    }
    .ctms-wide { grid-column:1 / -1; }

    /* ── MS 진행 현황 ── */
    .ms-section { margin-bottom:16px; }
    .ms-section-title {
      font-size:13px; font-weight:700; color:#0f2d55;
      margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid #cbd5e1;
    }
    .ms-three-charts {
      display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:4px;
    }
    .ms-chart-group { display:flex; flex-direction:column; }
    .ms-chart-subtitle { font-size:10px; font-weight:600; color:#0f2d55; margin-bottom:6px; text-align:center; }
    .ms-chart-wrap {
      display:flex; justify-content:center; align-items:center;
      background:#fafbfc; border:1px solid #e5e7eb; border-radius:6px; padding:8px 4px 4px;
    }
    .ms-chart-wrap img { max-width:100%; height:auto; display:block; }
    .ms-table-title { font-size:11px; font-weight:700; color:#0f2d55; margin-bottom:6px; }
    .ms-table { width:100%; border-collapse:collapse; font-size:8.5px; }
    .ms-table th {
      background:#0f2d55; color:#fff; font-weight:600;
      padding:4px 5px; text-align:center; white-space:nowrap; border:1px solid #1a4a8a;
    }
    .ms-table td { padding:3px 5px; border:1px solid #e5e7eb; vertical-align:middle; color:#374151; word-break:break-all; }
    .ms-table tr:nth-child(even) td { background:#f8fafc; }
    .ms-table .td-center { text-align:center; }
    .ms-table .td-num    { text-align:right; }
    .ms-table .td-nowrap { white-space:nowrap; text-align:center; }
    .ms-table .td-detail { word-break:break-word; }
    .ms-no-data { font-size:10px; color:#9ca3af; text-align:center; padding:14px; }
    .ms-summary-table { margin:0 auto; border-collapse:collapse; font-size:8px; }
    .ms-summary-table th {
      background:#4472C4; color:#fff; font-weight:600;
      padding:3px 8px; text-align:center; border:1px solid #3563b0; white-space:nowrap;
    }
    .ms-summary-table td {
      padding:3px 8px; border:1px solid #e5e7eb; text-align:center; color:#374151; white-space:nowrap;
    }
    .ms-summary-table tr:nth-child(even) td { background:#f8fafc; }
  </style>
</head>
<body>
  <!-- ── 표지 ── -->
  <div class="cover">
    <div class="cover-badge">SK Bioscience</div>
    <div class="cover-main">${titleDate}<br>개발본부 시스템 운영 현황</div>
    <div class="cover-rule"></div>
    <div class="cover-date">작성일: ${today}</div>
  </div>

  <!-- ── Page 1: GCP Quality System ── -->
  <div class="page">
    <div class="page-header">
      <h2>1. GCP Quality System (eDMS / eQMS / eLMS)</h2>
      <span class="pg">${titleDate}</span>
    </div>
    ${devHeadlineHtml}
    ${gcpGrid}
    <div class="footer">
      <span>SK Bioscience 개발본부 — 시스템 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>

  <!-- ── Page 2: Medcomms ── -->
  <div class="page">
    <div class="page-header">
      <h2>2. Medical contents management System (Medcomms)</h2>
      <span class="pg">${titleDate}</span>
    </div>
    ${medcommsGrid}
    <div class="footer">
      <span>SK Bioscience 개발본부 — 시스템 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>

  <!-- ── Page 3: CTMS / eTMF ── -->
  <div class="page">
    <div class="page-header">
      <h2>3. Clinical trial management System (CTMS / eTMF)</h2>
      <span class="pg">${titleDate}</span>
    </div>
    ${ctmsGrid}
    <div class="footer">
      <span>SK Bioscience 개발본부 — 시스템 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>

  ${msPageHtml}
</body>
</html>`;
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

export interface DevReportResult {
  filePath:  string;
  filename:  string;
  fileSize:  number;
  pageCount: number;
}

export async function generateDevReport(jobId: string): Promise<DevReportResult> {
  const uploadDir  = process.env.UPLOAD_DIR ?? "uploads";
  const uploadPath = path.resolve(uploadDir, jobId, "uploads");

  logger.info(`[DEV Report] 보고서 생성 요청 — jobId: ${jobId}`);
  logger.info(`[DEV Report] 업로드 경로: ${uploadPath}`);
  fs.mkdirSync(uploadPath, { recursive: true });

  // 1) 시스템별 대시보드 이미지 → sharp 로 분할
  const gcpPng       = path.join(uploadPath, "Systemusage_GCP.png");
  const gcpSrc       = fs.existsSync(gcpPng) ? gcpPng : resolveImagePath(uploadPath, "Systemusage_GCP");
  const medcommsSrc  = resolveImagePath(uploadPath, "Systemusage_Medcomms");
  const ctmsSrc1     = resolveImagePath(uploadPath, "Systemusage_Clinical1");
  const ctmsSrc2     = resolveImagePath(uploadPath, "Systemusage_Clinical2");

  logger.info(`[DEV Report] Systemusage_GCP       : ${gcpSrc     ?? "없음"}`);
  logger.info(`[DEV Report] Systemusage_Medcomms  : ${medcommsSrc ?? "없음"}`);
  logger.info(`[DEV Report] Systemusage_Clinical1 : ${ctmsSrc1    ?? "없음"}`);
  logger.info(`[DEV Report] Systemusage_Clinical2 : ${ctmsSrc2    ?? "없음"}`);

  // 분할 결과 (없는 파일은 null 로 채움)
  const NULL6 = Array<ChartImg | null>(6).fill(null);

  let gcpCharts:      Array<ChartImg | null> = NULL6;
  let medcommsCharts: Array<ChartImg | null> = NULL6;

  if (gcpSrc) {
    try {
      gcpCharts = await split6Charts(gcpSrc, "gcp", uploadPath);
    } catch (e) {
      logger.error(`[DEV Report] GCP 분할 실패: ${(e as Error).message}`);
    }
  }
  if (medcommsSrc) {
    try {
      medcommsCharts = await split6Charts(medcommsSrc, "medcomms", uploadPath);
    } catch (e) {
      logger.error(`[DEV Report] Medcomms 분할 실패: ${(e as Error).message}`);
    }
  }

  // CTMS: Clinical1 → 좌(차트1) / 우(차트2) 분할, Clinical2 → 하단 전폭(차트3) 직접 사용
  const ctmsCharts: Array<ChartImg | null> = [null, null, null];
  if (ctmsSrc1) {
    try {
      const meta  = await sharp(ctmsSrc1).metadata();
      const W     = (meta.width  as number) ?? 1000;
      const H     = (meta.height as number) ?? 800;
      const halfW = Math.floor(W / 2);
      const [leftBuf, rightBuf] = await Promise.all([
        sharp(ctmsSrc1).extract({ left: 0,     top: 0, width: halfW,    height: H }).png().toBuffer(),
        sharp(ctmsSrc1).extract({ left: halfW, top: 0, width: W - halfW, height: H }).png().toBuffer(),
      ]);
      ctmsCharts[0] = { base64: leftBuf.toString("base64"),  mime: "image/png" };
      ctmsCharts[1] = { base64: rightBuf.toString("base64"), mime: "image/png" };
      logger.info(`[DEV Report] Clinical1 분할 완료 — ${W}×${H} → 좌 ${halfW}px / 우 ${W - halfW}px`);
    } catch (e) {
      logger.error(`[DEV Report] Clinical1 분할 실패: ${(e as Error).message}`);
    }
  }
  if (ctmsSrc2) {
    try {
      const buf = await sharp(ctmsSrc2).png().toBuffer();
      ctmsCharts[2] = { base64: buf.toString("base64"), mime: "image/png" };
      logger.info(`[DEV Report] Clinical2 로드 완료`);
    } catch (e) {
      logger.error(`[DEV Report] Clinical2 로드 실패: ${(e as Error).message}`);
    }
  }

  logger.info(`[DEV Report] GCP 차트: ${gcpCharts.filter(Boolean).length}/6`);
  logger.info(`[DEV Report] Medcomms 차트: ${medcommsCharts.filter(Boolean).length}/6`);
  logger.info(`[DEV Report] CTMS 차트: ${ctmsCharts.filter(Boolean).length}/3`);

  // 2) Activity_GCP.xlsx → 도넛 차트 + 집계 수치
  let gcpDonutBase64: string | null = null;
  let gcpCounts: CategoryCounts = { labels: [], values: [], total: 0 };

  const activityGcpPath = path.join(uploadPath, "Activity_GCP.xlsx");
  if (fs.existsSync(activityGcpPath)) {
    logger.info(`[DEV Report] ── Activity_GCP 도넛 차트 생성 ──`);
    try {
      const { png, counts } = await generateGcpChartPng(activityGcpPath, uploadPath);
      gcpCounts = counts;
      if (png && fs.existsSync(png)) {
        gcpDonutBase64 = fs.readFileSync(png).toString("base64");
        logger.info(`[DEV Report] 도넛 PNG base64 완료 (${(gcpDonutBase64.length / 1024).toFixed(1)} KB)`);
      }
    } catch (e) {
      logger.error(`[DEV Report] 도넛 차트 생성 실패 (무시): ${(e as Error).message}`);
    }
  } else {
    logger.info("[DEV Report] Activity_GCP.xlsx 없음 — 도넛 차트 건너뜀");
  }

  // 2-b) GCP 분할 이미지 OCR → 차트 2~6 헤드메시지용 통계
  let gcpStats:      GcpStats      | null = null;
  let medcommsStats: MedcommsStats | null = null;
  if (gcpSrc) {
    logger.info("[DEV Report] ── GCP 차트 OCR 시작 ──");
    try {
      const [newDocuments, qualityStats, trainings, activeUsers, uniqueLogin] = await Promise.all([
        extractGcpNewDocuments(path.join(uploadPath,        "gcp_split_1.png")),
        extractGcpQualityStats(path.join(uploadPath,        "gcp_split_2.png")),
        extractGcpTrainingCount(path.join(uploadPath,       "gcp_split_3.png")),
        extractGcpRightmostChartValue(path.join(uploadPath, "gcp_split_4.png")),
        extractGcpRightmostChartValue(path.join(uploadPath, "gcp_split_5.png")),
      ]);
      gcpStats = { newDocuments, deviation: qualityStats.deviation, finding: qualityStats.finding, trainings, activeUsers, uniqueLogin };
      logger.info(`[DEV Report] GCP OCR 완료: ${JSON.stringify(gcpStats)}`);
    } catch (e) {
      logger.error(`[DEV Report] GCP OCR 실패 (무시): ${(e as Error).message}`);
    }
  }

  // 2-c) Medcomms 분할 이미지 OCR → 차트 1~6 헤드메시지용 통계
  if (medcommsSrc) {
    logger.info("[DEV Report] ── Medcomms 차트 OCR 시작 ──");
    try {
      const [
        activeUsers,
        uniqueLogin,
        topDocType,
        newDocuments,
        taskTotal,
        reviewStats,
      ] = await Promise.all([
        extractMedcommsRightmostBar(path.join(uploadPath, "medcomms_split_0.png"), "chart1"),
        extractMedcommsUniqueLogin  (path.join(uploadPath, "medcomms_split_1.png")),
        extractMedcommsTopDocType  (path.join(uploadPath, "medcomms_split_2.png")),
        extractMedcommsNewDocuments(path.join(uploadPath, "medcomms_split_3.png")),
        extractMedcommsTaskTotal   (path.join(uploadPath, "medcomms_split_4.png")),
        extractMedcommsReviewStats (path.join(uploadPath, "medcomms_split_5.png")),
      ]);
      logger.info(`[MC OCR] ── Promise.all 결과 ── activeUsers=${activeUsers} uniqueLogin=${uniqueLogin} topDocType=${JSON.stringify(topDocType)} newDocuments=${newDocuments} taskTotal=${taskTotal}`);
      medcommsStats = {
        activeUsers, uniqueLogin, topDocType, newDocuments, taskTotal,
        recordCount:  reviewStats.recordCount,
        timeInReview: reviewStats.timeInReview,
      };
      logger.info(`[DEV Report] Medcomms OCR 완료: ${JSON.stringify(medcommsStats)}`);
    } catch (e) {
      logger.error(`[DEV Report] Medcomms OCR 실패 (무시): ${(e as Error).message}`);
    }
  }

  // 3) MS Timesheet — DB 에서 최신 파일 조회
  let msData:       DevMsTimesheetData | null = null;
  let msBarCharts:  Map<string, string | null> = new Map();

  try {
    const tsRows = await query<{ stored_path: string }>(
      `SELECT stored_path FROM uploaded_files
       WHERE original_name = 'SKB_Quallity_MS_Timesheet.xlsx'
       ORDER BY created_at DESC LIMIT 1`,
      []
    );

    if (tsRows.length && fs.existsSync(tsRows[0].stored_path)) {
      const tsPath = tsRows[0].stored_path;
      logger.info(`[DEV Report] Timesheet 파일: ${tsPath}`);

      msData = readDevMsTimesheetData(tsPath);

      // 3개 그룹 각각 막대 차트 렌더링
      for (const group of msData.groups) {
        if (group.chartRows.length === 0) {
          logger.warn(`[DEV Report] ${group.groupName}: 차트 데이터 없음 — 스킵`);
          msBarCharts.set(group.groupName, null);
          continue;
        }
        const pngPath = path.join(uploadPath, `ms_barchart_${group.groupName.replace(/\s+/g, "_")}_${Date.now()}.png`);
        await renderMsBarChartToPng(group.chartRows, group.groupName, pngPath);
        msBarCharts.set(group.groupName, fs.existsSync(pngPath) ? fs.readFileSync(pngPath).toString("base64") : null);
      }
    } else {
      logger.info("[DEV Report] Timesheet 파일 없음 — MS 페이지 생략");
    }
  } catch (e) {
    logger.error(`[DEV Report] Timesheet 처리 실패 (무시): ${(e as Error).message}`);
    msData = null;
  }

  // 3) HTML → PDF 생성
  logger.info(`[DEV Report] ── buildDevReportHtml 호출 직전 ── medcommsStats=${JSON.stringify(medcommsStats)}`);
  const { year, month } = getLastMonth();
  const titleDate  = `${year}년 ${String(month).padStart(2, "0")}월`;
  const html       = buildDevReportHtml(titleDate, gcpDonutBase64, gcpCounts, gcpCharts, medcommsCharts, ctmsCharts, msData, msBarCharts, gcpStats, medcommsStats);
  const outputDir  = path.resolve(process.env.OUTPUT_DIR ?? "outputs");
  fs.mkdirSync(outputDir, { recursive: true });

  const mm         = String(month).padStart(2, "0");
  const filename   = `${year}.${mm} 개발본부 시스템 운영 현황 Report.pdf`;
  const outputPath = path.join(outputDir, filename);

  logger.info(`[DEV Report] PDF 생성: ${outputPath}`);

  const result = await PdfGenerator.generate(html, outputPath, {
    format: "A4",
    margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
  });

  logger.info(`[DEV Report] 완료 — ${result.pageCount}p, ${result.fileSize.toLocaleString()} bytes`);

  return {
    filePath:  result.filePath,
    filename,
    fileSize:  result.fileSize,
    pageCount: result.pageCount,
  };
}
