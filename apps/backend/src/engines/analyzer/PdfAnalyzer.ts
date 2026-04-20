/**
 * PdfAnalyzer (pdf-parse 기반)
 *
 * - 텍스트 추출
 * - 페이지별 텍스트 반환
 * - 반환: { pageCount, pages: [{ pageNum, text }], fullText }
 */

import fs   from "fs";
// pdf-parse 는 CJS 모듈이므로 require 로 로드합니다.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (
  buffer: Buffer,
  options?: Record<string, unknown>
) => Promise<{ numpages: number; text: string }>;

import type { PdfAnalysisResult, PdfPage } from "./types";

export async function analyzePdf(filePath: string): Promise<PdfAnalysisResult> {
  const buffer = fs.readFileSync(filePath);
  const pages:  PdfPage[] = [];

  /**
   * pdf-parse 의 pagerender 콜백.
   * 각 페이지가 렌더링될 때마다 호출되어 텍스트를 수집합니다.
   * pageData 는 pdfjs-dist 의 PDFPageProxy 타입입니다.
   */
  const pagerender = (pageData: {
    getTextContent: (opts?: { normalizeWhitespace: boolean }) => Promise<{
      items: Array<{ str: string; hasEOL?: boolean }>;
    }>;
  }): Promise<string> =>
    pageData
      .getTextContent({ normalizeWhitespace: true })
      .then((tc) => {
        const lines: string[] = [];
        let line = "";

        for (const item of tc.items) {
          line += item.str;
          if (item.hasEOL) {
            lines.push(line.trim());
            line = "";
          }
        }
        if (line.trim()) lines.push(line.trim());

        const text = lines.filter(Boolean).join("\n");
        pages.push({ pageNum: pages.length + 1, text });
        return text;
      });

  const data = await pdfParse(buffer, { pagerender } as Parameters<typeof pdfParse>[1]);

  return {
    type:      "pdf",
    pageCount: data.numpages,
    pages,
    fullText:  data.text.trim(),
  };
}
