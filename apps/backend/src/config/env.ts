/**
 * 환경변수 부트스트랩 — **다른 어떤 모듈보다 먼저** 임포트해야 한다.
 *
 * ── 왜 `import "dotenv/config"` 로 충분하지 않은가 ────────────────────────────
 *  dotenv 는 `.env` 를 **현재 작업 디렉터리** 기준으로 찾는다. 그런데 이 프로젝트의
 *  `.env` 는 리포지토리 루트에 있고, 실행 방법에 따라 cwd 가 달라진다:
 *    · npm run dev --workspace=apps/backend  → cwd = apps/backend  ✗ 못 찾음
 *    · npx tsx apps/backend/src/index.ts     → cwd = 리포지토리 루트 ✓
 *  못 찾으면 **오류 없이 조용히** 전부 코드의 폴백 값으로 동작한다.
 *  실측된 피해(2026-09-10 발견):
 *    · JWT_SECRET 이 "access_secret_dev" (리포지토리에 적힌 값)로 동작
 *    · Veeva 계정이 소스에 박힌 폴백 값으로 동작
 *    · UPLOAD_DIR="uploads" 가 cwd 기준이라 dev 서버는 apps/backend/uploads 에,
 *      루트에서 돌린 스크립트는 uploads/ 에 써서 **수집 산출물이 두 곳으로 갈렸다**
 *      (대시보드가 어느 파일을 읽는지 실행 방법에 따라 달라졌다)
 *
 *  그래서 파일 위치(__dirname)에서 위로 올라가며 리포지토리 루트를 찾고,
 *  거기 있는 `.env` 를 읽는다. 상대경로로 준 데이터 디렉터리도 루트 기준
 *  절대경로로 바꿔, 실행 위치와 무관하게 같은 곳을 가리키게 한다.
 *
 *  컨테이너처럼 `.env` 없이 환경변수로 주입되는 환경도 있으므로,
 *  파일이 없으면 조용히 넘어간다(주입된 값이 이미 process.env 에 있다).
 */

import fs   from "fs";
import path from "path";
import dotenv from "dotenv";

/** package.json 에 workspaces 가 선언된 디렉터리 = 모노레포 루트 */
function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, "utf8")) as { workspaces?: unknown };
        if (json.workspaces) return dir;
      } catch { /* 파싱 실패는 무시하고 위로 계속 */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const repoRoot = findRepoRoot(__dirname) ?? process.cwd();

/** 리포지토리 루트 — 데이터 디렉터리 기준점 */
export const PROJECT_ROOT = repoRoot;

const envPath = path.join(repoRoot, ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  // 컨테이너/ECS: env_file·secrets 로 주입된다. cwd 기준 탐색도 한 번 시도한다.
  dotenv.config();
}

// 상대경로로 준 데이터 디렉터리를 루트 기준 절대경로로 고정한다.
//   (컨테이너에서는 절대경로(/app/uploads)를 주므로 그대로 통과한다)
for (const key of ["UPLOAD_DIR", "OUTPUT_DIR", "SAVED_REPORTS_DIR"] as const) {
  const v = process.env[key];
  if (v && !path.isAbsolute(v)) process.env[key] = path.join(repoRoot, v);
}
