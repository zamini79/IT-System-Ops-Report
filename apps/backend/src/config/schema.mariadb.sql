-- =============================================================================
-- SKBS IT Report — MariaDB Schema
--
-- 실행 방법:
--   mariadb -e "CREATE DATABASE IF NOT EXISTS skbs_it_report
--               CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
--   mariadb skbs_it_report < schema.mariadb.sql
--
-- ── PostgreSQL 판(schema.sql)과의 차이 및 그 이유 ────────────────────────────
--  UUID          : UUID 전용 타입(10.7+) 대신 CHAR(36) 사용. AWS RDS 의 MariaDB
--                  버전 편차에 영향받지 않고, 드라이버가 문자열로 주고받아
--                  애플리케이션 코드가 그대로 동작한다.
--  ENUM          : CREATE TYPE 이 없으므로 컬럼에 인라인 선언.
--  TIMESTAMPTZ   : MariaDB 에는 타임존을 담는 타입이 없다. DATETIME 에 **UTC 로만**
--                  저장하고, 커넥션마다 `SET time_zone='+00:00'` 을 걸어
--                  CURRENT_TIMESTAMP 도 UTC 가 되게 한다(config/db.ts).
--                  KST 변환은 애플리케이션(kstDateString)이 담당한다.
--                  TIMESTAMP 대신 DATETIME 을 쓴 이유는 2038 년 상한을 피하기 위함.
--  updated_at    : plpgsql 트리거 4개를 없애고 ON UPDATE CURRENT_TIMESTAMP 로 대체.
--  TEXT[]        : 배열 타입이 없으므로 JSON 배열로 저장.
--  GIN 인덱스     : 대응 기능이 없다. 해당 두 컬럼(system_configs, analysis_result)은
--                  내용으로 검색하지 않고 문서를 통째로 읽기만 하므로 인덱스를 뺀다.
--  JSONB         : JSON. (드라이버가 객체로 파싱해 주는 점은 pg 와 동일)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- divisions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS divisions (
    id             CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    code           ENUM('BIO','DEV','LHOUSE') NOT NULL UNIQUE,
    name           VARCHAR(100) NOT NULL,
    -- {"systems": [{"name": "ERP", "url": "https://...", "auth": {...}}]}
    system_configs JSON         NOT NULL DEFAULT '{}'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT         NOT NULL,
    name          VARCHAR(100) NOT NULL,
    division_id   CHAR(36)     NULL,
    role          ENUM('admin','manager','viewer') NOT NULL DEFAULT 'viewer',
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_users_division FOREIGN KEY (division_id)
        REFERENCES divisions(id) ON DELETE SET NULL,
    INDEX idx_users_division (division_id),
    INDEX idx_users_role     (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- report_jobs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_jobs (
    id            CHAR(36)    NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    division_id   CHAR(36)    NOT NULL,
    status        ENUM('PENDING','RUNNING','COMPLETED','FAILED') NOT NULL DEFAULT 'PENDING',
    started_at    DATETIME    NULL,
    completed_at  DATETIME    NULL,
    pdf_path      TEXT        NULL,
    error_message TEXT        NULL,
    created_by    CHAR(36)    NOT NULL,
    created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_report_jobs_division FOREIGN KEY (division_id)
        REFERENCES divisions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_report_jobs_created_by FOREIGN KEY (created_by)
        REFERENCES users(id) ON DELETE RESTRICT,

    -- COMPLETED/FAILED 일 때 completed_at 필수
    CONSTRAINT chk_completed_at  CHECK (status NOT IN ('COMPLETED','FAILED') OR completed_at  IS NOT NULL),
    -- COMPLETED 일 때 pdf_path 필수
    CONSTRAINT chk_pdf_path      CHECK (status <> 'COMPLETED'                OR pdf_path      IS NOT NULL),
    -- FAILED 일 때 error_message 필수
    CONSTRAINT chk_error_message CHECK (status <> 'FAILED'                   OR error_message IS NOT NULL),

    INDEX idx_report_jobs_division   (division_id),
    INDEX idx_report_jobs_status     (status),
    INDEX idx_report_jobs_created_by (created_by),
    INDEX idx_report_jobs_created_at (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- crawl_tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crawl_tasks (
    id            CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    report_job_id CHAR(36)     NOT NULL,
    system_name   VARCHAR(100) NOT NULL,
    task_type     ENUM('DOWNLOAD','SCREENSHOT','UPLOAD_ANALYSIS') NOT NULL,
    -- crawl_tasks 의 status 는 report_jobs.status 와 같은 값 집합을 쓴다
    status        ENUM('PENDING','RUNNING','COMPLETED','FAILED') NOT NULL DEFAULT 'PENDING',
    result_path   TEXT         NULL,
    error         TEXT         NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_crawl_tasks_job FOREIGN KEY (report_job_id)
        REFERENCES report_jobs(id) ON DELETE CASCADE,
    -- 동일 job 내 동일 시스템 중복 방지 (upsert 기준 키)
    CONSTRAINT uq_crawl_task_job_system UNIQUE (report_job_id, system_name),

    INDEX idx_crawl_tasks_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- uploaded_files
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uploaded_files (
    id              CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    report_job_id   CHAR(36)     NOT NULL,
    original_name   VARCHAR(255) NOT NULL,
    stored_path     TEXT         NOT NULL,
    file_type       VARCHAR(100) NOT NULL,           -- MIME type
    file_size       BIGINT       NOT NULL DEFAULT 0, -- bytes
    analysis_result JSON         NOT NULL DEFAULT '{}',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_uploaded_files_job FOREIGN KEY (report_job_id)
        REFERENCES report_jobs(id) ON DELETE CASCADE,
    INDEX idx_uploaded_files_job (report_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- mail_drafts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_drafts (
    id            CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    report_job_id CHAR(36)     NOT NULL,
    recipients    JSON         NOT NULL DEFAULT '[]',   -- TO  (구 TEXT[])
    cc            JSON         NOT NULL DEFAULT '[]',   -- CC  (구 TEXT[])
    subject       VARCHAR(500) NOT NULL DEFAULT '',
    body_html     TEXT         NOT NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_mail_drafts_job FOREIGN KEY (report_job_id)
        REFERENCES report_jobs(id) ON DELETE CASCADE,
    INDEX idx_mail_drafts_job (report_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- mail_recipient_groups
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_recipient_groups (
    id            CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    division_code VARCHAR(20)  NOT NULL,
    name          VARCHAR(200) NOT NULL,
    emails        JSON         NOT NULL DEFAULT '[]',
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_mail_groups_division (division_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- saved_reports  (월별 보고서 보관소)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_reports (
    id            CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    division_code ENUM('BIO','DEV','LHOUSE') NOT NULL,
    report_type   VARCHAR(50)  NOT NULL,
    year          INT          NOT NULL,
    month         INT          NOT NULL,
    source_job_id CHAR(36)     NULL,
    filename      VARCHAR(255) NOT NULL,
    stored_path   TEXT         NOT NULL,
    file_size     BIGINT       NOT NULL,
    saved_by      CHAR(36)     NULL,
    saved_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_saved_reports_year  CHECK (year  >= 2000 AND year <= 3000),
    CONSTRAINT chk_saved_reports_month CHECK (month >= 1    AND month <= 12),
    CONSTRAINT fk_saved_reports_job FOREIGN KEY (source_job_id)
        REFERENCES report_jobs(id) ON DELETE SET NULL,
    CONSTRAINT fk_saved_reports_user FOREIGN KEY (saved_by)
        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT uq_saved_reports_div_type_ym UNIQUE (division_code, report_type, year, month),

    INDEX idx_saved_reports_ym  (year DESC, month DESC),
    INDEX idx_saved_reports_div (division_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- dashboard_snapshots  (본부 × 날짜 지표 스냅샷 1건)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_snapshots (
    id            CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    division_code ENUM('BIO','DEV','LHOUSE') NOT NULL,
    captured_date DATE         NOT NULL,
    data          JSON         NOT NULL,
    sources       JSON         NOT NULL DEFAULT '{}',
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT uq_dashboard_snap_div_date UNIQUE (division_code, captured_date),
    INDEX idx_dashboard_snap_div_date (division_code, captured_date DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- collection_runs  (자동/수동 수집 실행 이력)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_runs (
    id            CHAR(36)    NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    division_code ENUM('BIO','DEV','LHOUSE') NOT NULL,
    `trigger`     VARCHAR(20) NOT NULL,   -- MariaDB 예약어이므로 항상 백틱으로 인용한다
    status        VARCHAR(20) NOT NULL,
    started_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at   DATETIME    NULL,
    detail        JSON        NOT NULL DEFAULT '{}',

    INDEX idx_collection_runs_div_started (division_code, started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================================
-- 초기 데이터
-- =============================================================================

INSERT IGNORE INTO divisions (id, code, name, system_configs) VALUES
('a1000000-0000-0000-0000-000000000001', 'BIO', 'Bio연구본부',
 '{"systems":[{"name":"ERP","url":"https://erp.bio.internal","auth":{"type":"basic","username_env":"BIO_ERP_USER","password_env":"BIO_ERP_PASS"}},{"name":"MES","url":"https://mes.bio.internal","auth":{"type":"session","login_url":"/login"}}]}'),
('a2000000-0000-0000-0000-000000000002', 'DEV', '개발본부',
 '{"systems":[{"name":"GitLab","url":"https://gitlab.dev.internal","auth":{"type":"token","token_env":"DEV_GITLAB_TOKEN"}},{"name":"Jira","url":"https://jira.dev.internal","auth":{"type":"basic","username_env":"DEV_JIRA_USER","password_env":"DEV_JIRA_PASS"}}]}'),
('a3000000-0000-0000-0000-000000000003', 'LHOUSE', 'L HOUSE 공장',
 '{"systems":[{"name":"PMS","url":"https://pms.lhouse.internal","auth":{"type":"basic","username_env":"LHOUSE_PMS_USER","password_env":"LHOUSE_PMS_PASS"}}]}');

-- admin 계정 — 초기 비밀번호: Admin1234!  (최초 로그인 후 변경할 것)
INSERT IGNORE INTO users (id, email, password_hash, name, division_id, role) VALUES
('b0000000-0000-0000-0000-000000000001', 'admin@skbs.internal',
 '$2b$12$DFTTCAzsVill6ZbBryI/nOUt401cBKbfowbc6n2EbaAx8kZXIhXNK',
 '시스템 관리자', NULL, 'admin');
