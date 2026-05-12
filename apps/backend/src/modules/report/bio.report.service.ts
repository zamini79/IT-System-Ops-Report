/**
 * BIO (Bio연구본부) 보고서 생성 서비스
 *
 * 페이지 구성:
 *  - 표지: "Bio연구본부 시스템 운영 현황"
 *  - Page 1: "1. Veeva 시스템 사용현황" — Systemusage_RD.jpg 5개 차트 그리드
 *  - Page 2 (선택): "2. Managed Service 진행 현황"
 *                   MS Timesheet (DB 에서 최신 파일 조회)
 */

import fs   from "fs";
import path from "path";

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

// ── 이미지 분할 헬퍼 ──────────────────────────────────────────────────────────

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
 * Systemusage_RD 이미지를 3열×2행 그리드에서 5개 차트로 분할합니다.
 *
 * 이미지 내 차트 배치 (3열 × 2행):
 *   [0] 업무 활용 현황  | [1] 문서 관리 현황 | [2] 생성 문서 구분
 *   [3] 사용자 현황    | [4] 일일 사용 현황 | (빈 공간)
 *
 * 인덱스 0~4 (5개)만 반환합니다.
 */
async function split5Charts(
  imgPath: string,
  outDir:  string,
): Promise<ChartImg[]> {
  fs.mkdirSync(outDir, { recursive: true });

  const meta = await sharp(imgPath).metadata();
  const W    = (meta.width  as number) ?? 1478;
  const H    = (meta.height as number) ?? 960;
  const COLS = 3, ROWS = 2;
  const cellW = Math.floor(W / COLS);
  const cellH = Math.floor(H / ROWS);

  logger.info(`[BIO Report] Veeva RD 이미지 분할 — 원본: ${W}×${H}, 셀: ${cellW}×${cellH}`);

  const results: ChartImg[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const idx = row * COLS + col;
      if (idx >= 5) break;  // 5번째(인덱스 4)까지만 추출
      const left   = col * cellW;
      const top    = row * cellH;
      const width  = col === COLS - 1 ? W - left : cellW;
      const height = row === ROWS - 1 ? H - top  : cellH;
      const out    = path.join(outDir, `rd_split_${idx}.png`);
      await sharp(imgPath).extract({ left, top, width, height }).png().toFile(out);
      results.push({ base64: fs.readFileSync(out).toString("base64"), mime: "image/png" });
      logger.info(`[BIO Report] Veeva RD 셀 ${idx}: ${out} (${fs.statSync(out).size.toLocaleString()} B)`);
    }
  }
  return results;
}

// ── OCR 헬퍼 ─────────────────────────────────────────────────────────────────

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
  keepFile = false,  // true 시 OCR 진단용 중간 이미지를 삭제하지 않고 유지
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
    if (!keepFile) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 임시 파일 삭제 실패는 무시 */ }
    }
  }
}

/** 콤마 포함 숫자 파싱: "1,014" → 1014 */
function parseCommaInt(s: string): number {
  return parseInt(s.replace(/,/g, ""), 10);
}

/**
 * chart4 사용자 현황 — 세로 막대 3개 중 가장 오른쪽 막대 상단 숫자 (#1)
 * 전략: 우측 30% × 상단 72% 크롭 → PSM 11 + normalize → 첫 번째 유효 정수
 */
async function extractBioRightmostBar(imagePath: string, label: string): Promise<number> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[BIO OCR] 파일 없음: ${imagePath}`); return 0; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();
  const left = Math.floor(W * 0.70), top = 0;
  const width = W - left, height = Math.floor(H * 0.72);
  try {
    const text = await ocrCrop(imagePath, { left, top, width, height }, 6, "11", "norm", `bio_${label}`);
    logger.info(`[BIO OCR] ${label} 텍스트: "${text}"`);
    const numbers = (text.match(/\d[\d,]*/g) ?? [])
      .map(parseCommaInt)
      .filter(n => !isNaN(n) && n >= 1 && n <= 999_999 && !(n >= 2000 && n <= 2030));
    logger.info(`[BIO OCR] ${label} 추출: ${JSON.stringify(numbers)}`);
    return numbers[0] ?? 0;
  } catch (e) {
    logger.error(`[BIO OCR] ${label} 실패: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * chart5 일일 사용 현황 (Unique Login) — 오른쪽 막대 상단 숫자 (#2)
 *
 * 3개 막대 = 3개월 비교 차트 (시간순: 왼쪽=이전월, 오른쪽=보고서 대상월)
 *
 * 근본 원인:
 *  - 연도 필터 없이 상단 75% 크롭 시 차트 제목의 "2025" 같은 연도가 nums[0] 으로 반환됨
 *  - 막대가 짧을 경우 상단 75% 크롭에 막대 레이블이 포함되지 않을 수 있음
 *
 * 수정 전략 (모두 연도 필터 + keepFile=true 진단용 이미지 보존):
 *  S1: 우측 30% × 전체 높이, scale 6, norm   — chart4 와 동일 파라미터 (검증된 설정)
 *  S2: 우측 30% × 전체 높이, scale 6, thresh — S1 실패 시
 *  S3: 우측 33% × 전체 높이, scale 10, norm  — 소형 텍스트 고배율
 *  S4: 우측 40% × 전체 높이, scale 6, PSM 6 — 블록 텍스트 모드, 마지막 숫자
 *  S5: 전체 너비 × 전체 높이, scale 4, norm  — 완전 폴백, 마지막 숫자
 */
async function extractBioUniqueLoginBar(imagePath: string): Promise<number> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[BIO OCR] 파일 없음: ${imagePath}`); return 0; }
  const { width: W = 493, height: H = 480 } = await sharp(imagePath).metadata();

  /**
   * 모든 전략에 공통 적용: 연도(2000-2030) 필터 포함
   * — 이전 parseTop 은 연도 필터가 없어 차트 제목의 연도가 nums[0] 으로 반환되는 버그 존재
   */
  const parseNums = (text: string): number[] =>
    (text.match(/\d[\d,]*/g) ?? [])
      .map(parseCommaInt)
      .filter(n => !isNaN(n) && n >= 1 && n <= 99_999 && !(n >= 2000 && n <= 2030));

  const left30 = Math.floor(W * 0.70);
  const left33 = Math.floor(W * 0.67);
  const left40 = Math.floor(W * 0.60);

  // S1: 우측 30% × 전체 높이, scale 6, PSM 11, norm (chart4 extractBioRightmostBar 동일 파라미터)
  // keepFile=true → uploads/{jobId}/rd_split_4_ocr_bio_ul_s1.png 로 저장 (진단용)
  try {
    const text = await ocrCrop(imagePath,
      { left: left30, top: 0, width: W - left30, height: H },
      6, "11", "norm", "bio_ul_s1", true);
    const nums = parseNums(text);
    logger.info(`[BIO OCR] chart5 [S1 right30% full-H norm] "${text}" → ${JSON.stringify(nums)}`);
    if (nums.length > 0) { logger.info(`[BIO OCR] chart5 ✓S1 → ${nums[0]}`); return nums[0]; }
  } catch (e) { logger.error(`[BIO OCR] chart5 S1: ${(e as Error).message}`); }

  // S2: 우측 30% × 전체 높이, scale 6, PSM 11, thresh
  try {
    const text = await ocrCrop(imagePath,
      { left: left30, top: 0, width: W - left30, height: H },
      6, "11", "thresh", "bio_ul_s2", true);
    const nums = parseNums(text);
    logger.info(`[BIO OCR] chart5 [S2 right30% full-H thresh] "${text}" → ${JSON.stringify(nums)}`);
    if (nums.length > 0) { logger.info(`[BIO OCR] chart5 ✓S2 → ${nums[0]}`); return nums[0]; }
  } catch (e) { logger.error(`[BIO OCR] chart5 S2: ${(e as Error).message}`); }

  // S3: 우측 33% × 전체 높이, scale 10, PSM 11, norm (소형 텍스트 고배율)
  try {
    const text = await ocrCrop(imagePath,
      { left: left33, top: 0, width: W - left33, height: H },
      10, "11", "norm", "bio_ul_s3", true);
    const nums = parseNums(text);
    logger.info(`[BIO OCR] chart5 [S3 right33% full-H scale10] "${text}" → ${JSON.stringify(nums)}`);
    if (nums.length > 0) { logger.info(`[BIO OCR] chart5 ✓S3 → ${nums[0]}`); return nums[0]; }
  } catch (e) { logger.error(`[BIO OCR] chart5 S3: ${(e as Error).message}`); }

  // S4: 우측 40% × 전체 높이, scale 6, PSM 6 (블록 텍스트), norm — 마지막 숫자 = 오른쪽 막대
  try {
    const text = await ocrCrop(imagePath,
      { left: left40, top: 0, width: W - left40, height: H },
      6, "6", "norm", "bio_ul_s4", true);
    const nums = parseNums(text);
    logger.info(`[BIO OCR] chart5 [S4 right40% full-H PSM6] "${text}" → ${JSON.stringify(nums)}`);
    if (nums.length > 0) { const v = nums[nums.length - 1]; logger.info(`[BIO OCR] chart5 ✓S4 → ${v}`); return v; }
  } catch (e) { logger.error(`[BIO OCR] chart5 S4: ${(e as Error).message}`); }

  // S5: 전체 너비 × 전체 높이, scale 4, PSM 11, norm — 완전 폴백, 마지막 숫자
  try {
    const text = await ocrCrop(imagePath,
      { left: 0, top: 0, width: W, height: H },
      4, "11", "norm", "bio_ul_s5", true);
    const nums = parseNums(text);
    logger.info(`[BIO OCR] chart5 [S5 full-image] "${text}" → ${JSON.stringify(nums)}`);
    if (nums.length > 0) { const v = nums[nums.length - 1]; logger.info(`[BIO OCR] chart5 ✓S5 → ${v}`); return v; }
  } catch (e) { logger.error(`[BIO OCR] chart5 S5: ${(e as Error).message}`); }

  logger.warn("[BIO OCR] chart5 ✗ 모든 전략 실패 → 0");
  return 0;
}

/**
 * 업무 활용 현황 (chart1) — 가로 막대 10개
 *  - sum (#3): 우측 25% × 전체 높이 → 모든 유효 정수 합산
 *  - top (#4): 우측 25% × 상단 20% → 가장 위 막대의 값 (첫 번째 숫자)
 */
async function extractBioTaskSumAndMax(imagePath: string): Promise<{ sum: number; top: number }> {
  if (!fs.existsSync(imagePath)) { logger.warn(`[BIO OCR] 파일 없음: ${imagePath}`); return { sum: 0, top: 0 }; }
  const { width: W = 548, height: H = 477 } = await sharp(imagePath).metadata();
  const left  = Math.floor(W * 0.75);
  const width = W - left;

  // #3: 전체 오른쪽 → 모든 막대 값 합산
  let sum = 0;
  try {
    const text = await ocrCrop(imagePath, { left, top: 0, width, height: H }, 6, "11", "norm", "bio_task_all");
    logger.info(`[BIO OCR] chart1(task-all) 텍스트: "${text}"`);
    const numbers = (text.match(/\d[\d,]*/g) ?? [])
      .map(parseCommaInt)
      .filter(n => !isNaN(n) && n >= 1 && n <= 999_999 && !(n >= 2000 && n <= 2030));
    logger.info(`[BIO OCR] chart1(task-all) 숫자: ${JSON.stringify(numbers)}`);
    sum = numbers.reduce((s, n) => s + n, 0);
  } catch (e) {
    logger.error(`[BIO OCR] chart1(task-all) 실패: ${(e as Error).message}`);
  }

  // #4: 상단 20% 크롭 → 가장 위 막대 값 (첫 번째 숫자)
  let top = 0;
  try {
    const topH = Math.floor(H * 0.20);
    const text  = await ocrCrop(imagePath, { left, top: 0, width, height: topH }, 8, "11", "norm", "bio_task_top");
    logger.info(`[BIO OCR] chart1(task-top) 텍스트: "${text}"`);
    const numbers = (text.match(/\d[\d,]*/g) ?? [])
      .map(parseCommaInt)
      .filter(n => !isNaN(n) && n >= 1 && n <= 999_999 && !(n >= 2000 && n <= 2030));
    logger.info(`[BIO OCR] chart1(task-top) 숫자: ${JSON.stringify(numbers)}`);
    top = numbers[0] ?? 0;
  } catch (e) {
    logger.error(`[BIO OCR] chart1(task-top) 실패: ${(e as Error).message}`);
  }

  return { sum, top };
}

/** Bio Veeva 헤드라인용 OCR 통계 */
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

function buildBioReportHtml(
  titleDate:         string,
  veevaCharts:       Array<ChartImg | null>,
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
      const c       = veevaCharts;
      const hasAny  = c.some(Boolean);
      if (!hasAny) {
        return `<div class="placeholder-box">Systemusage_RD.jpg 파일을 업로드하면 차트가 표시됩니다.</div>`;
      }
      const cells = [
        makeCell(1, VEEVA_RD_CHART_TITLES[0], c[0] ?? null),
        makeCell(2, VEEVA_RD_CHART_TITLES[1], c[1] ?? null),
        makeCell(3, VEEVA_RD_CHART_TITLES[2], c[2] ?? null),
        makeCell(4, VEEVA_RD_CHART_TITLES[3], c[3] ?? null),
        makeCell(5, VEEVA_RD_CHART_TITLES[4], c[4] ?? null),
        `<div></div>`,  // 6번째 빈 셀
      ];
      return `<div class="usage-grid grid-3row">${cells.join("\n")}</div>`;
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

  // ── Systemusage_RD 이미지 → 5개 차트 분할 ──────────────────────────────────
  let veevaCharts: Array<ChartImg | null> = [null, null, null, null, null];

  const rdSrc = resolveImagePath(uploadPath, "Systemusage_RD");
  logger.info(`[BIO Report] Systemusage_RD: ${rdSrc ?? "없음"}`);

  if (rdSrc) {
    try {
      const charts = await split5Charts(rdSrc, uploadPath);
      veevaCharts  = [
        charts[0] ?? null,
        charts[1] ?? null,
        charts[2] ?? null,
        charts[3] ?? null,
        charts[4] ?? null,
      ];
    } catch (e) {
      logger.error(`[BIO Report] Veeva RD 이미지 분할 실패: ${(e as Error).message}`);
    }
  }

  // ── OCR: Veeva 헤드라인 통계 (#1~#4) ─────────────────────────────────────
  // 항상 0으로 초기화 — OCR 실패 시에도 burnedMs(#5) 읽기가 실행되도록
  const veevaStats: BioVeevaStats = { totalUsers: 0, dailyAvgLogin: 0, taskTotal: 0, taskTop: 0, burnedMs: 0 };

  if (rdSrc && veevaCharts.some(Boolean)) {
    const chart1Path = path.join(uploadPath, "rd_split_0.png");  // 업무 활용 현황
    const chart4Path = path.join(uploadPath, "rd_split_3.png");  // 사용자 현황
    const chart5Path = path.join(uploadPath, "rd_split_4.png");  // 일일 사용 현황

    // 각 OCR 독립 실행 — 하나 실패해도 나머지 계속
    try {
      const taskStats = await extractBioTaskSumAndMax(chart1Path);
      veevaStats.taskTotal = taskStats.sum;
      veevaStats.taskTop   = taskStats.top;
    } catch (e) { logger.error(`[BIO Report] chart1 OCR 실패: ${(e as Error).message}`); }

    try {
      veevaStats.totalUsers = await extractBioRightmostBar(chart4Path, "chart4_user");
    } catch (e) { logger.error(`[BIO Report] chart4 OCR 실패: ${(e as Error).message}`); }

    try {
      veevaStats.dailyAvgLogin = await extractBioUniqueLoginBar(chart5Path);  // #2 전용 멀티전략
    } catch (e) { logger.error(`[BIO Report] chart5 OCR 실패: ${(e as Error).message}`); }

    logger.info(`[BIO Report] OCR 통계 (burnedMs 제외): ${JSON.stringify(veevaStats)}`);
  }

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
    logger.error(`[BIO Report] Timesheet 처리 실패 (무시): ${(e as Error).message}`);
    msData = null;
  }

  // HTML → PDF 생성
  const { year, month } = getLastMonth();
  const titleDate  = `${year}년 ${String(month).padStart(2, "0")}월`;
  const html       = buildBioReportHtml(titleDate, veevaCharts, msData, msBarChartBase64, veevaStats);
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

  // 1행(index 0) → Description 텍스트
  const description = (raw[0] as unknown[])
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

  // 3행(index 2)부터 데이터 읽기
  const rows: LimsServiceRow[] = [];
  for (let i = 2; i < raw.length; i++) {
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

function buildBioLimsReportHtml(
  titleDate:       string,
  today:           string,
  limsImageBase64: string | null,
  limsRows:        LimsServiceRow[],
  limsDescription: string,
): string {
  const imgTag = limsImageBase64
    ? `<img src="data:image/png;base64,${limsImageBase64}" style="max-width:100%;height:auto;display:block;margin:0 auto;" />`
    : `<div class="placeholder-box">LIMS.png 이미지가 업로드되지 않았습니다.</div>`;

  const tableRows = limsRows.map((r, i) => `
    <tr class="${i % 2 === 0 ? "" : "alt"}">
      <td>${r.initiatedAt}</td>
      <td>${r.area}</td>
      <td class="td-left">${r.contentSummary}</td>
      <td class="td-left">${r.detail}</td>
      <td>${r.issueType}</td>
      <td>${r.status}</td>
      <td>${r.hours}</td>
    </tr>`).join("");

  const emptyNote = limsRows.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:20px;">데이터 없음</td></tr>`
    : "";

  const descHtml = limsDescription
    ? `<div class="desc-box">${limsDescription}</div>`
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
    .page { break-before:page; padding:36px 44px 28px; }
    .page-header {
      display:flex; align-items:flex-end; justify-content:space-between;
      border-bottom:2.5px solid #0f2d55; padding-bottom:10px; margin-bottom:16px;
    }
    .page-header h2  { font-size:18px; font-weight:700; color:#0f2d55; }
    .page-header .pg { font-size:11px; color:#9ca3af; }
    .headline {
      background:#f0f4ff; border-left:4px solid #1a4a8a; padding:10px 14px;
      font-size:12px; line-height:1.7; color:#1e3a5f; margin-bottom:18px; border-radius:0 4px 4px 0;
    }
    .section-title {
      font-size:13px; font-weight:700; color:#0f2d55;
      margin-bottom:12px; padding-bottom:4px; border-bottom:1px solid #e5e7eb;
    }
    .placeholder-box {
      border:2px dashed #cbd5e1; border-radius:8px; padding:40px;
      text-align:center; color:#9ca3af; font-size:12px; background:#f8fafc;
    }
    .svc-table { width:100%; border-collapse:collapse; font-size:9px; margin-top:4px; }
    .svc-table th {
      background:#0f2d55; color:#fff; padding:5px 4px; text-align:center;
      font-size:9px; font-weight:600; border:1px solid #0f2d55;
    }
    .svc-table td { padding:4px 5px; border:1px solid #d1d5db; vertical-align:top; text-align:center; }
    .svc-table .td-left { text-align:left; }
    .svc-table tr.alt td { background:#f9fafb; }
    .desc-box {
      margin-top:16px; padding:10px 14px; background:#f8fafc;
      border:1px solid #e5e7eb; border-radius:4px;
      font-size:9.5px; color:#374151; line-height:1.6;
    }
    .footer {
      margin-top:24px; padding-top:12px; border-top:1px solid #e5e7eb;
      font-size:10px; color:#d1d5db; display:flex; justify-content:space-between;
    }
  </style>
</head>
<body>
  <!-- 표지 -->
  <div class="cover">
    <div class="cover-badge">SK Bioscience</div>
    <div class="cover-main">${titleDate}<br>Bio연구본부 임검분 LIMS 운영 현황</div>
    <div class="cover-rule"></div>
    <div class="cover-date">작성일: ${today}</div>
  </div>

  <!-- 2페이지: LIMS 이미지 -->
  <div class="page">
    <div class="page-header">
      <h2>Bio연구본부 임검분 LIMS 사용 현황</h2>
      <span class="pg">${titleDate}</span>
    </div>
    <div class="headline">연구본부에서 사용 중인 임상시험검체분석기관 LIMS 현황 Report 입니다.</div>
    <div class="section-title">연구본부 LIMS (임상시험검체분석기관) 사용 현황</div>
    ${imgTag}
    <div class="footer">
      <span>SK Bioscience Bio연구본부 — 임검분 LIMS 운영 현황</span>
      <span>${titleDate}</span>
    </div>
  </div>

  <!-- 3페이지: IT서비스 진행 현황 -->
  <div class="page">
    <div class="page-header">
      <h2>IT서비스 진행 현황</h2>
      <span class="pg">${titleDate}</span>
    </div>
    <table class="svc-table">
      <thead>
        <tr>
          <th style="width:10%">발의일자</th>
          <th style="width:9%">영역구분</th>
          <th style="width:18%">내용요약</th>
          <th style="width:28%">상세내용</th>
          <th style="width:9%">이슈구분</th>
          <th style="width:9%">진행상태</th>
          <th style="width:7%">지원시간</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}${emptyNote}
      </tbody>
    </table>
    ${descHtml}
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

  let limsImageBase64: string | null = null;
  let limsRows:        LimsServiceRow[] = [];
  let limsDescription  = "";

  try {
    const xlsxRows = await query<{ stored_path: string }>(
      `SELECT stored_path FROM uploaded_files
       WHERE report_job_id = $1 AND original_name = 'LIMS.xlsx'
       ORDER BY created_at DESC LIMIT 1`,
      [jobId]
    );
    if (xlsxRows.length && fs.existsSync(xlsxRows[0].stored_path)) {
      logger.info(`[BIO LIMS Report] LIMS.xlsx: ${xlsxRows[0].stored_path}`);
      const parsed    = readLimsServiceData(xlsxRows[0].stored_path);
      limsRows        = parsed.rows;
      limsDescription = parsed.description;
      logger.info(`[BIO LIMS Report] 서비스 행 수: ${limsRows.length}`);
    } else {
      logger.info("[BIO LIMS Report] LIMS.xlsx 없음 — 표 생략");
    }
  } catch (e) {
    logger.error(`[BIO LIMS Report] LIMS.xlsx 처리 실패: ${(e as Error).message}`);
  }

  try {
    const imgRows = await query<{ stored_path: string }>(
      `SELECT stored_path FROM uploaded_files
       WHERE report_job_id = $1 AND original_name = 'LIMS.png'
       ORDER BY created_at DESC LIMIT 1`,
      [jobId]
    );
    if (imgRows.length && fs.existsSync(imgRows[0].stored_path)) {
      logger.info(`[BIO LIMS Report] LIMS.png: ${imgRows[0].stored_path}`);
      limsImageBase64 = fs.readFileSync(imgRows[0].stored_path).toString("base64");
    } else {
      logger.info("[BIO LIMS Report] LIMS.png 없음 — 이미지 생략");
    }
  } catch (e) {
    logger.error(`[BIO LIMS Report] LIMS.png 처리 실패: ${(e as Error).message}`);
  }

  const html = buildBioLimsReportHtml(titleDate, today, limsImageBase64, limsRows, limsDescription);

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

  logger.info(`[BIO ELN] 월: ${months.join(", ")}, 과제: ${projects.length}개, 최근월 LASTNAME: ${Object.keys(chart2).length}개`);
  return { months, projects, chart1, latestMonth, chart2 };
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
 *  - 가장 최근 월(YYYY-MM) 행만 반환
 *
 * @returns { rows, latestMonth }
 */
function readElnServiceData(xlsxPath: string): { rows: ElnServiceRow[]; latestMonth: string } {
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

  // 현재 월 (미래 날짜 제외 기준)
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // 전체 행에서 접수일 → 월 목록 (미래 월 제외)
  const allMonths = rows
    .slice(1)
    .map((r) => toMonth((r as unknown[])[colReception]))
    .filter((m) => !!m && m <= currentMonth);
  const latestMonth = allMonths.sort().at(-1) ?? "";
  logger.info(`[BIO ELN Svc] 접수일 최근 월: ${latestMonth} (현재 월 기준: ${currentMonth})`);

  // 최근 월 행만 필터링
  const result: ElnServiceRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    if (toMonth(row[colReception]) !== latestMonth) continue;
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
  logger.info(`[BIO ELN Svc] 최근 월 행: ${result.length}개`);
  return { rows: result, latestMonth };
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
    </div>

    <!-- Chart 2: 팀별 연구노트 생성 현황 -->
    <div class="chart-block">
      <div class="chart-title">${latestLabel} 팀별 연구노트 생성 현황</div>
      ${mkImg(chart2Base64, "팀별 연구노트 생성 현황")}
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
  const titleDate = `${year}년 ${String(month).padStart(2, "0")}월`;
  const today     = new Date().toISOString().slice(0, 10);

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
      const svcData = readElnServiceData(svcPath);
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
