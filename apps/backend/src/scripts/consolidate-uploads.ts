/**
 * 수동 업로드 파일을 본부별 고정 작업공간으로 통합 (일회성)
 *
 * ── 배경 ─────────────────────────────────────────────────────────────────────
 *  화면의 jobId 가 브라우저별 랜덤 UUID 였던 탓에 Systemusage_*.png · LIMS · ELN
 *  같은 **수동 업로드 전용** 입력이 옛 job 폴더에 흩어져 있다. PDF 는 이 파일들을
 *  `UPLOAD_DIR/{jobId}/uploads/<파일명>` 경로로 직접 읽으므로, jobId 를 고정
 *  작업공간으로 통일하면 기존 파일을 함께 옮겨야 유실되지 않는다.
 *
 *  Timesheet 은 제외한다 — 대시보드·PDF 모두 original_name 으로 DB 조회하므로
 *  위치와 무관하게 동작한다.
 *
 * ── 동작 ─────────────────────────────────────────────────────────────────────
 *  파일명별로 **가장 최근** uploaded_files 행을 골라, 대상 본부의 고정 작업공간으로
 *  복사하고 그 위치를 가리키는 행을 upsert 한다. 원본 파일·행은 건드리지 않는다
 *  (되돌릴 수 있도록). 대상에 같은 파일이 이미 있으면 건너뛴다.
 *
 *  실행:  npx tsx apps/backend/src/scripts/consolidate-uploads.ts [--apply]
 *         --apply 없이 실행하면 무엇을 옮길지만 출력한다(dry-run).
 */
import "../config/env";
import fs   from "fs";
import path from "path";
import { query } from "../config/db";
import { pool }  from "../config/db";
import { DASHBOARD_JOB_IDS } from "../modules/dashboard/dashboard.types";

/** 수동 업로드 전용 파일 → 소속 본부 */
const OWNER: Record<string, keyof typeof DASHBOARD_JOB_IDS> = {
  "Systemusage_GCP.png":       "DEV",
  "Systemusage_GCP.jpg":       "DEV",
  "Systemusage_Medcomms.png":  "DEV",
  "Systemusage_Medcomms.jpg":  "DEV",
  "Systemusage_Clinical1.png": "DEV",
  "Systemusage_Clinical1.jpg": "DEV",
  "Systemusage_Clinical2.png": "DEV",
  "Systemusage_Clinical2.jpg": "DEV",
  "Systemusage_LHOUSE.png":    "LHOUSE",
  "Systemusage_LHOUSE.jpg":    "LHOUSE",
  "Systemusage_RD.png":        "BIO",
  "Systemusage_RD.jpg":        "BIO",
  "LIMS.xlsx":                 "BIO",
  "LIMS_Dashboard.xlsx":       "BIO",
  "ELN_report.xlsx":           "BIO",
  "ELN_service.xlsx":          "BIO",
};

const APPLY = process.argv.includes("--apply");

interface Row { id: string; report_job_id: string; original_name: string;
                stored_path: string; file_type: string; file_size: number }

(async () => {
  const uploadRoot = process.env.UPLOAD_DIR ?? "uploads";
  console.log(`UPLOAD_DIR = ${uploadRoot}`);
  console.log(APPLY ? "모드: 실제 적용\n" : "모드: dry-run (--apply 로 실제 적용)\n");

  let moved = 0, skipped = 0, missing = 0;

  for (const [name, division] of Object.entries(OWNER)) {
    // 파일명별 최신 1건
    const rows = await query<Row>(
      `SELECT id, report_job_id, original_name, stored_path, file_type, file_size
       FROM uploaded_files WHERE original_name = $1
       ORDER BY created_at DESC LIMIT 1`, [name]
    );
    if (!rows.length) continue;
    const r = rows[0];

    if (!fs.existsSync(r.stored_path)) {
      console.log(`  ⚠️  ${name.padEnd(28)} DB 행은 있으나 파일 없음 — 건너뜀`);
      missing++; continue;
    }

    const targetJob = DASHBOARD_JOB_IDS[division];
    const targetDir = path.resolve(uploadRoot, targetJob, "uploads");
    const target    = path.join(targetDir, name);

    if (path.resolve(r.stored_path) === target) {
      skipped++; continue;                       // 이미 제자리
    }
    if (fs.existsSync(target)) {
      console.log(`  =  ${name.padEnd(28)} 대상에 이미 존재 — 건너뜀`);
      skipped++; continue;
    }

    console.log(`  →  ${name.padEnd(28)} ${division}  (${(r.file_size/1024).toFixed(0)}KB)`);
    console.log(`     ${r.report_job_id.slice(0,8)}…  ⇒  ${targetJob.slice(0,8)}…`);

    if (!APPLY) { moved++; continue; }

    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(r.stored_path, target);      // 원본은 남긴다(되돌리기 대비)

    // 대상 작업공간 기준 행 upsert — 같은 (job, 파일명) 이 있으면 경로만 갱신
    const exist = await query<{ id: string }>(
      `SELECT id FROM uploaded_files WHERE report_job_id = $1 AND original_name = $2`,
      [targetJob, name]
    );
    if (exist.length) {
      await query(
        `UPDATE uploaded_files SET stored_path = $1, file_type = $2, file_size = $3, created_at = NOW()
         WHERE id = $4`,
        [target, r.file_type, r.file_size, exist[0].id]
      );
    } else {
      await query(
        `INSERT INTO uploaded_files (report_job_id, original_name, stored_path, file_type, file_size)
         VALUES ($1, $2, $3, $4, $5)`,
        [targetJob, name, target, r.file_type, r.file_size]
      );
    }
    moved++;
  }

  console.log(`\n이동 ${moved}건 · 건너뜀 ${skipped}건 · 파일없음 ${missing}건`);
  if (!APPLY) console.log("※ dry-run 이었습니다. 실제 적용: --apply");
  await pool.end();
})().catch(async (e) => { console.error("ERROR:", e.message); await pool.end().catch(()=>{}); process.exit(1); });
