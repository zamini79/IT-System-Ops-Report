import { Pool, PoolClient, QueryResultRow } from "pg";
import { logger } from "../utils/logger";

// DATABASE_URL=postgresql://localhost/skbs_it_report  (Homebrew 로컬 소켓)
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://localhost/skbs_it_report",
  // 커넥션 풀 설정
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err: Error) => {
  logger.error("[DB] Unexpected idle-client error", { message: err.message });
});

/** 단순 SELECT 쿼리 헬퍼 */
export async function query<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const { rows } = await pool.query<T>(text, params);
  return rows;
}

/** 트랜잭션 헬퍼 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** 서버 시작 시 연결 확인 */
export async function testConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ now: Date }>("SELECT NOW() AS now");
    logger.info("[DB] Connected", { serverTime: rows[0].now });
  } finally {
    client.release();
  }
}

/**
 * 스키마 변경분을 기존 DB에 안전하게 적용합니다.
 * ADD COLUMN IF NOT EXISTS 등 멱등 구문만 사용하므로 재실행해도 안전합니다.
 */
export async function runMigrations(): Promise<void> {
  const migrations: { name: string; sql: string }[] = [
    {
      name: "uploaded_files.file_size",
      sql:  "ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS file_size BIGINT NOT NULL DEFAULT 0",
    },
    {
      name: "users.updated_at",
      sql:  "ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
    },
    {
      name: "crawl_tasks.uq_job_system",
      sql:  `DO $$
             BEGIN
               IF NOT EXISTS (
                 SELECT 1 FROM pg_constraint
                 WHERE conname = 'uq_crawl_task_job_system'
                   AND conrelid = 'crawl_tasks'::regclass
               ) THEN
                 ALTER TABLE crawl_tasks
                   ADD CONSTRAINT uq_crawl_task_job_system
                   UNIQUE (report_job_id, system_name);
               END IF;
             END $$;`,
    },
    {
      // L HOUSE 는 공장의 공식 이름이므로 '로컬하우스' 로 음역되어 시드된 과거 값을 교정.
      // BIO/DEV 도 schema.sql 의 표준 명칭과 일치시킴.
      name: "divisions.name_official",
      sql:  `UPDATE divisions SET name = 'Bio연구본부'   WHERE code = 'BIO'    AND name <> 'Bio연구본부';
             UPDATE divisions SET name = '개발본부'     WHERE code = 'DEV'    AND name <> '개발본부';
             UPDATE divisions SET name = 'L HOUSE 공장' WHERE code = 'LHOUSE' AND name <> 'L HOUSE 공장';`,
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
