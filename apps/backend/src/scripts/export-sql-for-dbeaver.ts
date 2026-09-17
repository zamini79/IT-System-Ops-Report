/**
 * 폐쇄망 반입용 **DBeaver 실행 꾸러미** 생성
 *
 * ── 전제 ─────────────────────────────────────────────────────────────────────
 *  사내 DB 는 샤크라맥스(DB 접근제어)를 거쳐 **DBeaver 로만** 접근하고 클라이언트는
 *  폐쇄망 Windows 다. bash 스크립트도 mariadb CLI 도 쓸 수 없다.
 *  **스키마(테이블 정의)는 사내에서 별도로 생성**하므로, 이 꾸러미는 그 이후 단계만
 *  담는다: 사전 점검 → 데이터 적재 → 경로 치환 → 검증.
 *  파일(엑셀·이미지·PDF)도 폐쇄망으로 옮길 수 있으므로 함께 넣는다.
 *
 * ── 크기 문제와 해법 ─────────────────────────────────────────────────────────
 *  uploaded_files.analysis_result 에 업로드 엑셀의 **전 시트 전 행**이 JSON 으로
 *  들어 있다(단일 값 최대 1.9MB, 합계 6.2MB). 이런 INSERT 한 줄은 DBeaver 와
 *  접근제어 게이트웨이 양쪽에서 잘리거나 거부되기 쉽다.
 *  화면이 실제로 읽는 값은 status · result.type · sheetCount/pageCount 뿐이고
 *  ("시트 3개" 배지 한 줄) sheets 배열은 어디서도 읽지 않는다.
 *  → sheets 만 빼고 내보낸다. 6,242KB → 3KB. 원본 엑셀이 있으므로 재분석으로 복구 가능.
 *
 * ── 출력 ─────────────────────────────────────────────────────────────────────
 *  00_precheck.sql      스키마가 기대대로 만들어졌는지 · 기존 데이터가 있는지 확인
 *  01_data.sql          데이터 적재 (한 행당 한 문장)
 *  02_path_rewrite.sql  DB 안의 파일 절대경로 치환 (@NEW 한 줄만 수정)
 *  03_verify.sql        검증 (원본 값을 주석에 박아 대조)
 *  files/               앱이 읽는 실제 파일
 *  README.md            절차
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

/** FK 의존 순서 — 부모부터. 삭제는 역순으로 한다. */
const TABLES = [
  "divisions", "users", "report_jobs", "crawl_tasks", "uploaded_files",
  "mail_drafts", "mail_recipient_groups", "saved_reports",
  "dashboard_snapshots", "collection_runs",
];

/** 고정 작업공간 jobId — 앱이 파일을 읽는 곳 */
const FIXED_JOBS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000009",
];

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

/** 앱이 읽는 파일인가 — 크롤러 디버그 캡처·PDF 렌더 차트는 제외 */
function isPayload(name: string): boolean {
  if (/\.(xlsx|xls|json)$/i.test(name)) return true;
  if (/^Systemusage_.*\.(png|jpg|jpeg)$/i.test(name)) return true;
  return false;
}

(async () => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`출력: ${OUT_DIR}\n`);

  // ── 00. 사전 점검 ───────────────────────────────────────────────────────────
  //  스키마를 사내에서 따로 만들므로, 기대한 테이블·컬럼이 실제로 있는지 먼저 본다.
  //  다르면 01 의 INSERT 가 "Unknown column" 같은 오류로 중간에 멈춘다.
  const colRows = await query<{ t: string; c: string }>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
     ORDER BY TABLE_NAME, ORDINAL_POSITION`
  );
  const colsByTable = new Map<string, string[]>();
  for (const r of colRows) {
    if (!colsByTable.has(r.t)) colsByTable.set(r.t, []);
    colsByTable.get(r.t)!.push(r.c);
  }

  const expected = TABLES.map((t) => {
    const cols = colsByTable.get(t) ?? [];
    return `SELECT '${t}' AS 테이블,\n` +
           `       (SELECT COUNT(*) FROM information_schema.TABLES\n` +
           `         WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${t}') AS 존재,\n` +
           `       ${cols.length} AS 기대컬럼수,\n` +
           `       (SELECT COUNT(*) FROM information_schema.COLUMNS\n` +
           `         WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${t}') AS 실제컬럼수`;
  }).join("\nUNION ALL\n");

  const missingColsChecks = TABLES.map((t) => {
    const cols = colsByTable.get(t) ?? [];
    const list = cols.map((c) => `'${c}'`).join(",");
    return `SELECT '${t}' AS 테이블, GROUP_CONCAT(x.c ORDER BY x.c) AS 없는컬럼\n` +
           `FROM (SELECT ${cols.map((c) => `'${c}' AS c`).join(" UNION ALL SELECT ")}) x\n` +
           `LEFT JOIN information_schema.COLUMNS ic\n` +
           `  ON ic.TABLE_SCHEMA=DATABASE() AND ic.TABLE_NAME='${t}' AND ic.COLUMN_NAME=x.c\n` +
           `WHERE ic.COLUMN_NAME IS NULL HAVING 없는컬럼 IS NOT NULL`;
  }).join("\nUNION ALL\n");

  fs.writeFileSync(path.join(OUT_DIR, "00_precheck.sql"),
`-- =============================================================================
-- 00. 사전 점검 — 데이터를 넣기 전에 실행하세요.
--
-- 스키마는 사내에서 별도로 생성하므로, 기대한 테이블·컬럼이 실제로 만들어졌는지
-- 먼저 확인합니다. 다르면 01_data.sql 이 "Unknown column" 등으로 중간에 멈춥니다.
-- =============================================================================

-- ① 대상 스키마가 맞는지
SELECT DATABASE() AS 현재스키마, @@version AS 버전;

-- ② 테이블 존재 · 컬럼 수 대조  (존재=1, 기대컬럼수=실제컬럼수 여야 정상)
${expected};

-- ③ 없는 컬럼 목록  (결과가 **0행** 이어야 정상)
${missingColsChecks};

-- ④ 기존 데이터 확인
--    행이 있으면 01_data.sql 의 맨 앞 DELETE 블록이 지웁니다.
--    지우면 안 되는 데이터가 있는지 반드시 확인하세요.
${TABLES.map((t) => `SELECT '${t}' AS 테이블, COUNT(*) AS 기존행수 FROM \`${t}\``).join("\nUNION ALL ")};

-- ⑤ 문자셋 — utf8mb4 여야 한글이 깨지지 않습니다
SELECT DEFAULT_CHARACTER_SET_NAME AS 문자셋, DEFAULT_COLLATION_NAME AS 콜레이션
FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE();

-- ⑥ 서버 타임존 — UTC 권장 (이 앱은 모든 DATETIME 을 UTC 로 저장합니다)
SELECT @@global.time_zone AS global_tz, @@session.time_zone AS session_tz;
`, "utf8");
  console.log("① 00_precheck.sql");

  // ── 01. 데이터 ──────────────────────────────────────────────────────────────
  const out: string[] = [
    "-- =============================================================================",
    "-- 01. 데이터 적재",
    "--",
    "--   DBeaver 에서 대상 스키마를 선택한 뒤 **Execute script (Alt+X)** 로 실행하세요.",
    "--   (Ctrl+Enter 는 문장 하나만 실행합니다)",
    "--",
    "--   ⚠️  맨 아래 DELETE 블록이 **대상 테이블을 모두 비웁니다.**",
    "--       스키마 생성 시 들어간 시드(divisions 3건·admin 계정)와 겹치면 중복 키로",
    "--       멈추기 때문입니다. 00_precheck.sql ④ 로 지워도 되는지 먼저 확인하세요.",
    "--       이 구성 덕분에 중간에 실패해도 처음부터 다시 실행할 수 있습니다.",
    "--",
    "--   한 행당 한 문장입니다. 게이트웨이가 문장 단위로 감사·차단하므로",
    "--   막히면 어디서 멈췄는지 바로 보입니다. 컬럼명을 명시해 열 순서 차이에도 견딥니다.",
    "-- =============================================================================",
    "",
    "SET NAMES utf8mb4;",
    "SET FOREIGN_KEY_CHECKS = 0;",
    "",
    "-- 기존 행 제거 (FK 역순)",
    ...[...TABLES].reverse().map((t) => `DELETE FROM \`${t}\`;`),
    "",
  ];

  let total = 0;
  for (const t of TABLES) {
    const rows = await query<Record<string, unknown>>(`SELECT * FROM \`${t}\``);
    out.push(`-- ---- ${t} (${rows.length}행) ${"-".repeat(Math.max(0, 40 - t.length))}`);
    if (!rows.length) { out.push(""); continue; }

    for (const r of rows) {
      const cols = Object.keys(r);
      const vals = cols.map((c) => {
        let v = r[c];
        // 화면이 읽지 않는 거대한 시트 데이터는 제외한다 (파일 상단 주석 참고)
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
  fs.writeFileSync(path.join(OUT_DIR, "01_data.sql"), out.join("\n"), "utf8");
  const dataKb = fs.statSync(path.join(OUT_DIR, "01_data.sql")).size / 1024;
  const longest = out.reduce((m, l) => Math.max(m, l.length), 0);
  console.log(`② 01_data.sql — ${total}행, ${dataKb.toFixed(0)} KB (가장 긴 문장 ${longest.toLocaleString()}자)`);

  // ── 02. 경로 치환 ───────────────────────────────────────────────────────────
  fs.writeFileSync(path.join(OUT_DIR, "02_path_rewrite.sql"),
`-- =============================================================================
-- 02. 파일 절대경로 치환
--
-- DB 에는 원본 맥북의 절대경로가 그대로 들어 있습니다.
--   ${PROJECT_ROOT}/uploads/.../GCP_PerfStats.xlsx
-- 사내 서버에는 이 경로가 없으므로, 바꾸지 않으면 **DB 는 정상인데 앱이 파일을
-- 찾지 못해 대시보드·보고서가 오류 없이 빈 값으로** 나옵니다.
--
-- ★ 아래 @NEW 한 줄만 수정한 뒤 전체 실행하세요.
--   files/ 를 풀어 둔 경로여야 합니다. 예) /srv/skbs  →  /srv/skbs/uploads/... 구조
-- =============================================================================

SET @OLD = '${PROJECT_ROOT}/';
SET @NEW = '/srv/skbs/';        -- ← files/ 를 배치한 경로로 수정

-- saved_reports 는 원본에서 apps/backend/ 아래에 있었으므로 먼저 접어 줍니다.
UPDATE uploaded_files SET stored_path =
  REPLACE(stored_path, CONCAT(@OLD,'apps/backend/saved_reports/'), CONCAT(@NEW,'saved_reports/'));
UPDATE saved_reports  SET stored_path =
  REPLACE(stored_path, CONCAT(@OLD,'apps/backend/saved_reports/'), CONCAT(@NEW,'saved_reports/'));

-- 나머지 (uploads/ · outputs/ · apps/backend/uploads/ …)
UPDATE uploaded_files SET stored_path = REPLACE(stored_path, @OLD, @NEW);
UPDATE saved_reports  SET stored_path = REPLACE(stored_path, @OLD, @NEW);
UPDATE report_jobs    SET pdf_path    = REPLACE(pdf_path,    @OLD, @NEW) WHERE pdf_path    IS NOT NULL;
UPDATE crawl_tasks    SET result_path = REPLACE(result_path, @OLD, @NEW) WHERE result_path IS NOT NULL;

-- 확인 — 모두 0 이어야 정상
SELECT 'uploaded_files' AS 테이블, COUNT(*) AS 남은_원본경로 FROM uploaded_files WHERE stored_path LIKE CONCAT(@OLD,'%')
UNION ALL SELECT 'saved_reports', COUNT(*) FROM saved_reports WHERE stored_path LIKE CONCAT(@OLD,'%')
UNION ALL SELECT 'report_jobs',   COUNT(*) FROM report_jobs   WHERE pdf_path    LIKE CONCAT(@OLD,'%')
UNION ALL SELECT 'crawl_tasks',   COUNT(*) FROM crawl_tasks   WHERE result_path LIKE CONCAT(@OLD,'%');
`, "utf8");
  console.log("③ 02_path_rewrite.sql");

  // ── 03. 검증 ────────────────────────────────────────────────────────────────
  const counts = await query<{ t: string; c: number }>(
    TABLES.map((t) => `SELECT '${t}' AS t, COUNT(*) AS c FROM \`${t}\``).join(" UNION ALL ")
  );
  const snaps = await query<{ division_code: string; d: string }>(
    `SELECT division_code, DATE_FORMAT(captured_date,'%Y-%m-%d') AS d
     FROM dashboard_snapshots ORDER BY captured_date DESC, division_code LIMIT 6`
  );

  fs.writeFileSync(path.join(OUT_DIR, "03_verify.sql"),
`-- =============================================================================
-- 03. 검증 — 아래 "원본" 주석과 결과가 같아야 합니다.
-- =============================================================================
-- 원본 행 수:
${counts.map((c) => `--   ${c.t.padEnd(22)} ${c.c}`).join("\n")}
--
-- 원본 최신 스냅샷:
${snaps.map((s) => `--   ${s.division_code.padEnd(7)} ${s.d}`).join("\n")}

-- ① 행 수
${TABLES.map((t) => `SELECT '${t}' AS 테이블, COUNT(*) AS 행수 FROM \`${t}\``).join("\nUNION ALL ")};

-- ② 최신 스냅샷 — 날짜가 하루 밀리면 타임존 문제입니다
SELECT division_code, captured_date FROM dashboard_snapshots
ORDER BY captured_date DESC, division_code LIMIT 6;

-- ③ 한글이 깨지지 않았는지 (Bio연구본부 · 개발본부 · L HOUSE 공장)
SELECT code, name FROM divisions ORDER BY code;

-- ④ 경로가 사내 경로로 바뀌었는지 (앱이 읽는 고정 작업공간만)
SELECT report_job_id, original_name, stored_path
FROM uploaded_files
WHERE report_job_id IN (${FIXED_JOBS.map((j) => `'${j}'`).join(",\n                        ")})
ORDER BY report_job_id, original_name;

-- ⑤ 로그인 계정
SELECT email, role FROM users;
`, "utf8");
  console.log("④ 03_verify.sql");

  // ── files/ ──────────────────────────────────────────────────────────────────
  let copied = 0, bytes = 0;
  const copyInto = (srcDir: string, relBase: string, filter: (n: string) => boolean) => {
    if (!fs.existsSync(srcDir)) return;
    for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, e.name);
      if (e.isDirectory()) { copyInto(src, path.join(relBase, e.name), filter); continue; }
      if (!filter(e.name)) continue;
      const destDir = path.join(OUT_DIR, "files", relBase);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, e.name));
      copied++; bytes += fs.statSync(src).size;
    }
  };
  for (const job of FIXED_JOBS) {
    copyInto(path.join(PROJECT_ROOT, "uploads", job, "uploads"),
             path.join("uploads", job, "uploads"), isPayload);
  }
  copyInto(path.join(PROJECT_ROOT, "apps/backend/saved_reports"),
           "saved_reports", (n) => /\.pdf$/i.test(n));
  console.log(`⑤ files/ — ${copied}개, ${(bytes / 1048576).toFixed(1)} MB`);

  // README 동봉
  const readme = path.join(PROJECT_ROOT, "scripts/transfer/README-dbeaver.md");
  if (fs.existsSync(readme)) {
    fs.copyFileSync(readme, path.join(OUT_DIR, "README.md"));
    console.log("⑥ README.md");
  }

  await pool.end();
  console.log(`\n완료 → ${OUT_DIR}`);
})().catch(async (e) => {
  console.error("ERROR:", (e as Error).message);
  await pool.end().catch(() => {});
  process.exit(1);
});
