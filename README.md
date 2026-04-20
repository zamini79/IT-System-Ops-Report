# SKBS IT 운영 보고서 관리 시스템

| 레이어 | 위치 | 스택 |
|---|---|---|
| Frontend | `apps/frontend` | React 18 + TypeScript + Vite + TailwindCSS |
| Backend | `apps/backend` | Node.js + Express + TypeScript |
| 공유 타입 | `packages/shared` | TypeScript only |

---

## 로컬 개발 (Mac 네이티브)

> **전제:** Homebrew PostgreSQL, Node.js 20+, npm 10+

### 1. 의존성 설치

```bash
npm install
```

### 2. 데이터베이스 초기화 (최초 1회)

```bash
createdb skbs_it_report
psql -d skbs_it_report -f apps/backend/src/config/schema.sql
```

### 3. 환경 변수 설정

```bash
cp .env.prod.example .env
# .env 파일을 편집하여 DB_HOST=localhost 등 로컬 값으로 수정
```

### 4. 개발 서버 실행

```bash
npm run dev          # 백엔드(4000) + 프론트엔드(5173) 동시 실행
```

Vite dev 서버는 `/api`, `/uploads` 요청을 `localhost:4000`으로 자동 프록시합니다.

초기 관리자 계정: `admin@skbs.internal` / `Admin1234!`

---

## 운영 서버 배포 (Docker Compose)

### 사전 요구사항

- Docker Engine 24+
- Docker Compose v2

### 1. 환경 변수 파일 준비

```bash
cp .env.prod.example .env.prod
```

`.env.prod`를 열어 아래 항목을 반드시 교체하세요.

| 변수 | 설명 |
|---|---|
| `DB_PASSWORD` | PostgreSQL 비밀번호 (강력한 무작위 문자열) |
| `JWT_SECRET` | JWT 서명 키 (`openssl rand -hex 64` 권장) |
| `BIO_*`, `DEV_*`, `LHOUSE_*` | 각 사업부 외부 시스템 계정 |

### 2. 빌드 및 실행

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

| 서비스 | 외부 포트 | 설명 |
|---|---|---|
| frontend | 80 | Nginx — React 앱 + API 프록시 |
| backend | 3000 | Node.js API 서버 (직접 접근) |
| db | — | 내부 네트워크 전용 (외부 노출 없음) |

브라우저에서 `http://서버IP` 로 접속합니다.

### 3. DB 스키마 초기화

DB 볼륨이 비어 있으면 컨테이너 최초 기동 시 `schema.sql`이 자동 실행됩니다.
이미 데이터가 있는 경우에는 실행되지 않습니다.

수동으로 재실행하려면:

```bash
docker compose -f docker-compose.prod.yml exec db \
  psql -U $DB_USER -d $DB_NAME -f /docker-entrypoint-initdb.d/01_schema.sql
```

### 4. 로그 확인

```bash
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f frontend
```

### 5. 업데이트 배포

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

이미지만 재빌드하고 싶을 때:

```bash
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
```

### 6. 볼륨 (데이터 영속성)

| 볼륨 이름 | 경로 | 내용 |
|---|---|---|
| `skbs_pgdata` | `/var/lib/postgresql/data` | PostgreSQL 데이터 |
| `skbs_uploads` | `/app/uploads` | 업로드 파일 / 크롤링 결과 |
| `skbs_outputs` | `/app/outputs` | 생성된 PDF 보고서 |

볼륨 데이터는 컨테이너를 삭제해도 유지됩니다.
완전 초기화가 필요한 경우:

```bash
docker compose -f docker-compose.prod.yml down -v   # ⚠️ 데이터 삭제
```

---

## 파일 구조

```
.
├── apps/
│   ├── backend/
│   │   ├── Dockerfile.prod        # 운영 빌드 (context: 루트)
│   │   └── src/config/schema.sql  # DB 초기화 스크립트
│   └── frontend/
│       ├── Dockerfile.prod        # 운영 빌드 (context: 루트)
│       ├── nginx.prod.conf        # 운영 Nginx 설정
│       └── nginx.conf             # 로컬 Docker용 Nginx 설정
├── packages/shared/               # 공유 TypeScript 타입
├── docker-compose.yml             # 로컬 Docker 실행용 (레거시)
├── docker-compose.prod.yml        # 운영 서버 배포용
├── .dockerignore
├── .env.prod.example              # 환경 변수 템플릿
└── CLAUDE.md
```
