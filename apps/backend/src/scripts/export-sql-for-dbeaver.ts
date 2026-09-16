/**
 * 폐쇄망 반입용 **DBeaver 실행 SQL 꾸러미** 생성
 *
 * ── 왜 별도인가 ───────────────────────────────────────────────────────────────
 *  사내 DB 는 샤크라맥스(DB 접근제어)를 거쳐 **DBeaver 로만** 접근하고, 클라이언트는
 *  폐쇄망 Windows 다. bash 스크립트(restore.sh)도, mariadb CLI 도, 서버 파일 접근도
 *  쓸 수 없다. 그래서 DBeaver 스크립트 실행기에 그대로 붙여 넣을 수 있는 .sql 만 만든다.
 *
 * ── 크기 문제와 해법 ─────────────────────────────────────────────────────────
 *  uploaded_files.analysis_result 에 업로드 엑셀의 **전 시트 전 행**이 JSON 으로
 *  들어 있다(단일 값 최대 1.9MB, 합계 6.2MB). 이런 INSERT 한 줄은 DBeaver 와
 *  접근제어 게이트웨이 양쪽에서 잘리거나 거부되기 쉽다.
 *  그런데 화면이 실제로 읽는 것은 status · result.type · sheetCount/pageCount 뿐이고
 *  ("시트 3개" 배지 한 줄) sheets 배열은 어디서도 읽지 않는다.
 *  → sheets 만 빼고 내보낸다. 6,242KB → 3KB, 최대 단일 값 192B.
 *  원본 엑셀 파일은 그대로 두므로 필요하면 재분석으로 복구할 수 있다.
 *
 * ── 출력 ─────────────────────────────────────────────────────────────────────
 *  01_schema.sql        테이블 정의 (기존 스키마 파일 그대로)
 *  02_data.sql          INSERT (한 행당 한 문장, 컬럼명 명시 → 순서 무관·재시도 쉬움)
 *  03_path_rewrite.sql  DB 안의 절대경로 치환 (사용자가 경로 한 줄만 수정)
 *  04_verify.sql        검증 쿼리
 *
 * 실행:  npx tsx apps/backend/src/scripts/export-sql-for-dbeaver.ts [--out <경로>]
 */
import "../config/env";
import fs   from "fs";
import path from "path";
import { query, pool } from "../config/db";

const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const outArg  = process.argv.indexOf("--out");
const OUT_DIR = outArg > -1 ? process.argv[outArg + 1]
                            : path.join(PROJECT_ROOT, "transfer-sql");

/** FK 의존 순서 — 부모부터 */
const TABLES = [
  "divisions", "users", "report_jobs", "crawl_tasks", "uploaded_files",
  "mail_drafts", "mail_recipient_groups", "saved_reports",
  "dashboard_snapshots", "collection_runs",
];

/** NUL 문자 (히어독에 직접 쓸 수 없어 코드로 만든다) */
const NUL = String.fromCharCode(0);

/** MariaDB 문자열 리터럴로 안전하게 감싼다 */
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Date) {
    // DATETIME 은 UTC 로만 저장한다 — 드라이버가 UTC 로 준 값을 그대로 문자열화한다.
    const p = (n: number) => String(n).padStart(2, "0");
    return `'${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())} ` +
           `${p(v.getUTCHours())}:${p(v.getUTCMinutes())}:${p(v.getUTCSeconds())}'`;
  }
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return "'" + s
    .split("\\").join("\\\\")
    .split("'").join("\\'")
    .split("\n").join("\\n")
    .split("\r").join("\\r")
    .split(NUL).join("") + "'";
}

(async () => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`출력: ${OUT_DIR}\n`);

  // ── 01. 스키마 (시드 데이터 제외) ───────────────────────────────────────────
  //  schema.mariadb.sql 끝에는 divisions 3건·admin 계정 시드가 INSERT IGNORE 로
  //  들어 있다. 그대로 두면 02_data.sql 이 같은 행을 다시 넣다가 중복 키로 멈춘다.
  //  실제 데이터는 02 가 넣으므로 여기서는 테이블 정의만 남긴다.
  const schemaSrc  = path.join(PROJECT_ROOT, "apps/backend/src/config/schema.mariadb.sql");
  const schemaFull = fs.readFileSync(schemaSrc, "utf8");
  const seedMarker = schemaFull.indexOf("-- 초기 데이터");
  const schemaOnly = seedMarker > -1 ? schemaFull.slice(0, seedMarker) : schemaFull;
  fs.writeFileSync(
    path.join(OUT_DIR, "01_schema.sql"),
    schemaOnly.trimEnd() +
    "\n\n-- (시드 데이터는 02_data.sql 이 실제 값으로 넣습니다)\n",
    "utf8"
  );
  if (seedMarker === -1) console.log("   ⚠️  시드 구분 주석을 찾지 못했습니다 — 중복 키 주의");
  console.log("① 01_schema.sql (테이블 정의만)");

  // ── 02. 데이터 ──────────────────────────────────────────────────────────────
  const out: string[] = [
    "-- 데이터 적재 —— DBeaver 에서 대상 스키마를 선택한 뒤 이 파일을 실행하세요.",
    "-- 한 행당 한 문장이라 중간에 실패해도 어디서 멈췄는지 바로 보입니다.",
    "SET FOREIGN_KEY_CHECKS = 0;",
    "SET NAMES utf8mb4;",
    "",
  ];
  let total = 0;
  for (const t of TABLES) {
    const rows = await query<Record<string, unknown>>(`SELECT * FROM \`${t}\``);
    out.push(`-- ── ${t} (${rows.length}행) ${"-".repeat(Math.max(0, 40 - t.length))}`);
    if (!rows.length) { out.push(""); continue; }

    for (const r of rows) {
      const cols = Object.keys(r);
      const vals = cols.map((c) => {
        let v = r[c];
        // 화면이 읽지 않는 거대한 시트 데이터는 제외한다 (위 주석 참고)
        if (t === "uploaded_files" && c === "analysis_result" && v && typeof v === "object") {
          const o = v as { result?: Record<string, unknown> };
          if (o.result && "sheets" in o.result) {
            const slim: Record<string, unknown> = { ...o.result };
            delete slim.sheets;
            v = { ...(v as object), result: slim };
          }
        }
        return lit(v);
      });
      out.push(
        `INSERT INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${vals.join(", ")});`
      );
    }
    out.push("");
    total += rows.length;
    console.log(`   ${t.padEnd(22)} ${String(rows.length).padStart(3)}행`);
  }
  out.push("SET FOREIGN_KEY_CHECKS = 1;");
  fs.writeFileSync(path.join(OUT_DIR, "02_data.sql"), out.join("\n"), "utf8");
  const dataKb = fs.statSync(path.join(OUT_DIR, "02_data.sql")).size / 1024;
  console.log(`② 02_data.sql — ${total}행, ${dataKb.toFixed(0)} KB`);

  // 가장 긴 문장 — 게이트웨이 제한에 걸리지 않는지 확인용
  const longest = out.reduce((m, l) => Math.max(m, l.length), 0);
  console.log(`   가장 긴 SQL 문장: ${longest.toLocaleString()} 자`);

  // ── 03. 경로 치환 ───────────────────────────────────────────────────────────
  fs.writeFileSync(path.join(OUT_DIR, "03_path_rewrite.sql"),
`-- =============================================================================
-- DB 안의 파일 절대경로를 사내 서버 경로로 바꿉니다.
--
-- ★ 아래 @NEW 한 줄만 사내 경로로 수정한 뒤 전체 실행하세요.
--   이 단계를 건너뛰면 DB 는 정상인데 앱이 파일을 찾지 못해
--   대시보드·보고서가 **오류 없이 빈 값**으로 나옵니다.
-- =============================================================================

SET @OLD = '${PROJECT_ROOT}/';
SET @NEW = '/srv/skbs/';        -- ← 사내 서버의 파일 보관 경로로 수정

-- saved_reports 는 원본에서 apps/backend/ 아래에 있었으므로 먼저 접어 줍니다.
UPDATE uploaded_files SET stored_path =
  REPLACE(stored_path, CONCAT(@OLD,'apps/backend/saved_reports/'), CONCAT(@NEW,'saved_reports/'));
UPDATE saved_reports  SET stored_path =
  REPLACE(stored_path, CONCAT(@OLD,'apps/backend/saved_reports/'), CONCAT(@NEW,'saved_reports/'));

UPDATE uploaded_files SET stored_path = REPLACE(stored_path, @OLD, @NEW);
UPDATE saved_reports  SET stored_path = REPLACE(stored_path, @OLD, @NEW);
UPDATE report_jobs    SET pdf_path    = REPLACE(pdf_path,    @OLD, @NEW) WHERE pdf_path    IS NOT NULL;
UPDATE crawl_tasks    SET result_path = REPLACE(result_path, @OLD, @NEW) WHERE result_path IS NOT NULL;

-- 남은 원본 경로가 있는지 확인 (0 이어야 정상)
SELECT COUNT(*) AS 남은_원본경로 FROM uploaded_files WHERE stored_path LIKE CONCAT(@OLD,'%');
`, "utf8");
  console.log("③ 03_path_rewrite.sql");

  // ── 04. 검증 ────────────────────────────────────────────────────────────────
  const counts = await query<{ t: string; c: number }>(
    TABLES.map((t) => `SELECT '${t}' AS t, COUNT(*) AS c FROM \`${t}\``).join(" UNION ALL ")
  );
  fs.writeFileSync(path.join(OUT_DIR, "04_verify.sql"),
`-- =============================================================================
-- 복원 검증 — 아래 "원본" 값과 같아야 합니다.
-- =============================================================================
-- 원본 행 수:
${counts.map((c) => `--   ${c.t.padEnd(22)} ${c.c}`).join("\n")}

${TABLES.map((t) => `SELECT '${t}' AS 테이블, COUNT(*) AS 행수 FROM \`${t}\``).join("\nUNION ALL ")};

-- 최신 스냅샷 — 원본과 날짜가 같아야 합니다(하루 밀리면 타임존 문제).
SELECT division_code, captured_date FROM dashboard_snapshots
ORDER BY captured_date DESC, division_code LIMIT 6;

-- 서버 타임존 — UTC 를 권장합니다.
--   이 앱은 모든 DATETIME 에 UTC 만 저장하고 KST 변환은 앱이 합니다.
SELECT @@global.time_zone AS global_tz, @@session.time_zone AS session_tz;

-- 한글이 깨지지 않았는지
SELECT code, name FROM divisions ORDER BY code;
`, "utf8");
  console.log("④ 04_verify.sql");

  await pool.end();
  console.log(`\n완료 → ${OUT_DIR}`);
})().catch(async (e) => {
  console.error("ERROR:", (e as Error).message);
  await pool.end().catch(() => {});
  process.exit(1);
});
