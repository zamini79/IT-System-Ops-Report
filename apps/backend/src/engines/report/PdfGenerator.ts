/**
 * PdfGenerator (Playwright Chromium 기반)
 *
 * HTML 문자열을 A4 PDF 파일로 변환합니다.
 * Playwright 는 이미 설치된 의존성이므로 별도 패키지 추가가 불필요합니다.
 *
 * 사용 예)
 *   const result = await PdfGenerator.generate(html, "/outputs/report.pdf");
 *   // → { filePath, fileSize, pageCount }
 */

import fs   from "fs";
import path from "path";
import { chromium } from "playwright";
import { logger } from "../../utils/logger";

// pdf-parse — 페이지 수 추출용.
//  ⚠️ v2 에서 export 형태가 바뀌었다. 예전 코드는 모듈을 함수로 호출했는데
//     ("pdfParse is not a function") _countPages 의 catch 가 이를 삼켜
//     **항상 0 페이지**를 반환하고 있었다. 동기 다운로드 경로에서는 이 값을
//     쓰지 않아 드러나지 않았고, 배경 생성(SSE report_done)으로 바꾸면서
//     화면에 "0페이지"로 표시되어 발견됐다.
//     v2 는 PDFParse 클래스이고 getInfo().total 이 페이지 수다.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require("pdf-parse") as {
  PDFParse: new (opts: { data: Uint8Array }) => {
    getInfo(): Promise<{ total?: number }>;
    destroy?(): Promise<void>;
  };
};

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface PdfMargin {
  top?:    string;
  right?:  string;
  bottom?: string;
  left?:   string;
}

export interface PdfOptions {
  /** 용지 규격 (기본: A4) */
  format?:          "A4" | "A3" | "Letter" | "Legal";
  /** 배경색·이미지 인쇄 여부 (기본: true) */
  printBackground?: boolean;
  /** 여백 (기본: 상하 20mm, 좌우 15mm) */
  margin?:          PdfMargin;
}

export interface PdfGenerateResult {
  filePath:  string;   // 저장된 파일 절대 경로
  fileSize:  number;   // bytes
  pageCount: number;   // PDF 페이지 수
}

// ── 기본 옵션 ─────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<PdfOptions> = {
  format:          "A4",
  printBackground: true,
  margin: {
    top:    "20mm",
    right:  "15mm",
    bottom: "20mm",
    left:   "15mm",
  },
};

// ── PdfGenerator ──────────────────────────────────────────────────────────────

export class PdfGenerator {
  /**
   * HTML 문자열을 PDF 파일로 저장하고 메타데이터를 반환합니다.
   *
   * @param html        자립형(self-contained) HTML 문자열
   * @param outputPath  저장할 파일의 절대 경로 (.pdf)
   * @param options     용지 크기·여백 등 PDF 옵션
   */
  static async generate(
    html:       string,
    outputPath: string,
    options:    PdfOptions = {}
  ): Promise<PdfGenerateResult> {
    const opts = {
      ...DEFAULT_OPTIONS,
      ...options,
      margin: { ...DEFAULT_OPTIONS.margin, ...options.margin },
    };

    // 출력 디렉터리 자동 생성
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // ── Playwright Chromium 으로 PDF 렌더링 ───────────────────────────────
    const browser = await chromium.launch({ headless: true });

    try {
      const context = await browser.newContext();
      const page    = await context.newPage();

      // 자립형 HTML 을 직접 로드 (외부 리소스 없음 → networkidle 즉시)
      await page.setContent(html, { waitUntil: "networkidle", timeout: 60_000 });

      const pdfBuffer = await page.pdf({
        format:          opts.format,
        printBackground: opts.printBackground,
        margin:          opts.margin,
      });

      fs.writeFileSync(outputPath, pdfBuffer);
    } finally {
      // 성공·실패 모두 브라우저 종료
      await browser.close();
    }

    // ── 파일 크기 + 페이지 수 ────────────────────────────────────────────
    const fileSize  = fs.statSync(outputPath).size;
    const pageCount = await PdfGenerator._countPages(outputPath);

    return { filePath: outputPath, fileSize, pageCount };
  }

  /** pdf-parse 로 페이지 수를 추출합니다. 실패 시 0 반환. */
  private static async _countPages(pdfPath: string): Promise<number> {
    try {
      const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(pdfPath)) });
      try {
        const info = await parser.getInfo();
        return info.total ?? 0;
      } finally {
        await parser.destroy?.().catch(() => {});
      }
    } catch (err) {
      // 페이지 수는 부가 정보이므로 실패해도 생성 자체는 성공으로 둔다.
      // 다만 예전처럼 조용히 0 을 반환하지 않고 남긴다(원인 추적용).
      logger.warn(`[PdfGenerator] 페이지 수 계산 실패: ${(err as Error).message}`);
      return 0;
    }
  }
}
