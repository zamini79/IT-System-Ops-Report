# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**skbs-it-report** — IT 운영 보고서 관리 시스템 모노레포.

| Layer | Location | Stack |
|---|---|---|
| Frontend | `apps/frontend` | React 18 + TypeScript + Vite + TailwindCSS |
| Backend | `apps/backend` | Node.js + Express + TypeScript |
| Shared types | `packages/shared` | TypeScript only (no runtime deps) |

## Commands

```bash
# 루트에서 프론트+백 동시 실행
npm run dev

# 개별 실행
npm run dev --workspace=apps/backend
npm run dev --workspace=apps/frontend

# 빌드 (shared → backend → frontend 순서)
npm run build

# 패키지 설치 (루트에서)
npm install
```

## Architecture

### Workspace 구성
npm workspaces 기반. 루트 `package.json`이 `apps/*`, `packages/*`를 워크스페이스로 선언하고 `concurrently`로 두 앱을 동시에 실행한다.

### Shared 타입 패키지
`packages/shared/src/index.ts`에 `User`, `Report`, `Attachment`, `ApiResponse<T>` 등 공통 인터페이스를 정의. 프론트/백 양쪽에서 `@skbs/shared`로 임포트한다. TypeScript `paths` alias로 빌드 없이 소스에서 직접 참조한다(`dist/` 산출물 불필요).

### Backend 구조
```
src/
├── index.ts          # Express 앱 진입점, 미들웨어 조합
├── config/
│   ├── db.ts         # pg Pool + query() 헬퍼
│   └── schema.sql    # DB 초기화 스크립트
├── middleware/
│   └── auth.ts       # JWT authenticate / authorize 미들웨어
├── routes/
│   ├── index.ts      # /api 라우터 집합
│   ├── auth.ts       # POST /auth/login, /auth/register
│   └── reports.ts    # CRUD + 파일 첨부 (multer)
└── utils/
    └── logger.ts     # winston 로거
```

모든 라우트는 `authenticate` 미들웨어를 거친다. 파일 업로드는 `multer` diskStorage — 저장 경로는 `UPLOAD_DIR` env. `/uploads` 정적 서빙은 `index.ts`에서 직접 처리.

### Frontend 구조
```
src/
├── api/client.ts     # axios 인스턴스 (JWT 인터셉터, 401 리다이렉트)
├── hooks/useAuth.ts  # 로그인/로그아웃/getUser (localStorage 기반)
├── components/       # PrivateRoute 등 공용 컴포넌트
└── pages/            # LoginPage, DashboardPage, ReportsPage, ReportDetailPage
```

인증 상태는 `localStorage`의 `token` / `user` 키로 관리. `PrivateRoute`가 토큰 존재 여부로 가드. Vite dev 서버는 `/api`, `/uploads`를 `localhost:4000`으로 프록시(`vite.config.ts`).

## Environment

`.env.example`을 복사해 `.env` 생성:
```bash
cp .env.example .env
```

백엔드는 `dotenv/config`를 `src/index.ts` 최상단에서 로드. 프론트는 Vite의 `VITE_` 접두어 env 사용(`VITE_API_BASE_URL`).

## Database

MariaDB 연결은 `apps/backend/src/config/db.ts`의 `pool` (드라이버 `mysql2/promise`). 스키마 초기화:
```bash
mariadb -e "CREATE DATABASE skbs_it_report CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mariadb skbs_it_report < apps/backend/src/config/schema.mariadb.sql
```

**시각 처리 규칙** — MariaDB 에는 `TIMESTAMPTZ` 가 없다. 모든 DATETIME 컬럼에 **UTC 만**
저장하고, 커넥션마다 `SET time_zone='+00:00'` 을 걸어 `NOW()`/기본값도 UTC 가 되게 한다
(`config/db.ts`). KST 변환은 애플리케이션(`kstDateString`)이 담당한다. 이 규칙을 어기면
새벽 자동 수집의 날짜 경계가 어긋나 스냅샷이 엉뚱한 날짜로 저장된다.

**쿼리 작성** — SQL 은 `$1` 스타일 플레이스홀더를 그대로 쓴다. `query()` 헬퍼가
`?` 로 바꾸고 파라미터를 재배열한다(`toMariaPlaceholders`). MariaDB 는
`UPDATE … RETURNING` 을 지원하지 않으므로 UPDATE 후 SELECT 로 나눈다.
`trigger` 는 예약어이므로 SQL 안에서 백틱으로 인용한다.

구 PostgreSQL 스키마는 `config/schema.sql` 에 이관 참고용으로 남겨 두었다.
Postgres → MariaDB 데이터 이관은 `src/scripts/migrate-pg-to-mariadb.ts`.

Docker로 DB만 띄울 경우:
```bash
docker compose up db -d
```

## Docker

전체 스택 컨테이너 실행:
```bash
docker compose up --build
```
프론트는 nginx(포트 3000), 백엔드는 4000, DB는 3306.
