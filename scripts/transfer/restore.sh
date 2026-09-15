#!/usr/bin/env bash
# =============================================================================
# 사내 MariaDB 복원 스크립트
#
#   필요한 것: mariadb(또는 mysql) 클라이언트, tar, gzip.  Node 는 필요 없습니다.
#
#   사용법:
#     DB_HOST=... DB_USER=... DB_PASS=... DB_NAME=skbs_it_report \
#     TARGET_ROOT=/srv/skbs  bash restore.sh
#
#   TARGET_ROOT — 파일을 둘 위치. DB 에 저장된 절대경로를 이 값으로 바꿉니다.
# =============================================================================
set -euo pipefail

DB_NAME="${DB_NAME:-skbs_it_report}"
TARGET_ROOT="${TARGET_ROOT:?TARGET_ROOT 를 지정하세요 (예: /srv/skbs)}"
DB_USER="${DB_USER:?DB_USER 를 지정하세요}"
# 접속은 TCP(기본) 또는 유닉스 소켓. 소켓 인증 서버에서는 DB_SOCKET 만 주면 됩니다.
DB_SOCKET="${DB_SOCKET:-}"
if [ -z "$DB_SOCKET" ]; then
  DB_HOST="${DB_HOST:?DB_HOST 또는 DB_SOCKET 을 지정하세요}"
  DB_PORT="${DB_PORT:-3306}"
fi

# 원본 맥북의 경로 — DB 안의 절대경로가 이 값으로 시작합니다.
SOURCE_ROOT="/Users/zamini/Project/IT System Ops Report"

CLI=$(command -v mariadb || command -v mysql)
if [ -n "$DB_SOCKET" ]; then
  MYSQL=("$CLI" --socket="$DB_SOCKET" -u "$DB_USER" --default-character-set=utf8mb4)
  [ -n "${DB_PASS:-}" ] && MYSQL+=("-p${DB_PASS}")
  WHERE="socket:${DB_SOCKET}"
else
  MYSQL=("$CLI" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" --default-character-set=utf8mb4)
  MYSQL+=("-p${DB_PASS:?DB_PASS 를 지정하세요}")
  WHERE="${DB_HOST}:${DB_PORT}"
fi

echo "대상 DB     : ${DB_USER}@${WHERE}/${DB_NAME}"
echo "파일 위치   : ${TARGET_ROOT}"
echo

# ── 1. DB 생성 ───────────────────────────────────────────────────────────────
echo "① 데이터베이스 생성"
"${MYSQL[@]}" -e "CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
                  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

# ── 2. 덤프 복원 ─────────────────────────────────────────────────────────────
echo "② 덤프 복원 (db.sql.gz)"
gzip -dc db.sql.gz | "${MYSQL[@]}" "$DB_NAME"

# ── 3. 파일 배치 ─────────────────────────────────────────────────────────────
echo "③ 파일 배치"
mkdir -p "$TARGET_ROOT"
cp -R files/. "$TARGET_ROOT"/

# ── 4. 절대경로 치환 ★ 이 단계를 빠뜨리면 DB 는 멀쩡한데 파일을 못 찾습니다 ──
#   원본은 uploads/ 와 apps/backend/… 두 갈래를 쓰지만, 꾸러미는 한 트리로 모았으므로
#   saved_reports 경로만 따로 접어 준 뒤 공통 접두사를 바꿉니다.
echo "④ DB 안의 절대경로 치환"
"${MYSQL[@]}" "$DB_NAME" <<SQL
UPDATE uploaded_files SET stored_path =
  REPLACE(stored_path, '${SOURCE_ROOT}/apps/backend/saved_reports/', '${TARGET_ROOT}/saved_reports/');
UPDATE saved_reports  SET stored_path =
  REPLACE(stored_path, '${SOURCE_ROOT}/apps/backend/saved_reports/', '${TARGET_ROOT}/saved_reports/');
UPDATE uploaded_files SET stored_path = REPLACE(stored_path, '${SOURCE_ROOT}/', '${TARGET_ROOT}/');
UPDATE saved_reports  SET stored_path = REPLACE(stored_path, '${SOURCE_ROOT}/', '${TARGET_ROOT}/');
UPDATE report_jobs    SET pdf_path    = REPLACE(pdf_path,    '${SOURCE_ROOT}/', '${TARGET_ROOT}/')
  WHERE pdf_path IS NOT NULL;
UPDATE crawl_tasks    SET result_path = REPLACE(result_path, '${SOURCE_ROOT}/', '${TARGET_ROOT}/')
  WHERE result_path IS NOT NULL;
SQL

# ── 5. 검증 ─────────────────────────────────────────────────────────────────
echo
echo "⑤ 검증"
"${MYSQL[@]}" "$DB_NAME" -e "
SELECT '행 수' AS 항목, '' AS 값 UNION ALL
SELECT '  divisions',           CAST(COUNT(*) AS CHAR) FROM divisions           UNION ALL
SELECT '  users',               CAST(COUNT(*) AS CHAR) FROM users               UNION ALL
SELECT '  dashboard_snapshots', CAST(COUNT(*) AS CHAR) FROM dashboard_snapshots UNION ALL
SELECT '  saved_reports',       CAST(COUNT(*) AS CHAR) FROM saved_reports       UNION ALL
SELECT '  uploaded_files',      CAST(COUNT(*) AS CHAR) FROM uploaded_files;"

echo
echo "  최신 스냅샷 (날짜가 원본과 같아야 합니다 — 하루 밀리면 타임존 문제)"
"${MYSQL[@]}" "$DB_NAME" -e "
SELECT division_code, captured_date FROM dashboard_snapshots
ORDER BY captured_date DESC LIMIT 3;"

echo
echo "  서버 타임존"
TZ_OUT=$("${MYSQL[@]}" -N -e "SELECT @@global.time_zone;")
echo "    global time_zone = ${TZ_OUT}"
case "$TZ_OUT" in
  "+00:00"|"UTC") echo "    ✅ UTC" ;;
  *) cat <<'TZWARN'
    ⚠️  UTC 가 아닙니다.
        이 앱은 모든 DATETIME 에 UTC 만 저장하고 KST 변환은 앱이 합니다.
        앱은 커넥션마다 SET time_zone='+00:00' 을 걸므로 대개 문제가 없지만,
        DB 에서 직접 조회·집계할 때 값이 어긋나 보입니다. 서버 기본값도
        UTC 로 맞추기를 권장합니다. (RDS: 파라미터 그룹 time_zone=UTC)
TZWARN
  ;;
esac

echo
echo "  앱이 읽는 파일이 실제로 있는지"
#   앱이 읽는 것은 ① 본부별 고정 작업공간의 파일과 ② 공유 Timesheet 뿐입니다.
#   옛 랜덤 jobId 폴더의 과거 이력 행은 이관 대상이 아니므로 검사에서 제외합니다.
MISSING=0; CHECKED=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  CHECKED=$((CHECKED+1))
  if [ ! -f "$f" ]; then echo "    [없음] $f"; MISSING=$((MISSING+1)); fi
done < <("${MYSQL[@]}" -N "$DB_NAME" -e "
  SELECT stored_path FROM uploaded_files
   WHERE report_job_id IN (
           '00000000-0000-4000-8000-000000000001',
           '00000000-0000-4000-8000-000000000002',
           '00000000-0000-4000-8000-000000000003',
           '00000000-0000-4000-8000-000000000009')
  UNION
  SELECT stored_path FROM uploaded_files u
   WHERE original_name = 'SKB_Quallity_MS_Timesheet.xlsx'
     AND created_at = (SELECT MAX(created_at) FROM uploaded_files x
                        WHERE x.original_name = 'SKB_Quallity_MS_Timesheet.xlsx');")
if [ "$MISSING" -eq 0 ]; then echo "    ✅ ${CHECKED}건 모두 존재"; else echo "    ❌ ${CHECKED}건 중 ${MISSING}건 누락"; fi

echo
echo "  저장된 보고서 PDF"
PMISS=0; PCHK=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  PCHK=$((PCHK+1))
  [ -f "$f" ] || { echo "    [없음] $f"; PMISS=$((PMISS+1)); }
done < <("${MYSQL[@]}" -N "$DB_NAME" -e "SELECT stored_path FROM saved_reports;")
if [ "$PMISS" -eq 0 ]; then echo "    ✅ ${PCHK}건 모두 존재"; else echo "    ❌ ${PCHK}건 중 ${PMISS}건 누락"; fi

cat <<'NEXT'

─────────────────────────────────────────────────────────────────
다음: 애플리케이션 환경변수(.env)

  DATABASE_URL=mysql://<user>:<pass>@<host>:3306/<db>
  DB_SSL=true                # TLS 필수인 경우
  UPLOAD_DIR=<TARGET_ROOT>/uploads
  OUTPUT_DIR=<TARGET_ROOT>/outputs
  SAVED_REPORTS_DIR=<TARGET_ROOT>/saved_reports
─────────────────────────────────────────────────────────────────
NEXT
