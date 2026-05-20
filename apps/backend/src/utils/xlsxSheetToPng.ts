/**
 * Excel(xlsx) 의 특정 시트를 PNG 이미지로 변환합니다.
 *
 * 처리 흐름:
 *   1. JSZip 으로 xlsx 의 workbook.xml 수정
 *      - 대상 시트 외 모든 시트를 state="hidden" 처리
 *      - workbookView 의 activeTab 을 대상 시트로 설정
 *   2. LibreOffice headless 로 xlsx → PNG 변환 (가시 시트만 렌더링됨)
 *   3. 결과 PNG 를 outputPath 로 복사
 *
 * 실제 Excel 차트 객체(chart1.xml 등) 도 LibreOffice 가 렌더링하므로
 * 차트 데이터가 그대로 보존됩니다.
 */

import path     from "path";
import fs       from "fs";
import { spawn } from "child_process";
import JSZip    from "jszip";
import { logger } from "./logger";

const SOFFICE_PATH =
  process.env.SOFFICE_PATH ?? "/Applications/LibreOffice.app/Contents/MacOS/soffice";

const SOFFICE_TIMEOUT_MS = 120_000;

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
): Promise<{ targetIdx: number; allSheetNames: string[] }> {
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

  return { targetIdx, allSheetNames: sheetNames };
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
    // 1. xlsx 읽어서 workbook.xml 패치
    const buffer = fs.readFileSync(xlsxPath);
    const zip    = await JSZip.loadAsync(buffer);
    const { targetIdx, allSheetNames } = await patchWorkbookForTargetSheet(zip, sheetName);
    logger.info(
      `[xlsxSheetToPng] "${sheetName}" 시트 활성화 (index=${targetIdx}/${allSheetNames.length})`
    );

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

    // 4. outputPath 로 복사
    fs.copyFileSync(generatedPng, outputPath);
    logger.info(`[xlsxSheetToPng] 최종 저장: ${outputPath}`);
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // 임시 디렉토리 정리 실패는 무시
    }
  }
}
