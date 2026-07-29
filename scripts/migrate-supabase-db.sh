#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Supabase DB 마이그레이션 자동화 스크립트
#
# 사용 방법:
#   export OLD_DB_URL="postgresql://postgres.OLD:PASS@aws-0-xx.pooler.supabase.com:5432/postgres"
#   export NEW_DB_URL="postgresql://postgres.NEW:PASS@aws-0-xx.pooler.supabase.com:5432/postgres"
#   bash scripts/migrate-supabase-db.sh
#
# 절차:
#   1. 양쪽 DB 연결 검증
#   2. 새 DB 에 schema.sql 적용
#   3. 기존 DB → public 데이터만 dump
#   4. 새 DB 에 데이터 restore
#   5. row count 검증
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$REPO_ROOT/apps/backend/src/config/schema.sql"
DUMP_FILE="/tmp/skbs_data_$(date +%Y%m%d_%H%M%S).sql"

c_red='\033[0;31m'; c_green='\033[0;32m'; c_yellow='\033[0;33m'
c_cyan='\033[0;36m'; c_bold='\033[1m'; c_reset='\033[0m'

ok()    { printf "${c_green}✓${c_reset} %s\n"    "$1"; }
warn()  { printf "${c_yellow}!${c_reset} %s\n"   "$1"; }
fail()  { printf "${c_red}✗${c_reset} %s\n"      "$1" >&2; exit 1; }
step()  { printf "\n${c_bold}${c_cyan}▶ %s${c_reset}\n" "$1"; }

# ── 0. 사전 검증 ────────────────────────────────────────────────────────────
step "0. 사전 검증"

command -v pg_dump >/dev/null || fail "pg_dump 미설치 (brew install libpq && brew link --force libpq)"
command -v psql    >/dev/null || fail "psql 미설치"
[ -f "$SCHEMA" ]               || fail "schema.sql 미발견: $SCHEMA"

[ -n "${OLD_DB_URL:-}" ] || fail "OLD_DB_URL 환경변수 미설정"
[ -n "${NEW_DB_URL:-}" ] || fail "NEW_DB_URL 환경변수 미설정"

[ "$OLD_DB_URL" = "$NEW_DB_URL" ] && fail "OLD_DB_URL 과 NEW_DB_URL 이 동일합니다."

ok "도구·환경변수 OK"

step "양쪽 DB 연결 테스트"
OLD_HOST=$(psql "$OLD_DB_URL" -tAc "SELECT inet_server_addr() || ':' || inet_server_port();" 2>&1) \
  || fail "OLD_DB_URL 연결 실패: $OLD_HOST"
ok "OLD: $OLD_HOST"

NEW_HOST=$(psql "$NEW_DB_URL" -tAc "SELECT inet_server_addr() || ':' || inet_server_port();" 2>&1) \
  || fail "NEW_DB_URL 연결 실패: $NEW_HOST"
ok "NEW: $NEW_HOST"

# ── 새 DB 가 비어있는지 확인 ────────────────────────────────────────────────
NEW_TABLE_COUNT=$(psql "$NEW_DB_URL" -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';")
if [ "$NEW_TABLE_COUNT" -gt 0 ]; then
  warn "새 DB 의 public 스키마에 이미 $NEW_TABLE_COUNT 개 테이블이 존재합니다."
  read -r -p "계속 진행하면 schema.sql 의 IF NOT EXISTS 정의는 건너뛰지만 데이터 충돌 가능. 진행? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || fail "사용자 중단"
fi

# ── 1. 새 DB 에 schema 적용 ─────────────────────────────────────────────────
step "1. 새 DB 에 schema 적용"
psql "$NEW_DB_URL" -v ON_ERROR_STOP=1 -f "$SCHEMA" >/dev/null 2>&1 \
  || fail "schema 적용 실패. psql \"\$NEW_DB_URL\" -f \"$SCHEMA\" 으로 직접 확인"
ok "schema 적용 완료"

# ── 2. 기존 DB 데이터 dump ──────────────────────────────────────────────────
step "2. 기존 DB 데이터 dump → $DUMP_FILE"
pg_dump "$OLD_DB_URL" \
  --no-owner --no-privileges --no-acl \
  --schema=public \
  --data-only \
  --disable-triggers \
  --column-inserts \
  --file="$DUMP_FILE" \
  || fail "pg_dump 실패"

DUMP_SIZE=$(ls -la "$DUMP_FILE" | awk '{print $5}')
ok "dump 완료 — $DUMP_FILE ($DUMP_SIZE bytes)"

# ── 3. 새 DB 에 데이터 restore ──────────────────────────────────────────────
step "3. 새 DB 에 데이터 restore"
psql "$NEW_DB_URL" -v ON_ERROR_STOP=1 -f "$DUMP_FILE" >/tmp/restore.log 2>&1
RESTORE_RC=$?
if [ $RESTORE_RC -ne 0 ]; then
  warn "restore 중 오류 발생. /tmp/restore.log 확인."
  tail -20 /tmp/restore.log
  read -r -p "계속 검증 단계로 진행? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || fail "사용자 중단"
fi
ok "restore 완료 (로그: /tmp/restore.log)"

# ── 4. row count 검증 ──────────────────────────────────────────────────────
step "4. 데이터 검증 (OLD vs NEW row count)"
TABLES="divisions users report_jobs crawl_tasks uploaded_files mail_drafts mail_recipient_groups"
ALL_MATCH=true
printf "%-30s %10s %10s %s\n" "Table" "OLD" "NEW" "결과"
printf "%-30s %10s %10s %s\n" "------------------------------" "----------" "----------" "----"
for T in $TABLES; do
  OLD=$(psql "$OLD_DB_URL" -tAc "SELECT COUNT(*) FROM $T" 2>/dev/null || echo "N/A")
  NEW=$(psql "$NEW_DB_URL" -tAc "SELECT COUNT(*) FROM $T" 2>/dev/null || echo "N/A")
  if [ "$OLD" = "$NEW" ]; then
    printf "%-30s %10s %10s ${c_green}✓${c_reset}\n" "$T" "$OLD" "$NEW"
  else
    printf "%-30s %10s %10s ${c_red}✗${c_reset}\n" "$T" "$OLD" "$NEW"
    ALL_MATCH=false
  fi
done

echo ""
if $ALL_MATCH; then
  ok "모든 테이블 row count 일치"
else
  warn "일부 테이블 row count 불일치 — restore 로그(/tmp/restore.log) 확인 필요"
fi

# ── 5. 다음 단계 안내 ──────────────────────────────────────────────────────
step "5. 다음 단계 (수동)"
cat <<EOF

Railway 환경변수 업데이트:
  1. https://railway.app/dashboard → 프로젝트 → 백엔드 서비스 → Variables
  2. DATABASE_URL 값을 다음과 같이 교체 (마지막 \$ 까지가 전체 값):
     \$NEW_DB_URL
  3. Update → 자동 재배포 대기
  4. Deployments → Logs 에서 [DB] Connected 확인

롤백이 필요하면 DATABASE_URL 을 다시 OLD_DB_URL 값으로 교체.

EOF

ok "스크립트 완료"
