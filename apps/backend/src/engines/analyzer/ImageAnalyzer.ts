/**
 * ImageAnalyzer (sharp 기반)
 *
 * - 이미지 메타데이터 추출 (파일을 디코딩하지 않아 고속)
 * - 반환: { width, height, format, size, channels, hasAlpha }
 */

import fs    from "fs";
import sharp from "sharp";
import type { ImageAnalysisResult } from "./types";

export async function analyzeImage(filePath: string): Promise<ImageAnalysisResult> {
  const [meta, stat] = await Promise.all([
    sharp(filePath).metadata(),
    fs.promises.stat(filePath),
  ]);

  return {
    type:     "image",
    width:    meta.width    ?? 0,
    height:   meta.height   ?? 0,
    format:   meta.format   ?? "unknown",
    size:     stat.size,
    channels: meta.channels ?? 0,
    hasAlpha: meta.hasAlpha ?? false,
  };
}
