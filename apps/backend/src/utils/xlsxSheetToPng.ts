/**
 * Excel(xlsx) 의 특정 시트를 PNG 이미지로 변환합니다.
 *
 * 처리 흐름:
 *   1. JSZip 으로 xlsx 의 workbook.xml / worksheet.xml 수정
 *      - 대상 시트 외 모든 시트를 state="hidden" 처리
 *      - workbookView 의 activeTab 을 대상 시트로 설정
 *      - 대상 시트의 "차트/도형(drawing) 전체 영역" 을 인쇄 영역(Print_Area)으로 지정
 *      - 대상 시트를 1페이지에 맞춤(fitToPage) + 여백 0 으로 설정
 *   2. LibreOffice headless 로 xlsx → PNG 변환 (가시 시트의 인쇄 영역만 렌더링됨)
 *   3. 결과 PNG 를 outputPath 로 복사
 *
 * ── 왜 인쇄 영역을 따로 잡아야 하나 ──────────────────────────────────────────────
 * "Dash Board" 같은 대시보드 시트는 셀 데이터가 거의 없고(예: dimension="A46"),
 * 화면은 전부 떠 있는 차트/도형(drawing 객체) 으로 구성된다. LibreOffice 는 셀
 * 사용 범위를 기준으로 인쇄 영역을 잡으므로, 인쇄 영역을 지정하지 않으면 A1 부터
 * 기본 A4 한 페이지만 렌더링되어 대시보드 대부분이 잘려 "영역이 이상하게" 나온다.
 * 따라서 drawing 앵커들의 최대 행·열을 계산해 인쇄 영역으로 강제 지정한다.
 */

import path     from "path";
import fs       from "fs";
import { spawn } from "child_process";
import JSZip    from "jszip";
import sharp    from "sharp";
import { logger } from "./logger";

const SOFFICE_PATH =
  process.env.SOFFICE_PATH ?? "/Applications/LibreOffice.app/Contents/MacOS/soffice";

const SOFFICE_TIMEOUT_MS = 120_000;

/** 0-based 열 인덱스 → 엑셀 열 문자 (0→A, 25→Z, 26→AA) */
function colToLetter(col0: number): string {
  let n = col0 + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * xlsx 의 워크북 XML 을 수정하여 대상 시트만 표시되도록 합니다.
 *   - 대상 시트가 아닌 모든 시트에 state="hidden" 추가
 *   - <workbookView> 의 activeTab 을 대상 시트 인덱스로 설정
 *
 * 차트(chart1.xml)·이미지(media/) 등 다른 리소스는 손대지 않으므로 보존됩니다.
 */
async function patchWorkbookForTargetSheet(
  zip:        JSZip,
  sheetName:  string,
): Promise<{ targetIdx: number; allSheetNames: string[]; targetRid: string | null }> {
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) {
    throw new Error("xl/workbook.xml 을 찾을 수 없습니다. 유효한 xlsx 파일이 아닐 수 있습니다.");
  }
  const original = await workbookFile.async("string");

  // <sheet> 태그를 순서대로 추출 (sheetjs 의 SheetNames 와 동일 순서)
  const sheetMatches = [...original.matchAll(/<sheet\s+[^>]*?\/?>/g)];
  const sheetNames = sheetMatches.map((m) => {
    const tag  = m[0];
    const name = (tag.match(/name="([^"]+)"/) ?? ["", ""])[1];
    return name;
  });

  const targetIdx = sheetNames.indexOf(sheetName);
  if (targetIdx < 0) {
    throw new Error(
      `시트 "${sheetName}" 를 찾을 수 없습니다. 가능한 시트: ${sheetNames.join(", ")}`
    );
  }

  // 대상 시트의 r:id 추출 (worksheet 파일 경로 매핑용)
  const targetTag = sheetMatches[targetIdx][0];
  const targetRid = (targetTag.match(/r:id="([^"]+)"/) ?? [null, null])[1];

  // activeTab 설정
  let patched = original;
  if (/<workbookView[^>]*\bactiveTab="[^"]*"/.test(patched)) {
    patched = patched.replace(/(<workbookView[^>]*\bactiveTab=)"[^"]*"/, `$1"${targetIdx}"`);
  } else if (/<workbookView\b/.test(patched)) {
    patched = patched.replace(/<workbookView\b/, `<workbookView activeTab="${targetIdx}"`);
  }

  // 다른 시트들 hidden 처리 — 대상 시트와 일치하지 않으면 state="hidden" 부여
  patched = patched.replace(/<sheet\s+([^>]*?)(\/?>)/g, (_full, attrs: string, close: string) => {
    const nameMatch = attrs.match(/name="([^"]+)"/);
    const thisName  = nameMatch ? nameMatch[1] : "";
    if (thisName === sheetName) {
      // 대상 시트는 state 제거 (이전에 hidden 이었을 수 있음)
      const clean = attrs.replace(/\s*state="[^"]*"/, "");
      return `<sheet ${clean.trim()}${close}`;
    }
    // 다른 시트는 hidden — 기존 state 가 있으면 교체
    const cleaned = attrs.replace(/\s*state="[^"]*"/, "");
    return `<sheet ${cleaned.trim()} state="hidden"${close}`;
  });

  zip.file("xl/workbook.xml", patched);

  return { targetIdx, allSheetNames: sheetNames, targetRid };
}

/** workbook.xml.rels 에서 r:id 로 worksheet 파일 경로를 해석합니다. */
async function resolveWorksheetPath(zip: JSZip, rid: string): Promise<string | null> {
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!relsFile) return null;
  const rels = await relsFile.async("string");
  const re   = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`);
  const tag  = (rels.match(re) ?? [null])[0];
  if (!tag) return null;
  const target = (tag.match(/Target="([^"]+)"/) ?? [null, null])[1];
  if (!target) return null;
  // Target 은 보통 "worksheets/sheetN.xml" (xl/ 기준 상대경로)
  const clean = target.replace(/^\/?xl\//, "").replace(/^\.\//, "");
  return `xl/${clean}`;
}

/**
 * 대상 worksheet 의 drawing(차트/도형) 앵커들을 읽어 전체 점유 영역(최대 열·행)을
 * 계산합니다. drawing 이 없으면 null 을 반환합니다. (0-based 종료 셀 기준)
 */
async function getDrawingExtent(
  zip:           JSZip,
  worksheetPath: string,
): Promise<{ maxCol: number; maxRow: number } | null> {
  const wsFile = zip.file(worksheetPath);
  if (!wsFile) return null;
  const ws = await wsFile.async("string");

  const drawingRid = (ws.match(/<drawing\b[^>]*r:id="([^"]+)"/) ?? [null, null])[1];
  if (!drawingRid) return null;

  // worksheet 의 rels 에서 drawing 파일 경로 해석
  const wsName   = worksheetPath.replace(/^xl\/worksheets\//, "");
  const wsRelsPath = `xl/worksheets/_rels/${wsName}.rels`;
  const relsFile   = zip.file(wsRelsPath);
  if (!relsFile) return null;
  const rels = await relsFile.async("string");
  const re   = new RegExp(`<Relationship\\b[^>]*Id="${drawingRid}"[^>]*>`);
  const tag  = (rels.match(re) ?? [null])[0];
  if (!tag) return null;
  const target = (tag.match(/Target="([^"]+)"/) ?? [null, null])[1];
  if (!target) return null;
  // Target 예: "../drawings/drawing1.xml"
  const drawingPath = `xl/${target.replace(/^\.\.\//, "").replace(/^\/?xl\//, "")}`;

  const drawFile = zip.file(drawingPath);
  if (!drawFile) return null;
  const draw = await drawFile.async("string");

  const anchors = [
    ...draw.matchAll(/<xdr:(twoCellAnchor|oneCellAnchor)[\s\S]*?<\/xdr:(twoCellAnchor|oneCellAnchor)>/g),
  ];
  if (anchors.length === 0) return null;

  let maxCol = 0;
  let maxRow = 0;
  for (const a of anchors) {
    const t    = a[0];
    const from = (t.match(/<xdr:from>([\s\S]*?)<\/xdr:from>/) ?? [null, ""])[1] ?? "";
    const to   = (t.match(/<xdr:to>([\s\S]*?)<\/xdr:to>/)     ?? [null, ""])[1] ?? "";
    const fc = Number((from.match(/<xdr:col>(\d+)/) ?? [null, NaN])[1]);
    const fr = Number((from.match(/<xdr:row>(\d+)/) ?? [null, NaN])[1]);
    const tc = Number((to.match(/<xdr:col>(\d+)/)   ?? [null, NaN])[1]);
    const tr = Number((to.match(/<xdr:row>(\d+)/)   ?? [null, NaN])[1]);
    if (!Number.isNaN(tc)) maxCol = Math.max(maxCol, tc);
    if (!Number.isNaN(tr)) maxRow = Math.max(maxRow, tr);
    // oneCellAnchor 처럼 <xdr:to> 가 없는 경우 from 기준으로 보정
    if (!Number.isNaN(fc)) maxCol = Math.max(maxCol, fc);
    if (!Number.isNaN(fr)) maxRow = Math.max(maxRow, fr);
  }
  return { maxCol, maxRow };
}

/** workbook.xml 에 대상 시트의 인쇄 영역(_xlnm.Print_Area) 정의를 추가합니다. */
async function setPrintArea(
  zip:       JSZip,
  sheetName: string,
  localSheetId: number,
  maxCol:    number,
  maxRow:    number,
): Promise<void> {
  const file = zip.file("xl/workbook.xml");
  if (!file) return;
  let wb = await file.async("string");

  // A1 부터 drawing 최대 셀까지 (행은 1-based 로 +1, 여유 1행/열 추가)
  const lastCol = colToLetter(maxCol + 1);
  const lastRow = maxRow + 2;
  const ref     = `'${sheetName}'!$A$1:$${lastCol}$${lastRow}`;
  const dn      =
    `<definedName name="_xlnm.Print_Area" localSheetId="${localSheetId}">${ref}</definedName>`;

  // 같은 시트의 기존 Print_Area 가 있으면 제거
  wb = wb.replace(
    new RegExp(`<definedName name="_xlnm\\.Print_Area" localSheetId="${localSheetId}"[^>]*>[\\s\\S]*?</definedName>`),
    "",
  );

  if (/<definedNames>/.test(wb)) {
    wb = wb.replace(/<definedNames>/, `<definedNames>${dn}`);
  } else if (/<\/sheets>/.test(wb)) {
    wb = wb.replace(/<\/sheets>/, `</sheets><definedNames>${dn}</definedNames>`);
  }

  zip.file("xl/workbook.xml", wb);
}

/**
 * 대상 worksheet 를 "1페이지에 맞춤(fitToPage) + 여백 0 + 가로방향" 으로 설정합니다.
 * 인쇄 영역 전체가 한 장의 PNG 로 잘림 없이 렌더링되도록 강제합니다.
 */
async function patchWorksheetForFullPage(zip: JSZip, worksheetPath: string): Promise<void> {
  const file = zip.file(worksheetPath);
  if (!file) return;
  let ws = await file.async("string");

  // 1) sheetPr / pageSetUpPr fitToPage="1"
  if (/<sheetPr\b/.test(ws)) {
    if (/<pageSetUpPr\b/.test(ws)) {
      ws = ws.replace(/<pageSetUpPr\b[^>]*\/?>/, `<pageSetUpPr fitToPage="1"/>`);
    } else if (/<sheetPr\b[^>]*\/>/.test(ws)) {
      // 자체 닫힘 <sheetPr .../> → 자식을 가질 수 있도록 펼침
      ws = ws.replace(/<sheetPr\b([^>]*)\/>/, `<sheetPr$1><pageSetUpPr fitToPage="1"/></sheetPr>`);
    } else {
      ws = ws.replace(/<sheetPr\b([^>]*)>/, `<sheetPr$1><pageSetUpPr fitToPage="1"/>`);
    }
  } else {
    ws = ws.replace(/(<worksheet\b[^>]*>)/, `$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`);
  }

  // 2) 여백 0 (pageMargins)
  const zeroMargins =
    `<pageMargins left="0" right="0" top="0" bottom="0" header="0" footer="0"/>`;
  if (/<pageMargins\b[^>]*\/>/.test(ws)) {
    ws = ws.replace(/<pageMargins\b[^>]*\/>/, zeroMargins);
  }

  // 3) pageSetup → 가로방향 + 1×1 페이지 맞춤 (printerSettings r:id / paperSize 제거)
  const newPageSetup = `<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="1"/>`;
  if (/<pageSetup\b[^>]*\/>/.test(ws)) {
    ws = ws.replace(/<pageSetup\b[^>]*\/>/, newPageSetup);
  } else if (/<pageMargins\b[^>]*\/>/.test(ws)) {
    // pageSetup 이 없으면 pageMargins 뒤에 삽입
    ws = ws.replace(/(<pageMargins\b[^>]*\/>)/, `$1${newPageSetup}`);
  }

  zip.file(worksheetPath, ws);
}

/**
 * soffice 를 실행해 xlsx 를 PNG 로 변환합니다.
 *
 * @returns 변환된 PNG 의 절대 경로 (xlsx 와 같은 폴더에 같은 basename 으로 생성됨)
 */
async function runSofficeToPng(xlsxPath: string, outDir: string): Promise<string> {
  const baseName = path.basename(xlsxPath, path.extname(xlsxPath));

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(SOFFICE_PATH, [
      "--headless",
      "--norestore",
      "--nologo",
      "--convert-to", "png",
      "--outdir",     outDir,
      xlsxPath,
    ]);

    let stderr = "";
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`soffice 변환 시간 초과 (${SOFFICE_TIMEOUT_MS / 1000}s)`));
    }, SOFFICE_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`soffice 실행 실패: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const expected = path.join(outDir, `${baseName}.png`);
      if (code !== 0) {
        return reject(new Error(`soffice 종료 코드 ${code}: ${stderr || stdout}`));
      }
      if (!fs.existsSync(expected)) {
        return reject(new Error(`PNG 생성되지 않음: ${expected} 미존재. stderr=${stderr}`));
      }
      resolve(expected);
    });
  });
}

/**
 * PNG 외곽의 균일한 흰 여백을 잘라냅니다. (페이지 렌더링 시 생기는 빈 테두리 제거)
 * 과도하게 잘려 이미지가 사라지면 원본을 그대로 사용합니다.
 */
async function trimWhitespace(srcPng: string, outPng: string): Promise<void> {
  try {
    const meta    = await sharp(srcPng).metadata();
    // 배경 기준색을 흰색으로 명시 — 기본값(좌상단 픽셀=파란 헤더)으로는 하단 흰 여백이
    // 잘리지 않으므로, 흰색을 기준으로 비흰색 콘텐츠의 바운딩 박스만 남긴다.
    const trimmed = await sharp(srcPng)
      .trim({ background: "#ffffff", threshold: 12 })
      .toBuffer({ resolveWithObject: true });
    const { width = 0, height = 0 } = trimmed.info;
    const origArea = (meta.width ?? 0) * (meta.height ?? 0);
    const newArea  = width * height;
    // 너무 작아지면(원본의 5% 미만) 트림 결과를 신뢰하지 않고 원본 사용
    if (newArea > 0 && origArea > 0 && newArea >= origArea * 0.05) {
      fs.writeFileSync(outPng, trimmed.data);
      return;
    }
  } catch (e) {
    logger.warn(`[xlsxSheetToPng] 흰 여백 트림 실패(무시): ${(e as Error).message}`);
  }
  fs.copyFileSync(srcPng, outPng);
}

/**
 * xlsx 파일의 특정 시트를 렌더링하여 PNG 로 저장합니다.
 *
 * @param xlsxPath    원본 xlsx 경로
 * @param sheetName   변환 대상 시트명 (예: "Dash Board")
 * @param outputPath  최종 PNG 경로 (덮어쓰기됨)
 */
export async function xlsxSheetToPng(
  xlsxPath:   string,
  sheetName:  string,
  outputPath: string,
): Promise<void> {
  const workDir = path.join(
    path.dirname(xlsxPath),
    `_xlsx_to_png_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1. xlsx 읽어서 workbook.xml 패치 (시트 숨김 + activeTab)
    const buffer = fs.readFileSync(xlsxPath);
    const zip    = await JSZip.loadAsync(buffer);
    const { targetIdx, allSheetNames, targetRid } =
      await patchWorkbookForTargetSheet(zip, sheetName);
    logger.info(
      `[xlsxSheetToPng] "${sheetName}" 시트 활성화 (index=${targetIdx}/${allSheetNames.length})`
    );

    // 1.5 대상 시트의 drawing(차트/도형) 점유 영역을 인쇄 영역으로 지정하고
    //     1페이지 맞춤 + 여백 0 으로 설정 (대시보드 잘림 방지)
    const worksheetPath = targetRid ? await resolveWorksheetPath(zip, targetRid) : null;
    if (worksheetPath) {
      const extent = await getDrawingExtent(zip, worksheetPath);
      if (extent) {
        await setPrintArea(zip, sheetName, targetIdx, extent.maxCol, extent.maxRow);
        await patchWorksheetForFullPage(zip, worksheetPath);
        logger.info(
          `[xlsxSheetToPng] 인쇄 영역 지정: A1:${colToLetter(extent.maxCol + 1)}${extent.maxRow + 2} ` +
          `(drawing 기준), 1페이지 맞춤 적용`
        );
      } else {
        logger.info("[xlsxSheetToPng] drawing 영역 미검출 — 기본 인쇄 영역으로 변환");
      }
    }

    // 2. 패치된 xlsx 를 workDir 에 저장
    const patchedXlsx = path.join(workDir, "patched.xlsx");
    const patched     = await zip.generateAsync({
      type:               "nodebuffer",
      compression:        "DEFLATE",
      compressionOptions: { level: 6 },
    });
    fs.writeFileSync(patchedXlsx, patched);

    // 3. soffice 로 PNG 변환
    const generatedPng = await runSofficeToPng(patchedXlsx, workDir);
    logger.info(`[xlsxSheetToPng] PNG 생성: ${generatedPng}`);

    // 4. 외곽 흰 여백 정리 후 outputPath 로 저장
    await trimWhitespace(generatedPng, outputPath);
    logger.info(`[xlsxSheetToPng] 최종 저장: ${outputPath}`);
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // 임시 디렉토리 정리 실패는 무시
    }
  }
}
