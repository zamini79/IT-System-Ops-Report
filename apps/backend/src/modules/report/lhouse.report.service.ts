/**
 * LHOUSE 보고서 생성 서비스
 *
 * ── 차트 데이터 읽기 ────────────────────────────────────────────────────────
 *  Activity_LHOUSE.xlsx → Export 시트 B열
 *    B열: 이름(카테고리) 값 → 고유값별 건수 집계 → 도넛 차트
 *
 *  ── 왜 XML 직접 파싱인가 ──────────────────────────────────────────────────
 *  Export 시트 B열 셀이 inlineStr / sharedString / str 등 다양한 타입으로
 *  저장될 수 있어 SheetJS 만으로는 정확하게 읽히지 않을 수 있음.
 *  xlsx(ZIP)를 직접 해제하여 XML 원문을 파싱하고 타입별로 값을 추출함.
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
import {
  parseGcpMonthGroups,
  renderGcpBarToPng,
  renderGcpGroupedBarToPng,
} from "./dev.report.service";

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

// ── 차트 데이터 집계 ──────────────────────────────────────────────────────────

export interface CategoryCounts {
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
 * Activity_LHOUSE.xlsx → Export B열 카테고리별 건수 집계
 *
 * ── Export B열이 왜 직접 읽히지 않는가 ────────────────────────────────────
 * Export!B = LOOKUP(A, Category!A, Category!B)
 * xlsx 저장 시 수식 결과가 t="n"(숫자 0.0)으로 잘못 캐시됨.
 * SheetJS 및 XML 파싱 모두 실제 카테고리 텍스트를 읽지 못함.
 *
 * ── 대안: 서버에서 LOOKUP 직접 재계산 ─────────────────────────────────────
 * ① Category!A/B (SheetJS) → {name→category} 매핑 테이블 구성
 * ② Export!A (XML 직접파싱, inlineStr ~44,000행) → Activity 이름 목록 추출
 * ③ 각 Activity 이름을 LOOKUP 근사 매칭으로 카테고리 분류 → 건수 집계
 *
 * ── 왜 XML 직접 파싱인가 ──────────────────────────────────────────────────
 * Export!A 셀이 t="inlineStr" 타입으로 저장되어 SheetJS로 정상 파싱 불가.
 * xlsx(ZIP)를 압축 해제하여 XML 원문을 정규식으로 읽음.
 * Windows에서 Expand-Archive는 .xlsx 확장자를 거부하므로 .zip 복사본 사용.
 */
export function readExportBColumn(xlsxPath: string): CategoryCounts {
  logger.info(`[LHOUSE] Export B열(카테고리) 집계 시작: ${xlsxPath}`);

  // ── 암호화 검사 ───────────────────────────────────────────────────────────
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.readFile(xlsxPath);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/encrypt|password|ecma-376/i.test(msg)) {
      throw new AppError(400, "Activity_LHOUSE.xlsx 파일이 암호화(비밀번호 보호)되어 있습니다. Excel에서 암호를 해제한 후 다시 업로드해주세요.");
    }
    throw new AppError(400, `Activity_LHOUSE.xlsx 파일을 읽을 수 없습니다: ${msg}`);
  }

  // ── ① Category!A/B → {name → category} 매핑 테이블 (SheetJS) ──────────
  const catWs = wb.Sheets["Category"];
  if (!catWs) {
    logger.error("[LHOUSE] Category 시트 없음");
    return { labels: [], values: [], total: 0 };
  }

  const catRows = XLSX.utils.sheet_to_json<unknown[]>(catWs, { header: 1, defval: "" }) as unknown[][];
  const lookupTable = catRows
    .slice(1)
    .map((row) => ({
      name: String((row as unknown[])[0] ?? "").trim().replace(/\s+/g, " "),
      cat:  String((row as unknown[])[1] ?? "").trim().replace(/\s+/g, " "),
    }))
    .filter((e) => e.name && e.cat)
    .sort((a, b) => a.name.localeCompare(b.name));

  logger.info(`[LHOUSE] Category LOOKUP 테이블: ${lookupTable.length}개 항목`);

  // ── ② Export!A (inlineStr) XML 직접 파싱 ────────────────────────────────
  const tmpDir       = path.join(path.dirname(xlsxPath), `_tmp_${Date.now()}`);
  let   exportAValues: string[] = [];

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    if (process.platform === "win32") {
      // Expand-Archive는 .xlsx 확장자를 거부 → .zip 복사본으로 압축 해제
      const zipCopy = path.join(tmpDir, "source.zip");
      fs.copyFileSync(xlsxPath, zipCopy);
      const zipSrc = zipCopy.replace(/'/g, "''");
      const dst    = tmpDir.replace(/'/g, "''");
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipSrc}' -DestinationPath '${dst}' -Force"`,
        { stdio: "pipe", timeout: 60_000 }
      );
    } else {
      execSync(`unzip -o "${xlsxPath}" -d "${tmpDir}" 2>/dev/null`, { stdio: "pipe" });
    }

    const wbXml   = fs.readFileSync(path.join(tmpDir, "xl", "workbook.xml"), "utf-8");
    const relsXml = fs.readFileSync(path.join(tmpDir, "xl", "_rels", "workbook.xml.rels"), "utf-8");

    const sheetMatch = wbXml.match(/name="Export"[^>]+r:id="(rId\d+)"/);
    const rId        = sheetMatch?.[1];
    logger.info(`[LHOUSE] Export 시트 rId: ${rId ?? "미발견"}`);

    if (rId) {
      const relMatch  = relsXml.match(new RegExp(`Id="${rId}"[^>]*Target="([^"]+)"`));
      const relTarget = relMatch?.[1];
      const xmlPath   = relTarget
        ? (relTarget.startsWith("xl/") ? relTarget : `xl/${relTarget}`)
        : null;

      if (xmlPath) {
        const sheetXml = fs.readFileSync(path.join(tmpDir, ...xmlPath.split("/")), "utf-8");
        logger.info(`[LHOUSE] Export XML 크기: ${sheetXml.length.toLocaleString()} bytes`);

        for (const m of sheetXml.matchAll(
          /<c r="A\d+"[^>]*t="inlineStr"[^>]*><is><t>(.*?)<\/t><\/is><\/c>/g
        )) {
          exportAValues.push(normalizeXmlText(m[1]));
        }
        logger.info(`[LHOUSE] Export A열(inlineStr) 추출: ${exportAValues.length.toLocaleString()}건`);
      }
    }
  } catch (e) {
    logger.error(`[LHOUSE] Export XML 파싱 실패: ${(e as Error).message}`);
  } finally {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (exportAValues.length === 0) {
    logger.warn("[LHOUSE] Export A열에서 추출된 값 없음");
    return { labels: [], values: [], total: 0 };
  }

  // ── ③ LOOKUP 근사 매칭으로 카테고리별 건수 집계 ─────────────────────────
  const countsMap = new Map<string, number>();

  for (const name of exportAValues) {
    // Excel LOOKUP 근사 매칭: 정렬된 배열에서 ≤ name 인 마지막 항목 반환
    let cat: string | null = null;
    for (const entry of lookupTable) {
      if (entry.name.localeCompare(name) <= 0) cat = entry.cat;
      else break;
    }
    if (cat) countsMap.set(cat, (countsMap.get(cat) ?? 0) + 1);
  }

  logger.info(`[LHOUSE] 카테고리 분류 완료: ${[...countsMap.entries()].map(([k,v])=>`${k}:${v}`).join(", ")}`);

  if (countsMap.size === 0) {
    logger.warn("[LHOUSE] 카테고리 매칭 결과 없음");
    return { labels: [], values: [], total: 0 };
  }

  // 건수 내림차순 정렬 → 상위 9개 초과 시 "기타" 통합
  const MAX_SLICES = 9;
  const sorted = [...countsMap.entries()].sort((a, b) => b[1] - a[1]);

  let labels: string[];
  let values: number[];

  if (sorted.length <= MAX_SLICES) {
    labels = sorted.map(([k]) => k);
    values = sorted.map(([, v]) => v);
  } else {
    const top  = sorted.slice(0, MAX_SLICES);
    const rest = sorted.slice(MAX_SLICES);
    labels = [...top.map(([k]) => k), "기타"];
    values = [...top.map(([, v]) => v), rest.reduce((s, [, v]) => s + v, 0)];
  }

  const total = values.reduce((s, v) => s + v, 0);
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

  const PALETTE = [
    "#4472C4", "#ED7D31", "#A9D18E", "#5B9BD5", "#FFC000",
    "#FF7F50", "#7030A0", "#00B0F0", "#70AD47", "#C9C9C9",
  ];
  const bgColors = labels.map((_, i) => PALETTE[i % PALETTE.length]);

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

    // 인라인 스크립트의 JS 오류를 백엔드 로그로 캡처
    page.on("pageerror", (err) => {
      logger.error(`[LHOUSE] 도넛 차트 페이지 JS 오류: ${err.message}`);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        logger.warn(`[LHOUSE] 도넛 차트 콘솔 오류: ${msg.text()}`);
      }
    });

    await page.setViewportSize({ width: 400, height: 400 });
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });

    const loaded = await page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>).Chart !== "undefined"
    );
    logger.info(`[LHOUSE] Chart.js 로드: ${loaded ? "성공" : "실패"}`);

    // Chart.js 가 캔버스에 실제로 그릴 때까지 대기 — 도넛 위치(상단부) 픽셀 검사
    const drawn = await page.waitForFunction(() => {
      const canvas = document.getElementById("myChart") as HTMLCanvasElement | null;
      if (!canvas) return false;
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      const w = canvas.width, h = canvas.height;
      // 도넛 상단부(중앙 텍스트와 겹치지 않는 영역) 에서 알파 > 0 픽셀 검사
      const data = ctx.getImageData(Math.floor(w / 2) - 20, Math.floor(h * 0.2), 40, 10).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) return true;
      }
      return false;
    }, { timeout: 5_000 }).then(() => true).catch(() => false);

    if (!drawn) {
      logger.warn("[LHOUSE] 도넛 차트 캔버스 픽셀 미감지 — 추가 대기 후 캡처 시도");
      await page.waitForTimeout(1_500);
    } else {
      await page.waitForTimeout(200); // 그리기 안정화
    }

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
  const counts    = readExportBColumn(xlsxPath);
  if (counts.labels.length === 0) {
    logger.warn("[LHOUSE] Export B열 집계 결과 없음 — 차트 스킵");
    return { png: null, counts };
  }
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

// ── Veeva 데이터 수집 기반 차트 (GCP Quality System 보고서와 동일 방식) ─────────
//   LHOUSE_PerfStats.xlsx / LHOUSE_Quality.xlsx / LHOUSE_Training.json 를 읽어
//   #2 문서관리 · #3 품질관리 · #4 교육관리 · #5 사용자등록 · #6 일일사용 막대를 생성한다.

const LH_MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** 교육 화면 스크래핑의 Name(Created Date 월) 문자열 → 월 라벨/정렬키 */
export function parseTrainingMonth(name: string): { label: string; ym: string | null } {
  const s = String(name ?? "").trim();
  let m = s.match(/(\d{4})[-/.\s]+(\d{1,2})\b/);                     // 2026-03 / 2026/3
  if (m) { const mo = parseInt(m[2], 10); return { label: `${mo}월`, ym: `${m[1]}-${String(mo).padStart(2, "0")}` }; }
  m = s.match(/(\d{4})\s+([A-Za-z]{3,})/) ?? s.match(/([A-Za-z]{3,})\s+(\d{4})/);  // 2026 Mar / Mar 2026
  if (m) {
    const yr     = /^\d{4}$/.test(m[1]) ? m[1] : m[2];
    const monStr = /^\d{4}$/.test(m[1]) ? m[2] : m[1];
    const mo     = LH_MONTH_ABBR[monStr.slice(0, 3).toLowerCase()];
    if (mo) return { label: `${mo}월`, ym: `${yr}-${String(mo).padStart(2, "0")}` };
  }
  const mk = s.match(/(\d{1,2})\s*월/);                              // 3월
  if (mk) return { label: `${parseInt(mk[1], 10)}월`, ym: null };
  return { label: s, ym: null };
}

/** 월 라벨(2026 Mar / Mar 2026 / 2026-03 / 03/2026 …) → "YYYY-MM" (실패 시 null) */
function parseMonthLabel(s: string): string | null {
  const t   = String(s ?? "").trim();
  const pad = (n: number) => String(n).padStart(2, "0");
  let m = t.match(/(\d{4})\s+([A-Za-z]{3,})/);                 // 2026 Mar / 2026 March
  if (m) { const mo = LH_MONTH_ABBR[m[2].slice(0, 3).toLowerCase()]; if (mo) return `${m[1]}-${pad(mo)}`; }
  m = t.match(/([A-Za-z]{3,})\s+(\d{4})/);                     // Mar 2026 / March 2026
  if (m) { const mo = LH_MONTH_ABBR[m[1].slice(0, 3).toLowerCase()]; if (mo) return `${m[2]}-${pad(mo)}`; }
  m = t.match(/\b(\d{4})[-/.](\d{1,2})\b/);                    // 2026-03 / 2026/3 / 2026-03-01
  if (m) { const mo = parseInt(m[2], 10); if (mo >= 1 && mo <= 12) return `${m[1]}-${pad(mo)}`; }
  m = t.match(/\b(\d{1,2})\/(\d{4})\b/);                       // 03/2026
  if (m) { const mo = parseInt(m[1], 10); if (mo >= 1 && mo <= 12) return `${m[2]}-${pad(mo)}`; }
  return null;
}

/**
 * L HOUSE 품질 리포트(Formatted) 파싱 → 월 × Quality Event Type 분포.
 *
 * Excel 구조(2단 그룹):
 *   A열 "Quality Event Type: <type>"            ← 상위 분류
 *   A열   "Created Date(Month): <month>"  B열 N  ← 하위 분류(월) + Quality Event Count
 *   A열   "Created Date(Month): <month>"  B열 N
 *   A열 "Quality Event Type: <next type>"
 *   ...
 * → Type별 월 집계를 '월' 기준으로 뒤집어 byMonth[YYYY-MM][type] = count 로 만든다.
 */
export function parseLhouseQualityByType(
  xlsxPath: string,
): { types: string[]; byMonth: Record<string, Record<string, number>> } {
  const byMonth: Record<string, Record<string, number>> = {};
  const types: string[] = [];
  try {
    const wb   = XLSX.readFile(xlsxPath);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" }
    ) as unknown[][];

    const numAt = (r: unknown[], i: number): number => {
      const raw = String(r[i] ?? "").trim();
      const n   = Number(raw.replace(/,/g, ""));
      return raw !== "" && Number.isFinite(n) ? n : NaN;
    };
    const firstNum = (r: unknown[]): number => {
      for (let i = 1; i < r.length; i++) { const n = numAt(r, i); if (Number.isFinite(n)) return n; }
      return NaN;
    };

    let curType: string | null = null;
    for (const r of rows) {
      const a = String(r[0] ?? "").trim();

      // 상위 분류: Quality Event Type
      const tm = a.match(/Quality Event Type:\s*(.+?)\s*(?:\([\d,]+\))?\s*$/i);
      if (tm) {
        const t = tm[1].trim();
        curType = (!t || /^all\b/i.test(t)) ? null : t;   // "All Quality Event Type" 총계행 제외
        if (curType && !types.includes(curType)) types.push(curType);
        continue;
      }

      // 하위 분류: Created Date(Month) — 현재 타입의 해당 월 건수(B열)를 기록
      const mm = a.match(/Created\s*Date\s*\(Month\):\s*(.+?)\s*$/i);
      if (mm && curType) {
        const ym = parseMonthLabel(mm[1]);
        if (!ym || /^all\b/i.test(mm[1].trim())) continue;  // "All Created Date" 총계행 제외
        let val = numAt(r, 1);                              // B열 = Quality Event Count
        if (!Number.isFinite(val)) val = firstNum(r);       // 폴백: 첫 숫자 셀
        if (!Number.isFinite(val)) val = 0;
        byMonth[ym] = byMonth[ym] ?? {};
        byMonth[ym][curType] = (byMonth[ym][curType] ?? 0) + val;
      }
    }
  } catch (e) {
    logger.warn(`[LHOUSE Report] 품질 세분화 파싱 실패: ${(e as Error).message}`);
  }
  return { types, byMonth };
}

interface LhouseVeevaCharts {
  docCount:    string | null;  // #2 문서 관리 (E Doc Count 월평균)
  quality:     string | null;  // #3 품질 관리 (Quality Event Type 월별 그룹)
  training:    string | null;  // #4 교육 관리 (월별 Activity count)
  activeUser:  string | null;  // #5 사용자 등록 (B Active User 월평균)
  uniqueLogin: string | null;  // #6 일일 사용 (D Unique Login 월평균)
  msgs: { doc: string; quality: string; training: string; user: string; login: string };
  insight: string[];
  data: { docLast: number; userLast: number; loginLast: number; qualityTotal: number; trainingTotal: number };
}

async function buildLhouseVeevaCharts(uploadPath: string): Promise<LhouseVeevaCharts | null> {
  const perf      = path.join(uploadPath, "LHOUSE_PerfStats.xlsx");
  const qual      = path.join(uploadPath, "LHOUSE_Quality.xlsx");
  const trainJson = path.join(uploadPath, "LHOUSE_Training.json");
  if (!fs.existsSync(perf) && !fs.existsSync(qual) && !fs.existsSync(trainJson)) return null;

  // PerfStats: B(1)=Active User, D(3)=Unique Login, E(4)=Doc Count
  const doc   = fs.existsSync(perf) ? parseGcpMonthGroups(perf, 4) : {};
  const user  = fs.existsSync(perf) ? parseGcpMonthGroups(perf, 1) : {};
  const login = fs.existsSync(perf) ? parseGcpMonthGroups(perf, 3) : {};

  const monthsSet = new Set<string>([...Object.keys(doc), ...Object.keys(user), ...Object.keys(login)]);
  const months = [...monthsSet].sort().slice(-3);
  const labels = months.map((ym) => `${parseInt(ym.slice(5, 7), 10)}월`);
  const series = (m: Record<string, number>) => months.map((ym) => Math.round(m[ym] ?? 0));

  const renderBar = async (lbls: string[], vals: number[], color: string, name: string): Promise<string | null> => {
    if (!lbls.length || vals.every((v) => v === 0)) return null;
    try {
      const p = path.join(uploadPath, `lhouse_bar_${name}_${Date.now()}.png`);
      await renderGcpBarToPng(lbls, vals, color, p);
      return fs.readFileSync(p).toString("base64");
    } catch (e) { logger.warn(`[LHOUSE Report] bar(${name}) 실패: ${(e as Error).message}`); return null; }
  };

  const docV = series(doc), userV = series(user), loginV = series(login);
  const docCount    = await renderBar(labels, docV,   "#4472C4", "doc");
  const activeUser  = await renderBar(labels, userV,  "#5B9BD5", "user");
  const uniqueLogin = await renderBar(labels, loginV, "#70AD47", "login");

  // #3 품질 — 매월 Quality Event Type 분포 (그룹 막대)
  const qt = fs.existsSync(qual) ? parseLhouseQualityByType(qual) : { types: [], byMonth: {} };
  const qMonthsSet = new Set<string>(Object.keys(qt.byMonth));
  const qMonths = qMonthsSet.size ? [...qMonthsSet].sort().slice(-3) : months;
  const qLabels = qMonths.map((ym) => /^\d{4}-\d{2}$/.test(ym) ? `${parseInt(ym.slice(5, 7), 10)}월` : ym);
  logger.info(`[LHOUSE Report] 품질 파싱 — types:[${qt.types.join(", ")}] buckets:[${Object.keys(qt.byMonth).join(", ")}]`);
  let quality: string | null = null;
  let qualityTotal = 0;
  if (qt.types.length) {
    const palette = ["#ED7D31", "#4472C4", "#70AD47", "#FFC000", "#A5A5A5"];
    const qSeries = qt.types.map((t, i) => ({
      name: t, color: palette[i % palette.length],
      values: qMonths.map((ym) => Math.round(qt.byMonth[ym]?.[t] ?? 0)),
    }));
    qualityTotal = qSeries.reduce((s, ser) => s + ser.values.reduce((a, b) => a + b, 0), 0);
    if (qSeries.some((s) => s.values.some((v) => v > 0))) {
      try {
        const p = path.join(uploadPath, `lhouse_bar_quality_${Date.now()}.png`);
        await renderGcpGroupedBarToPng(qLabels, qSeries, p);
        quality = fs.readFileSync(p).toString("base64");
      } catch (e) { logger.warn(`[LHOUSE Report] bar(quality) 실패: ${(e as Error).message}`); }
    }
  }

  // #4 교육 — 화면 스크래핑 JSON (rows:[{name, count}])
  let training: string | null = null;
  let trainingTotal = 0;
  let trnLabels: string[] = [];
  if (fs.existsSync(trainJson)) {
    try {
      const raw  = JSON.parse(fs.readFileSync(trainJson, "utf-8")) as { rows?: { name: string; count: number }[] };
      const rows = (raw.rows ?? []).map((r) => ({ ...parseTrainingMonth(r.name), count: Number(r.count) || 0 }));
      if (rows.every((r) => r.ym)) rows.sort((a, b) => (a.ym ?? "").localeCompare(b.ym ?? ""));
      const last3 = rows.slice(-3);
      trnLabels   = last3.map((r) => r.label);
      const trnVals = last3.map((r) => r.count);
      trainingTotal = trnVals.reduce((a, b) => a + b, 0);
      training = await renderBar(trnLabels, trnVals, "#FFC000", "training");
    } catch (e) { logger.warn(`[LHOUSE Report] 교육 JSON 파싱 실패: ${(e as Error).message}`); }
  }

  const lastN = (a: number[]) => a[a.length - 1] ?? 0;
  const lm    = labels[labels.length - 1] ?? "";
  const msgs = {
    doc:      `${lm} 평균 약 <strong>${lastN(docV).toLocaleString()}</strong>건 문서 관리 중`,
    quality:  `최근 3개월 품질 이벤트 총 <strong>${qualityTotal.toLocaleString()}</strong>건`,
    training: `최근 ${trnLabels.length || 3}개월 교육 실행 총 <strong>${trainingTotal.toLocaleString()}</strong>건`,
    user:     `${lm} 평균 등록 사용자 약 <strong>${lastN(userV).toLocaleString()}</strong>명`,
    login:    `${lm} 일평균 접속 약 <strong>${lastN(loginV).toLocaleString()}</strong>명`,
  };

  const insight = buildLhouseInsightLines({ labels, docV, userV, loginV, qLabels, qMonths, qt, trainingTotal, trnLabels });

  logger.info(`[LHOUSE Report] Veeva 차트 — 월:${months.join(",")} doc:${docV} user:${userV} login:${loginV} quality:${qualityTotal} training:${trainingTotal}`);
  return {
    docCount, quality, training, activeUser, uniqueLogin, msgs, insight,
    data: { docLast: lastN(docV), userLast: lastN(userV), loginLast: lastN(loginV), qualityTotal, trainingTotal },
  };
}

/** L HOUSE 데이터 인사이트 — 연결어미로 잇고 마지막만 종결형 (GCP 인사이트와 동일 컨셉) */
export function buildLhouseInsightLines(a: {
  labels: string[]; docV: number[]; userV: number[]; loginV: number[];
  qLabels: string[]; qMonths: string[]; qt: { types: string[]; byMonth: Record<string, Record<string, number>> };
  trainingTotal: number; trnLabels: string[];
}): string[] {
  const { labels, docV, userV, loginV, qLabels, qMonths, qt, trainingTotal, trnLabels } = a;
  const fmt   = (n: number) => Math.round(n).toLocaleString();
  const first = (x: number[]) => x[0] ?? 0;
  const last  = (x: number[]) => x[x.length - 1] ?? 0;
  const nz    = (x: number[]) => { const f = x.filter((v) => v > 0); return f.length ? [Math.min(...f), Math.max(...f)] as const : [0, 0] as const; };
  const tword = (x: number[]) => last(x) > first(x) ? "증가" : last(x) < first(x) ? "감소" : "유지";
  const range = labels.length ? `${labels[0]}~${labels[labels.length - 1]}` : "";
  const lines: string[] = [];

  if (docV.some((v) => v > 0)) {
    lines.push(`최근 3개월(${range}) 안동공장 L HOUSE Veeva Quality System의 문서 수는 월평균 ${fmt(first(docV))}→${fmt(last(docV))}건으로 ${tword(docV)} 흐름을 보였으며,`);
  }
  const [uMin, uMax] = nz(userV);
  const [lMin, lMax] = nz(loginV);
  const uStr = uMin === uMax ? `약 ${fmt(uMax)}명` : `약 ${fmt(uMin)}~${fmt(uMax)}명`;
  const lStr = lMin === lMax ? `약 ${fmt(lMax)}명` : `약 ${fmt(lMin)}~${fmt(lMax)}명`;
  lines.push(`활성 사용자는 ${uStr}, 일일 평균 접속은 ${lStr} 수준을 유지했고,`);

  const qTotal = qMonths.reduce((s, ym) => s + qt.types.reduce((t, ty) => t + (qt.byMonth[ym]?.[ty] ?? 0), 0), 0);
  if (qTotal > 0) {
    const perType = qt.types
      .map((t) => `${t} ${fmt(qMonths.reduce((s, ym) => s + (qt.byMonth[ym]?.[t] ?? 0), 0))}건`)
      .join("·");
    const perMonth = qLabels
      .map((l, i) => `${l} ${qt.types.reduce((s, t) => s + (qt.byMonth[qMonths[i]]?.[t] ?? 0), 0)}건`)
      .join(", ");
    lines.push(`품질 이벤트는 ${perMonth}으로 발생했고(전체 ${qTotal}건${perType ? `, ${perType}` : ""}),`);
  }
  if (trainingTotal > 0) {
    lines.push(`교육은 최근 ${trnLabels.length || 3}개월간 총 ${fmt(trainingTotal)}건 실행되었습니다.`);
  }

  if (lines.length) {
    const i = lines.length - 1;
    lines[i] = lines[i]
      .replace(/보였으며,$/, "보였습니다.")
      .replace(/유지했고,$/, "유지했습니다.")
      .replace(/\),$/, ").");
  }
  return lines;
}

function buildReportHtml(
  titleDate:         string,
  chartImgBase64:    string | null,
  chartImgMime:      "image/png" | "image/jpeg",
  /** Veeva 데이터 수집 기반 #2~#6 차트 묶음 */
  veeva:             LhouseVeevaCharts,
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

  // ── 이미지 래퍼 헬퍼 ──────────────────────────────────────────────────────
  const imgCell = (b64: string | null, alt: string) =>
    b64
      ? `<div class="img-wrap"><img src="data:image/png;base64,${b64}" alt="${alt}" /></div>`
      : `<div class="img-wrap" style="color:#9ca3af;font-size:12px;">데이터 없음</div>`;

  // ── 1번: 업무 활용 현황 — 도넛 차트(Activity_LHOUSE.xlsx, 기존 유지) ─────────
  const donutImgHtml = chartImgBase64
    ? `<div class="img-wrap"><img src="data:${chartImgMime};base64,${chartImgBase64}" alt="업무 활용 현황" /></div>`
    : `<div class="img-wrap" style="color:#9ca3af;font-size:12px;">차트 없음</div>`;
  const cell1Msg = `${monthLabel} 총 실행된 Task는 <strong>${stats.totalTasks.toLocaleString()}</strong>건`;

  // ── 6개 차트 (2열 × 3행, 단일 페이지) ─ ①업무활용 ②문서관리 ③품질관리 ④교육관리 ⑤사용자등록 ⑥일일사용
  const allCells: string[] = [
    makeCell(1, CHART_TITLES[0], donutImgHtml,                       cell1Msg),
    makeCell(2, CHART_TITLES[1], imgCell(veeva.docCount,    CHART_TITLES[1]), veeva.msgs.doc),
    makeCell(3, CHART_TITLES[2], imgCell(veeva.quality,     CHART_TITLES[2]), veeva.msgs.quality),
    makeCell(4, CHART_TITLES[3], imgCell(veeva.training,    CHART_TITLES[3]), veeva.msgs.training),
    makeCell(5, CHART_TITLES[4], imgCell(veeva.activeUser,  CHART_TITLES[4]), veeva.msgs.user),
    makeCell(6, CHART_TITLES[5], imgCell(veeva.uniqueLogin, CHART_TITLES[5]), veeva.msgs.login),
  ];
  // 인사이트가 들어가도 한 페이지에 맞도록 행 높이를 줄인다(grid-3row-gcp).
  const grid = `<div class="usage-grid grid-3row-gcp">${allCells.join("\n")}</div>`;

  // ── 데이터 인사이트 (GCP Quality System 보고서와 동일 — 페이지 하단) ──────────
  const insightHtml = veeva.insight.length > 0
    ? `<div class="gcp-insight">
        <div class="gcp-insight-label">데이터 인사이트 (최근 3개월 분석)</div>
        ${veeva.insight.map((l) => `<p>${l}</p>`).join("")}
      </div>`
    : "";

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
    ${insightHtml}
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
            <span>SK Bioscience L HOUSE 공장 — Veeva System 운영 현황</span>
            <span>${titleDate}</span>
          </div>
        </td></tr>
      </tfoot>
    </table>
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

  logger.info(`[LHOUSE Report] 보고서 생성 요청 — jobId: ${jobId}`);
  logger.info(`[LHOUSE Report] Activity_LHOUSE.xlsx : ${activityPath} (존재: ${fs.existsSync(activityPath)})`);

  if (!fs.existsSync(activityPath)) throw new AppError(400, "Activity_LHOUSE.xlsx 파일이 없습니다. 먼저 업로드해주세요.");

  // 1) #1 업무 활용 현황 — 도넛 차트 PNG + CategoryCounts (Activity_LHOUSE.xlsx, 기존 유지)
  logger.info("[LHOUSE Report] ── 업무 활용(도넛) 차트 생성 ──");
  const { png: chartPng, counts } = await generateChartPng(activityPath, uploadPath);
  if (!chartPng) logger.warn("[LHOUSE Report] 차트 이미지 생성 실패 — PDF 에 대체 텍스트 표시");
  else logger.info(`[LHOUSE Report] 차트 PNG: ${chartPng} (${fs.statSync(chartPng).size.toLocaleString()} bytes)`);

  let chartBase64: string | null              = null;
  let chartMime:   "image/png" | "image/jpeg" = "image/png";
  if (chartPng && fs.existsSync(chartPng)) {
    chartBase64 = fs.readFileSync(chartPng).toString("base64");
    chartMime   = /\.jpe?g$/i.test(chartPng) ? "image/jpeg" : "image/png";
  }

  // 2) #2~#6 — Veeva 데이터 수집(LHOUSE_PerfStats/Quality/Training) 기반 막대/그룹 차트
  logger.info("[LHOUSE Report] ── Veeva 데이터 차트 생성 ──");
  const veeva = await buildLhouseVeevaCharts(uploadPath);
  if (!veeva) {
    throw new AppError(
      400,
      "Veeva 수집 데이터(LHOUSE_PerfStats.xlsx 등)가 없습니다. 먼저 '데이터 수집'을 실행해주세요.",
    );
  }

  // 3) 헤드라인 통계 — 업무활용(Task)은 Activity, 나머지는 수집 데이터에서 산출
  const findCount = (keyword: string) => {
    const idx = counts.labels.findIndex((l) => l.toLowerCase().includes(keyword.toLowerCase()));
    return idx >= 0 ? counts.values[idx] : 0;
  };
  const stats: HeadlineStats = {
    activeUsers:   veeva.data.userLast,
    uniqueLogin:   veeva.data.loginLast,
    totalTasks:    counts.total,
    eLmsTasks:     findCount("eLMS"),
    eDmsTasks:     findCount("eDMS"),
    newDocuments:  veeva.data.docLast,
    qualityEvents: veeva.data.qualityTotal,
    trainings:     veeva.data.trainingTotal,
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
    if (e instanceof AppError) throw e;
    logger.error(`[LHOUSE Report] Timesheet 처리 실패 (무시): ${(e as Error).message}`);
    msData = null;
  }

  // 4) PDF
  const { year, month } = getLastMonth();
  const titleDate  = `${year}년 ${String(month).padStart(2, "0")}월`;
  const html       = buildReportHtml(titleDate, chartBase64, chartMime, veeva, stats, msData, msBarChartBase64);
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
