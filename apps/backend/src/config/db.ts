import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { logger } from "../utils/logger";

/**
 * MariaDB 커넥션 풀
 *
 * ── 왜 DATETIME 을 UTC 로만 쓰는가 ──────────────────────────────────────────────
 *  MariaDB 에는 PostgreSQL 의 TIMESTAMPTZ 처럼 타임존을 담는 타입이 없다.
 *  그래서 모든 시각 컬럼(DATETIME)에 **UTC 만** 저장하기로 정하고, 두 축을 맞춘다.
 *    1) 드라이버:  timezone "Z"  → JS Date ↔ DATETIME 변환을 UTC 로 고정
 *    2) 서버 세션: SET time_zone='+00:00'
 *       → CURRENT_TIMESTAMP / NOW() 기본값도 UTC 가 된다.
 *  2번이 없으면 기본값은 **서버 로컬 시각**으로 들어간다. 로컬 맥(KST)과
 *  AWS(UTC)에서 값이 9시간 어긋나고, 그 결과 새벽 자동 수집의 날짜 경계가
 *  틀어져 스냅샷이 엉뚱한 날짜로 저장된다 — 조용히 틀리는 종류의 버그다.
 *  KST 날짜가 필요한 곳은 애플리케이션(kstDateString)이 변환한다.
 */
function buildPool(): Pool {
  const url = process.env.DATABASE_URL;

  const common = {
    connectionLimit:  10,
    idleTimeout:      30_000,
    connectTimeout:   5_000,
    timezone:         "Z",       // ↑ 주석 참고
    supportBigNumbers: true,
    // BIGINT(file_size 등)은 안전 범위를 넘을 때만 문자열로 준다.
    bigNumberStrings: false,
    // ssl 은 URL 파라미터(?ssl=...)나 DB_SSL 로 제어한다 (RDS 는 TLS 필수)
    ...(process.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
  };

  if (url) return mysql.createPool({ uri: url, ...common });

  // 로컬 기본값: 유닉스 소켓 + 현재 OS 사용자 (Homebrew MariaDB 기본 구성)
  return mysql.createPool({
    socketPath: process.env.DB_SOCKET ?? "/tmp/mysql.sock",
    user:       process.env.DB_USER   ?? process.env.USER ?? "root",
    database:   process.env.DB_NAME   ?? "skbs_it_report",
    ...common,
  });
}

export const pool: Pool = buildPool();

// 새로 열리는 커넥션마다 세션 타임존을 UTC 로 고정한다.
//   풀이 커넥션을 재사용/재생성하므로 이 이벤트에서 걸어야 빠짐없이 적용된다.
pool.on("connection", (conn) => {
  // 이 이벤트가 넘겨주는 커넥션은 프라미스 래퍼가 아니라 코어 커넥션이다.
  // (그대로 await 하면 "not a promise" 오류가 난다 → promise() 로 감싼다)
  const c = conn as unknown as { promise(): { query(sql: string): Promise<unknown> } };
  c.promise().query("SET time_zone = '+00:00'").catch((e: Error) =>
    logger.error(`[DB] 세션 타임존 설정 실패: ${e.message}`)
  );
});

// ── 플레이스홀더 변환 ─────────────────────────────────────────────────────────

/**
 * PostgreSQL 스타일 `$1` 을 MariaDB 의 `?` 로 바꾸고, 그에 맞게 파라미터를 재배열한다.
 *
 * 왜 호출부를 고치지 않고 여기서 변환하는가:
 *   `$n` 을 쓰는 SQL 문자열이 142개다. 손으로 `?` 로 바꾸면 그 자체로 실수가 나고,
 *   특히 **같은 번호를 두 번 쓰는 7개** 쿼리는 파라미터를 복제해야 해서 위험하다.
 *   `?` 는 위치 기반이라 순서가 곧 의미이므로, 등장 순서대로 파라미터를 다시 깔아준다.
 *
 * 예) "… WHERE a=$2 OR b=$1 OR c=$2", [x, y] → "… WHERE a=? OR b=? OR c=?", [y, x, y]
 *
 * 문자열 리터럴 안의 `$1` 은 건드리면 안 되므로 따옴표 구간을 건너뛴다.
 */
export function toMariaPlaceholders(
  sql: string, params: unknown[] = []
): { sql: string; params: unknown[] } {
  if (!params.length && !/\$\d/.test(sql)) return { sql, params };

  const out: string[] = [];
  const newParams: unknown[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // 따옴표/백틱 구간은 그대로 통과 (내부의 $1 을 치환하지 않기 위해)
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out.push(ch); i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && quote !== "`") { out.push(sql[i], sql[i + 1] ?? ""); i += 2; continue; }
        out.push(sql[i]);
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === "$" && /\d/.test(sql[i + 1] ?? "")) {
      let j = i + 1;
      while (j < sql.length && /\d/.test(sql[j])) j++;
      const idx = Number(sql.slice(i + 1, j));           // $1 → 1
      newParams.push(params[idx - 1]);
      out.push("?");
      i = j;
      continue;
    }

    out.push(ch); i++;
  }

  return { sql: out.join(""), params: newParams };
}

// ── 쿼리 헬퍼 (PostgreSQL 판과 동일한 시그니처) ────────────────────────────────

/**
 * 결과 행 제약. `pg` 의 QueryResultRow 와 같은 형태로 둔다.
 *   값 타입을 unknown 으로 좁히면 호출부의 기존 인터페이스(JobRow, UserRow 등)가
 *   인덱스 시그니처를 갖지 않아 전부 타입 오류가 난다.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface QueryRow { [column: string]: any }
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 단순 SELECT 쿼리 헬퍼 */
export async function query<T extends QueryRow = QueryRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const q = toMariaPlaceholders(text, params);
  const [rows] = await pool.query<RowDataPacket[]>(q.sql, q.params);
  return rows as unknown as T[];
}

/** 트랜잭션 헬퍼 */
export async function withTransaction<T>(
  fn: (client: TxClient) => Promise<T>
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(wrapConn(conn));
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 트랜잭션 안에서 쓰는 클라이언트.
 * `pg` 의 PoolClient 처럼 `client.query(sql, params)` 로 호출할 수 있게 맞춘다.
 */
export interface TxClient {
  query<T extends QueryRow = QueryRow>(
    text: string, params?: unknown[]
  ): Promise<{ rows: T[] }>;
}

function wrapConn(conn: PoolConnection): TxClient {
  return {
    async query<T extends QueryRow = QueryRow>(
      text: string, params?: unknown[]
    ): Promise<{ rows: T[] }> {
      const q = toMariaPlaceholders(text, params);
      const [rows] = await conn.query<RowDataPacket[]>(q.sql, q.params);
      return { rows: rows as unknown as T[] };
    },
  };
}

/** 서버 시작 시 연결 확인 */
export async function testConnection(): Promise<void> {
  const rows = await query<{ now: Date; tz: string; ver: string }>(
    "SELECT NOW() AS `now`, @@session.time_zone AS tz, VERSION() AS ver"
  );
  logger.info("[DB] Connected", {
    serverTime: rows[0]?.now,
    sessionTz:  rows[0]?.tz,     // '+00:00' 이어야 한다
    version:    rows[0]?.ver,
  });
}

/**
 * 스키마 변경분을 기존 DB에 안전하게 적용합니다.
 * MariaDB 는 `IF NOT EXISTS` 를 CREATE INDEX / ADD COLUMN 에도 지원하므로
 * 재실행해도 안전합니다. (PostgreSQL 판의 DO $$ … $$ 블록은 PL/pgSQL 이라
 * 대응 문법이 없어, 필요한 것만 평문 DDL 로 옮겼습니다)
 */
export async function runMigrations(): Promise<void> {
  const migrations: { name: string; sql: string }[] = [
    {
      name: "uploaded_files.file_size",
      sql:  "ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS file_size BIGINT NOT NULL DEFAULT 0",
    },
    {
      name: "users.updated_at",
      sql:  "ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at DATETIME NOT NULL " +
            "DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
    },
    {
      // L HOUSE 는 공장의 공식 이름이므로 '로컬하우스' 로 음역되어 시드된 과거 값을 교정.
      name: "divisions.name_official.BIO",
      sql:  "UPDATE divisions SET name = 'Bio연구본부'   WHERE code = 'BIO'    AND name <> 'Bio연구본부'",
    },
    {
      name: "divisions.name_official.DEV",
      sql:  "UPDATE divisions SET name = '개발본부'      WHERE code = 'DEV'    AND name <> '개발본부'",
    },
    {
      name: "divisions.name_official.LHOUSE",
      sql:  "UPDATE divisions SET name = 'L HOUSE 공장'  WHERE code = 'LHOUSE' AND name <> 'L HOUSE 공장'",
    },
  ];

  for (const m of migrations) {
    try {
      await pool.query(m.sql);
      logger.info(`[DB Migration] OK: ${m.name}`);
    } catch (err) {
      logger.warn(`[DB Migration] SKIP (${m.name}): ${(err as Error).message}`);
    }
  }
}
