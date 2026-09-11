/**
 * 본부별 PDF 생성을 **백그라운드**로 실행한다.
 *
 * ── 왜 필요한가 ───────────────────────────────────────────────────────────────
 *  기존 `/report/generate-dev` 등은 생성이 끝날 때까지 붙잡고 있다가 PDF 를 그대로
 *  응답으로 내려주는 동기 엔드포인트다. 그래서 사용자가 생성 중에 다른 메뉴로
 *  이동하면 브라우저가 요청을 취소하고, 서버는 계속 렌더링하지만 **결과가 갈 곳이
 *  없어 버려진다.** 수집은 이미 백그라운드로 도는데(202 + SSE) 마지막 PDF 단계만
 *  유실되던 셈이다.
 *
 *  기존 범용 `startReportGeneration` 은 `ReportBuilder`(구 범용 템플릿)를 쓰므로
 *  본부별 산출물과 내용이 다르다. 그래서 그것을 재사용하지 않고, **지금 쓰는
 *  본부별 생성기를 그대로** 백그라운드에서 호출하는 얇은 래퍼를 둔다.
 *  산출물은 한 글자도 달라지지 않는다.
 *
 *  완료되면 report_jobs.pdf_path 를 갱신하므로 기존 `/report/:jobId/download` 로
 *  내려받을 수 있고, SSE report_done 이 프론트에 알린다.
 */

import { jobEventBus } from "../crawl/crawl.events";
import { query }       from "../../config/db";
import { logger }      from "../../utils/logger";
import { AppError }    from "../../utils/errors";

import { generateDevReport }       from "./dev.report.service";
import { generateLhouseReport }    from "./lhouse.report.service";
import { generateBioReport,
         generateBioLimsReport,
         generateBioElnReport }    from "./bio.report.service";

/** 동기 엔드포인트와 1:1 대응하는 변형 */
export type ReportVariant =
  | "dev" | "lhouse" | "bio" | "bio-lims" | "bio-eln";

interface ReportOutput {
  filePath:  string;
  filename:  string;
  fileSize:  number;
  pageCount: number;
}

const GENERATORS: Record<ReportVariant, (jobId: string) => Promise<ReportOutput>> = {
  "dev":      generateDevReport,
  "lhouse":   generateLhouseReport,
  "bio":      generateBioReport,
  "bio-lims": generateBioLimsReport,
  "bio-eln":  generateBioElnReport,
};

/**
 * 즉시 반환하고, 생성 완료/실패를 SSE 로 알린다.
 * @throws 알 수 없는 variant 이면 400
 */
export function startDivisionReport(params: {
  jobId:   string;
  variant: ReportVariant;
}): void {
  const { jobId, variant } = params;
  const generate = GENERATORS[variant];
  if (!generate) throw new AppError(400, `알 수 없는 보고서 종류: ${variant}`);

  jobEventBus.emit(jobId, { type: "report_generating", jobId });
  logger.info(`[DivisionReport] 백그라운드 생성 시작 — ${variant} (job=${jobId})`);

  void (async () => {
    try {
      const result = await generate(jobId);

      // 기존 /report/:jobId/download 가 report_jobs.pdf_path 를 읽으므로 갱신한다.
      await query(
        `UPDATE report_jobs
         SET status = 'COMPLETED', pdf_path = $1, completed_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [result.filePath, jobId]
      ).catch((e: Error) =>
        // 보고서 자체는 만들어졌으므로 이력 갱신 실패로 전체를 실패 처리하지 않는다.
        logger.warn(`[DivisionReport] report_jobs 갱신 실패: ${e.message}`)
      );

      jobEventBus.emit(jobId, {
        type:      "report_done",
        jobId,
        pdfPath:   result.filePath,
        pageCount: result.pageCount,
        fileSize:  result.fileSize,
      });
      logger.info(
        `[DivisionReport] 완료 — ${result.filename} ` +
        `(${result.pageCount}p, ${(result.fileSize / 1024).toFixed(1)}KB)`
      );
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`[DivisionReport] 실패 — ${variant} (job=${jobId}): ${message}`);
      await query(
        `UPDATE report_jobs
         SET status = 'FAILED', error_message = $1, completed_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [message, jobId]
      ).catch(() => { /* 이력 갱신 실패는 무시 */ });
      jobEventBus.emit(jobId, { type: "report_error", jobId, error: message });
    }
  })();
}
