-- =============================================================================
-- SKBS IT Report — PostgreSQL Schema
-- macOS Homebrew PostgreSQL (>= 13) 기준
--
-- 실행 방법:
--   createdb skbs_it_report
--   psql -d skbs_it_report -f schema.sql
--
-- gen_random_uuid() 는 PostgreSQL 13부터 확장 없이 내장 제공됩니다.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- ENUM Types
-- ---------------------------------------------------------------------------

DO $$ BEGIN
    CREATE TYPE division_code AS ENUM ('BIO', 'DEV', 'LHOUSE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE job_status AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE task_type AS ENUM ('DOWNLOAD', 'SCREENSHOT', 'UPLOAD_ANALYSIS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('admin', 'manager', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ---------------------------------------------------------------------------
-- divisions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS divisions (
    id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    code           division_code NOT NULL UNIQUE,
    name           VARCHAR(100)  NOT NULL,
    -- 시스템 접속 정보 예시:
    -- {"systems": [{"name": "ERP", "url": "https://...", "auth": {"type": "basic", ...}}]}
    system_configs JSONB         NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_divisions_configs ON divisions USING GIN (system_configs);


-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT         NOT NULL,
    name          VARCHAR(100) NOT NULL,
    division_id   UUID         REFERENCES divisions(id) ON DELETE SET NULL,
    role          user_role    NOT NULL DEFAULT 'viewer',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_division ON users(division_id);
CREATE INDEX IF NOT EXISTS idx_users_role     ON users(role);


-- ---------------------------------------------------------------------------
-- report_jobs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_jobs (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    division_id   UUID        NOT NULL REFERENCES divisions(id) ON DELETE RESTRICT,
    status        job_status  NOT NULL DEFAULT 'PENDING',
    started_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    pdf_path      TEXT,
    error_message TEXT,
    created_by    UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- COMPLETED/FAILED 일 때 completed_at 필수
    CONSTRAINT chk_completed_at   CHECK (status NOT IN ('COMPLETED','FAILED') OR completed_at  IS NOT NULL),
    -- COMPLETED 일 때 pdf_path 필수
    CONSTRAINT chk_pdf_path       CHECK (status <> 'COMPLETED'               OR pdf_path       IS NOT NULL),
    -- FAILED 일 때 error_message 필수
    CONSTRAINT chk_error_message  CHECK (status <> 'FAILED'                  OR error_message  IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_report_jobs_division   ON report_jobs(division_id);
CREATE INDEX IF NOT EXISTS idx_report_jobs_status     ON report_jobs(status);
CREATE INDEX IF NOT EXISTS idx_report_jobs_created_by ON report_jobs(created_by);
CREATE INDEX IF NOT EXISTS idx_report_jobs_created_at ON report_jobs(created_at DESC);


-- ---------------------------------------------------------------------------
-- crawl_tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crawl_tasks (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    report_job_id UUID        NOT NULL REFERENCES report_jobs(id) ON DELETE CASCADE,
    system_name   VARCHAR(100) NOT NULL,
    task_type     task_type   NOT NULL,
    -- crawl_tasks 의 status 는 job_status 값 집합과 동일하게 사용
    status        job_status  NOT NULL DEFAULT 'PENDING',
    result_path   TEXT,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 동일 job 내 동일 시스템 중복 실행 방지 (ON CONFLICT 기준)
    CONSTRAINT uq_crawl_task_job_system UNIQUE (report_job_id, system_name)
);

CREATE INDEX IF NOT EXISTS idx_crawl_tasks_job    ON crawl_tasks(report_job_id);
CREATE INDEX IF NOT EXISTS idx_crawl_tasks_status ON crawl_tasks(status);


-- ---------------------------------------------------------------------------
-- uploaded_files
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uploaded_files (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    report_job_id   UUID         NOT NULL REFERENCES report_jobs(id) ON DELETE CASCADE,
    original_name   VARCHAR(255) NOT NULL,
    stored_path     TEXT         NOT NULL,
    file_type       VARCHAR(100) NOT NULL,          -- MIME type (예: application/pdf)
    file_size       BIGINT       NOT NULL DEFAULT 0, -- bytes
    -- 분석 결과 예시: {"parsed": {...}, "summary": "...", "flags": [...]}
    analysis_result JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_job      ON uploaded_files(report_job_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_analysis ON uploaded_files USING GIN (analysis_result);

-- 기존 DB에 file_size 컬럼이 없는 경우를 위한 안전 마이그레이션
ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS file_size BIGINT NOT NULL DEFAULT 0;


-- ---------------------------------------------------------------------------
-- mail_drafts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_drafts (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    report_job_id UUID         NOT NULL REFERENCES report_jobs(id) ON DELETE CASCADE,
    recipients    TEXT[]       NOT NULL DEFAULT '{}',   -- TO
    cc            TEXT[]       NOT NULL DEFAULT '{}',   -- CC
    subject       VARCHAR(500) NOT NULL DEFAULT '',
    body_html     TEXT         NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_drafts_job ON mail_drafts(report_job_id);


-- ---------------------------------------------------------------------------
-- mail_recipient_groups
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_recipient_groups (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    division_code VARCHAR(20)  NOT NULL,
    name          VARCHAR(200) NOT NULL,
    emails        JSONB        NOT NULL DEFAULT '[]',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_groups_division ON mail_recipient_groups(division_code);


-- ---------------------------------------------------------------------------
-- updated_at 자동 갱신 트리거
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    CREATE TRIGGER trg_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_report_jobs_updated_at
        BEFORE UPDATE ON report_jobs
        FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_crawl_tasks_updated_at
        BEFORE UPDATE ON crawl_tasks
        FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_mail_drafts_updated_at
        BEFORE UPDATE ON mail_drafts
        FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =============================================================================
-- 초기 데이터
-- =============================================================================

-- ---------------------------------------------------------------------------
-- divisions  (BIO / DEV / LHOUSE)
-- ---------------------------------------------------------------------------
INSERT INTO divisions (id, code, name, system_configs) VALUES
(
    'a1000000-0000-0000-0000-000000000001',
    'BIO',
    'Bio연구본부',
    '{
        "systems": [
            {
                "name": "ERP",
                "url": "https://erp.bio.internal",
                "auth": { "type": "basic", "username_env": "BIO_ERP_USER", "password_env": "BIO_ERP_PASS" }
            },
            {
                "name": "MES",
                "url": "https://mes.bio.internal",
                "auth": { "type": "session", "login_url": "/login" }
            }
        ]
    }'::jsonb
),
(
    'a2000000-0000-0000-0000-000000000002',
    'DEV',
    '개발본부',
    '{
        "systems": [
            {
                "name": "GitLab",
                "url": "https://gitlab.dev.internal",
                "auth": { "type": "token", "token_env": "DEV_GITLAB_TOKEN" }
            },
            {
                "name": "Jira",
                "url": "https://jira.dev.internal",
                "auth": { "type": "basic", "username_env": "DEV_JIRA_USER", "password_env": "DEV_JIRA_PASS" }
            }
        ]
    }'::jsonb
),
(
    'a3000000-0000-0000-0000-000000000003',
    'LHOUSE',
    'L HOUSE 공장',
    '{
        "systems": [
            {
                "name": "PMS",
                "url": "https://pms.lhouse.internal",
                "auth": { "type": "basic", "username_env": "LHOUSE_PMS_USER", "password_env": "LHOUSE_PMS_PASS" }
            }
        ]
    }'::jsonb
)
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------------------------
-- admin 계정
-- 초기 비밀번호: Admin1234!  (bcrypt $2b$12)
-- ⚠️  최초 로그인 후 반드시 비밀번호를 변경하세요.
-- ---------------------------------------------------------------------------
INSERT INTO users (id, email, password_hash, name, division_id, role) VALUES
(
    'b0000000-0000-0000-0000-000000000001',
    'admin@skbs.internal',
    '$2b$12$DFTTCAzsVill6ZbBryI/nOUt401cBKbfowbc6n2EbaAx8kZXIhXNK',  -- Admin1234!
    '시스템 관리자',
    NULL,
    'admin'
)
ON CONFLICT (email) DO NOTHING;
