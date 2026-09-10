/**
 * Postgres → MariaDB 데이터 이관 (일회성)
 *   - FK 순서를 지켜 옮긴다
 *   - TIMESTAMPTZ → DATETIME(UTC), JSONB → JSON, TEXT[] → JSON 배열
 *   - 재실행 안전: 대상 테이블을 비우고 다시 넣는다
 */
import "dotenv/config";
import { Pool } from "pg";
import mysql from "mysql2/promise";

const PG_URL = process.env.PG_URL ?? "postgresql://localhost/skbs_it_report";

// FK 의존 순서
const TABLES: { name: string; cols: string[]; json: string[]; arr: string[]; date?: string[] }[] = [
  { name: "divisions",             cols: ["id","code","name","system_configs"], json: ["system_configs"], arr: [] },
  { name: "users",                 cols: ["id","email","password_hash","name","division_id","role","created_at","updated_at"], json: [], arr: [] },
  { name: "report_jobs",           cols: ["id","division_id","status","started_at","completed_at","pdf_path","error_message","created_by","created_at","updated_at"], json: [], arr: [] },
  { name: "crawl_tasks",           cols: ["id","report_job_id","system_name","task_type","status","result_path","error","created_at","updated_at"], json: [], arr: [] },
  { name: "uploaded_files",        cols: ["id","report_job_id","original_name","stored_path","file_type","file_size","analysis_result","created_at"], json: ["analysis_result"], arr: [] },
  { name: "mail_drafts",           cols: ["id","report_job_id","recipients","cc","subject","body_html","created_at","updated_at"], json: [], arr: ["recipients","cc"] },
  { name: "mail_recipient_groups", cols: ["id","division_code","name","emails","created_at"], json: ["emails"], arr: [] },
  { name: "saved_reports",         cols: ["id","division_code","report_type","year","month","source_job_id","filename","stored_path","file_size","saved_by","saved_at"], json: [], arr: [] },
  { name: "dashboard_snapshots",   cols: ["id","division_code","captured_date","data","sources","created_at","updated_at"], json: ["data","sources"], arr: [], date: ["captured_date"] },
  { name: "collection_runs",       cols: ["id","division_code","trigger","status","started_at","finished_at","detail"], json: ["detail"], arr: [] },
];

const q = (c: string) => "`" + c + "`";   // trigger 등 예약어 대응

(async () => {
  const pg = new Pool({ connectionString: PG_URL });
  // 대상 MariaDB: MARIA_URL 이 있으면 TCP(컨테이너·RDS), 없으면 로컬 소켓
  const my = process.env.MARIA_URL
    ? await mysql.createConnection({ uri: process.env.MARIA_URL, timezone: "Z" })
    : await mysql.createConnection({
        socketPath: process.env.DB_SOCKET ?? "/tmp/mysql.sock",
        user:       process.env.DB_USER   ?? process.env.USER,
        database:   process.env.DB_NAME   ?? "skbs_it_report_my",
        timezone:   "Z", multipleStatements: false,
      });
  await my.query("SET time_zone='+00:00'");
  await my.query("SET FOREIGN_KEY_CHECKS=0");

  // 역순으로 비우기
  for (const t of [...TABLES].reverse()) await my.query(`DELETE FROM ${q(t.name)}`);

  // 원본에 없는 테이블(스키마에만 있고 생성되지 않은 것)은 건너뛴다
  const present = new Set<string>(
    (await pg.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
    )).rows.map((r) => r.table_name)
  );

  let total = 0;
  for (const t of TABLES) {
    if (!present.has(t.name)) { console.log(`  ${t.name.padEnd(23)} — 원본에 없음, 건너뜀`); continue; }
    const { rows } = await pg.query(`SELECT ${t.cols.map((c) => `"${c}"`).join(", ")} FROM ${t.name}`);
    if (!rows.length) { console.log(`  ${t.name.padEnd(23)} 0행`); continue; }

    const placeholders = `(${t.cols.map(() => "?").join(",")})`;
    for (const r of rows) {
      const vals = t.cols.map((c) => {
        const v = (r as Record<string, unknown>)[c];
        if (v === null || v === undefined) return null;
        if (t.json.includes(c)) return typeof v === "string" ? v : JSON.stringify(v);
        if (t.arr.includes(c))  return JSON.stringify(Array.isArray(v) ? v : []);
        // DATE 컬럼: pg 는 '로컬 자정' Date 객체를 준다. 그대로 넘기면 드라이버가
        // UTC 로 변환해(KST 자정 = 전날 15:00 UTC) DATE 가 **하루 밀린다**.
        // 시각이 아니라 달력 날짜이므로 'YYYY-MM-DD' 문자열로 보낸다.
        if (t.date?.includes(c)) {
          if (v instanceof Date) {
            const p2 = (n: number) => String(n).padStart(2, "0");
            return `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`;
          }
          return String(v).slice(0, 10);
        }
        return v;
      });
      await my.query(
        `INSERT INTO ${q(t.name)} (${t.cols.map(q).join(",")}) VALUES ${placeholders}`,
        vals
      );
    }
    total += rows.length;
    console.log(`  ${t.name.padEnd(23)} ${rows.length}행`);
  }

  await my.query("SET FOREIGN_KEY_CHECKS=1");
  console.log(`\n총 ${total}행 이관`);

  // 검증: 양쪽 행 수 비교
  console.log("\n=== 행 수 검증 ===");
  let bad = 0;
  for (const t of TABLES) {
    if (!present.has(t.name)) { console.log(`  ⏭️  ${t.name.padEnd(23)} 원본에 없음`); continue; }
    const a = Number((await pg.query(`SELECT COUNT(*) c FROM ${t.name}`)).rows[0].c);
    const [mr] = await my.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) c FROM ${q(t.name)}`);
    const b = Number(mr[0].c);
    const ok = a === b; if (!ok) bad++;
    console.log(`  ${ok ? "✅" : "❌"} ${t.name.padEnd(23)} pg=${a}  maria=${b}`);
  }
  // 날짜 경계 검증 — 하루 밀림이 가장 위험한 오류다
  console.log("\n=== captured_date 대조 ===");
  const pgd = (await pg.query<{ division_code: string; d: string }>(
    "SELECT division_code, to_char(captured_date,'YYYY-MM-DD') d FROM dashboard_snapshots ORDER BY division_code, d"
  )).rows;
  const [myd] = await my.query<mysql.RowDataPacket[]>(
    "SELECT division_code, DATE_FORMAT(captured_date,'%Y-%m-%d') d FROM dashboard_snapshots ORDER BY division_code, d"
  );
  for (let i = 0; i < pgd.length; i++) {
    const a = pgd[i], b = myd[i];
    const ok = a && b && a.division_code === b.division_code && a.d === b.d;
    if (!ok) bad++;
    console.log(`  ${ok ? "✅" : "❌"} ${a?.division_code} pg=${a?.d} maria=${b?.d}`);
  }

  await pg.end(); await my.end();
  console.log(bad ? `\n❌ 불일치 ${bad}건` : "\n✅ 전부 일치");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("MIGRATE ERROR:", e.message); process.exit(1); });
