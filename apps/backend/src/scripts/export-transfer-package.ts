/**
 * 사내 MariaDB 이관용 **전달 꾸러미** 생성 (일회성, 반복 실행 안전)
 *
 * ── 왜 필요한가 ───────────────────────────────────────────────────────────────
 *  사내에서 이 맥북의 로컬 MariaDB 에 접속할 수 없으므로, DB 와 파일을 하나의
 *  압축 파일로 만들어 반입한 뒤 사내에서 복원한다.
 *
 *  주의할 점이 하나 있다 — **DB 에 이 맥북의 절대경로가 저장되어 있다.**
 *    /Users/zamini/Project/IT System Ops Report/uploads/…/GCP_PerfStats.xlsx
 *  사내 서버에는 그 경로가 없으므로, 복원 시 경로를 바꿔주지 않으면 DB 는 멀쩡한데
 *  파일을 못 찾아 대시보드·보고서가 조용히 빈 값으로 나온다. restore.sh 가 이를 처리한다.
 *
 * ── 담는 것 ───────────────────────────────────────────────────────────────────
 *  · db.sql.gz          전체 DB 덤프 (utf8mb4)
 *  · files/             앱이 실제로 읽는 파일만 (수집 결과 · 수동 업로드 · 저장된 보고서)
 *                       크롤러 디버그 캡처와 PDF 렌더 중 생성된 차트 이미지는 제외한다.
 *                       (전체 514MB 중 재생성 가능한 것이 대부분이다)
 *  · restore.sh         사내에서 실행할 복원 스크립트 (mariadb 클라이언트만 필요)
 *  · README.md          절차와 검증 방법
 *
 * 실행:  npx tsx apps/backend/src/scripts/export-transfer-package.ts [--out <경로>]
 */
import "../config/env";
import fs   from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { query, pool } from "../config/db";

const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const DB_NAME  = process.env.DB_NAME ?? "skbs_it_report_my";
const SHARED_JOB = "00000000-0000-4000-8000-000000000009";
const FIXED_JOBS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  SHARED_JOB,
];

const outArg = process.argv.indexOf("--out");
const OUT_DIR = outArg > -1 ? process.argv[outArg + 1]
                            : path.join(PROJECT_ROOT, "transfer-package");

/** 앱이 읽는 파일인가 — 디버그 캡처·PDF 렌더 차트는 제외 */
function isPayload(name: string): boolean {
  if (/\.(xlsx|xls|json)$/i.test(name)) return true;          // 수집 결과 · 업로드 엑셀
  if (/^Systemusage_.*\.(png|jpg|jpeg)$/i.test(name)) return true; // 수동 업로드 이미지
  return false;                                                // 그 외(png 캡처 등) 제외
}

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

(async () => {
  console.log(`프로젝트 루트 : ${PROJECT_ROOT}`);
  console.log(`대상 DB       : ${DB_NAME}`);
  console.log(`출력           : ${OUT_DIR}\n`);

  // ── 0. 활성 Timesheet 을 고정 공유 작업공간으로 정리 ────────────────────────
  //  공유 Timesheet 은 original_name 으로 조회되므로 위치가 자유롭지만, 옛 랜덤
  //  jobId 폴더에 남아 있으면 이관 대상을 추리기 어렵다. 고정 작업공간으로 모은다.
  const ts = await query<{ id: string; stored_path: string; file_type: string; file_size: number }>(
    `SELECT id, stored_path, file_type, file_size FROM uploaded_files
     WHERE original_name = 'SKB_Quallity_MS_Timesheet.xlsx'
     ORDER BY created_at DESC LIMIT 1`
  );
  if (ts.length && fs.existsSync(ts[0].stored_path)) {
    const destDir = path.join(PROJECT_ROOT, "uploads", SHARED_JOB, "uploads");
    const dest    = path.join(destDir, "SKB_Quallity_MS_Timesheet.xlsx");
    if (path.resolve(ts[0].stored_path) !== dest) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(ts[0].stored_path, dest);
      await query(`UPDATE uploaded_files SET stored_path = $1 WHERE id = $2`, [dest, ts[0].id]);
      console.log(`① 공유 Timesheet 정리 → ${SHARED_JOB.slice(0, 8)}…/uploads/`);
    } else {
      console.log("① 공유 Timesheet — 이미 제자리");
    }
  } else {
    console.log("① 공유 Timesheet — 없음(건너뜀)");
  }

  // ── 1. 출력 디렉터리 ────────────────────────────────────────────────────────
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, "files"), { recursive: true });

  // ── 2. DB 덤프 ──────────────────────────────────────────────────────────────
  const dumpPath = path.join(OUT_DIR, "db.sql");
  const dump = sh("mariadb-dump", [
    "--single-transaction", "--default-character-set=utf8mb4",
    "--hex-blob", "--routines", "--events", DB_NAME,
  ]);
  fs.writeFileSync(dumpPath, dump);
  sh("gzip", ["-f", dumpPath]);
  const dumpSize = fs.statSync(`${dumpPath}.gz`).size;
  console.log(`② DB 덤프 → db.sql.gz (${(dumpSize / 1024).toFixed(0)} KB)`);

  // ── 3. 파일 수집 ────────────────────────────────────────────────────────────
  let copied = 0, bytes = 0;
  const copyInto = (srcDir: string, relBase: string) => {
    if (!fs.existsSync(srcDir)) return;
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, entry.name);
      if (entry.isDirectory()) { copyInto(src, path.join(relBase, entry.name)); continue; }
      if (!isPayload(entry.name)) continue;
      const destDir = path.join(OUT_DIR, "files", relBase);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, entry.name));
      copied++; bytes += fs.statSync(src).size;
    }
  };
  for (const job of FIXED_JOBS) {
    copyInto(path.join(PROJECT_ROOT, "uploads", job, "uploads"),
             path.join("uploads", job, "uploads"));
  }
  console.log(`③ 작업공간 파일 ${copied}개 (${(bytes / 1048576).toFixed(1)} MB)`);

  // 저장된 보고서(PDF)는 확장자가 달라 따로 복사한다.
  const savedSrc = path.join(PROJECT_ROOT, "apps/backend/saved_reports");
  let savedN = 0, savedB = 0;
  const copyPdfs = (dir: string, rel: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const s = path.join(dir, e.name);
      if (e.isDirectory()) { copyPdfs(s, path.join(rel, e.name)); continue; }
      if (!/\.pdf$/i.test(e.name)) continue;
      const d = path.join(OUT_DIR, "files", rel);
      fs.mkdirSync(d, { recursive: true });
      fs.copyFileSync(s, path.join(d, e.name));
      savedN++; savedB += fs.statSync(s).size;
    }
  };
  copyPdfs(savedSrc, "saved_reports");
  console.log(`④ 저장된 보고서 ${savedN}개 (${(savedB / 1048576).toFixed(1)} MB)`);

  // ── 4. 참조 무결성 점검 — DB 가 가리키는데 꾸러미에 없는 파일 ────────────────
  //  이 점검이 핵심이다. 빠진 파일은 복원 후 조용히 빈 값으로 나타난다.
  const refs = await query<{ p: string }>(
    `SELECT stored_path AS p FROM uploaded_files
     UNION SELECT stored_path FROM saved_reports
     UNION SELECT pdf_path FROM report_jobs WHERE pdf_path IS NOT NULL`
  );
  const missing: string[] = [];
  for (const r of refs) {
    if (!r.p) continue;
    const rel = path.relative(PROJECT_ROOT, r.p);
    const inPkg = fs.existsSync(path.join(OUT_DIR, "files", rel)) ||
                  fs.existsSync(path.join(OUT_DIR, "files",
                    rel.replace(/^apps\/backend\/saved_reports/, "saved_reports")));
    if (!inPkg && fs.existsSync(r.p)) missing.push(rel);
  }
  console.log(`⑤ DB 참조 ${refs.length}건 중 꾸러미 미포함 ${missing.length}건`);
  if (missing.length) {
    console.log("   (옛 작업공간의 과거 이력 — 앱이 읽는 최신본은 포함되어 있다)");
    missing.slice(0, 5).forEach((m) => console.log(`     · ${m}`));
    if (missing.length > 5) console.log(`     … 외 ${missing.length - 5}건`);
  }

  // ── 5. 복원 스크립트·설명서 동봉 ────────────────────────────────────────────
  //  이 둘은 리포지토리(scripts/transfer/)에서 관리한다. 꾸러미에는 실데이터가
  //  들어가므로 꾸러미 자체는 .gitignore 로 제외한다.
  for (const f of ["restore.sh", "README.md"]) {
    const src = path.join(PROJECT_ROOT, "scripts/transfer", f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT_DIR, f));
      if (f.endsWith(".sh")) fs.chmodSync(path.join(OUT_DIR, f), 0o755);
    } else {
      console.log(`   ⚠️  scripts/transfer/${f} 없음 — 꾸러미에 동봉되지 않음`);
    }
  }
  console.log("⑥ restore.sh · README.md 동봉");

  await pool.end();
  console.log(`\n완료 → ${OUT_DIR}`);
  console.log("다음: restore.sh 와 README 를 같은 폴더에 두고 통째로 압축해 반입하세요.");
})().catch(async (e) => {
  console.error("ERROR:", (e as Error).message);
  await pool.end().catch(() => {});
  process.exit(1);
});
