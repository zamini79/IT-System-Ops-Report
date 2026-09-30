/**
 * Chart.js HTML → PNG 캡처 (보고서 차트 공통)
 *
 * 고정 시간만 기다렸다가 찍으면 가끔 그리기 전의 빈 캔버스가 찍힌다.
 * (2026-09-30 BIO 일일 사용 현황·LIMS 도넛·ELN 팀별 차트가 1KB 빈 이미지로 나온 사례)
 * 캔버스에 실제로 그려진 픽셀을 확인한 뒤 찍고, 비어 있으면 다시 그린다.
 * 끝내 그려지지 않으면 예외를 던진다 — 호출부가 잡아 "차트 없음"으로 표시하므로
 * 빈 이미지가 조용히 PDF 에 들어가지 않는다.
 */

import fs from "fs";
import { chromium } from "playwright";
import { logger } from "../../utils/logger";

export interface ChartCaptureOptions {
  html:      string;
  width:     number;
  height:    number;
  /** 캡처할 요소 (예: "#c", "#wrap", "#chart-container") */
  selector:  string;
  outputPng: string;
  /** 로그용 이름 */
  label:     string;
}

const MAX_ATTEMPTS = 3;

export async function captureChartPng(o: ChartCaptureOptions): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (err) => logger.error(`[Chart] ${o.label} 스크립트 오류: ${err.message}`));
    await page.setViewportSize({ width: o.width, height: o.height });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await page.setContent(o.html, { waitUntil: "load", timeout: 30_000 });
      const drawn = await page
        .waitForFunction(() => {
          const canvases = Array.from(document.querySelectorAll("canvas"));
          if (!canvases.length) return false;
          // 흰색·투명이 아닌 픽셀이 충분히 있으면 그려진 것으로 본다 (16픽셀마다 표본)
          let painted = 0;
          for (const cv of canvases) {
            const ctx = cv.getContext("2d");
            if (!ctx || !cv.width || !cv.height) continue;
            const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
            for (let i = 0; i < d.length; i += 64) {
              if (d[i + 3] > 0 && (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235)) painted++;
            }
          }
          return painted > 50;
        }, null, { timeout: 10_000, polling: 100 })
        .then(() => true, () => false);

      if (drawn) {
        await page.locator(o.selector).screenshot({ path: o.outputPng, type: "png" });
        logger.info(`[Chart] ${o.label}: ${o.outputPng} (${fs.statSync(o.outputPng).size.toLocaleString()} B)` +
          (attempt > 1 ? ` — ${attempt}번째 시도` : ""));
        return;
      }
      logger.warn(`[Chart] ${o.label}: 차트가 그려지지 않음 — 다시 시도 (${attempt}/${MAX_ATTEMPTS})`);
    }
    throw new Error(`${o.label} 차트 렌더링 실패 (${MAX_ATTEMPTS}회)`);
  } finally {
    await browser.close();
  }
}
