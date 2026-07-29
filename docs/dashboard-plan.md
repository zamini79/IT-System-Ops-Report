# 운영 현황 대시보드 전환 계획

> PDF 리포트 생성 중심 → **본부별 운영 현황 대시보드** 중심으로 전환.
> 결정 사항: PDF 유지 · 일별 추이 누적 · 프론트 인터랙티브 차트 · 개발본부 파일럿 우선.

## 목표

- 본부별 운영 현황 대시보드 제공 (담당자가 필요할 때 접속해 확인)
- 대시보드 내용 = 기존 PDF 리포트 내용
- **매일 새벽 1회 자동 수집** (현재는 버튼 수동 실행)
- 수동 업로드 항목은 그대로 유지, 업로드 시 대시보드 즉시 반영 (동일 계산 기준)
- 기존 PDF 생성·History 저장 기능은 계속 유지

## 현재 구조 (파악 결과)

| 항목 | 현황 |
|---|---|
| 파일 저장 | `UPLOAD_DIR/{jobId}/uploads/` — jobId는 프론트 localStorage 기반 |
| 리포트 생성 | 엑셀 파싱 → 지표 계산 → Playwright로 차트 PNG 렌더 → HTML에 base64 삽입 → PDF |
| 수집 | 크롤러(Playwright). URL의 `BETWEEN` 날짜는 `buildReportUrl()`이 **직전 3개월로 자동 치환** |
| 계정 | 크롤러 계정은 env 기반 → **무인 실행 가능** |
| 인증 | `users.role`(admin) + `division_id`, `divisionGuard` 존재 |
| 차트 라이브러리 | 백엔드 chart.js(PNG 렌더용). **프론트에는 없음** |
| 스케줄러 | 없음 |

### 해결해야 할 구조적 문제

업로드 파일이 `{jobId}` 폴더에 묶여 있어, 매일 자동 수집이 새 job을 만들면 **업로드해둔 파일이 분리**된다.
→ 본부별 **고정 작업공간**으로 전환하고, 자동 수집은 그 안의 *수집 파일만* 덮어쓴다(업로드 파일 보존).

## 목표 구조

### 1. 저장소

**본부별 고정 작업공간 — 고정 jobId 방식 (구현됨)**

기존 코드가 업로드·수집·PDF 생성 전부 `jobId`(UUID) 기준으로 동작하고 업로드 경로가
UUID 검증까지 하므로, 경로 구조를 바꾸는 대신 **본부별 고정 UUID**를 쓴다.
목적(업로드 + 자동 수집이 한 곳에 모임)은 동일하게 달성하면서 변경 범위가 최소다.

```
UPLOAD_DIR/{고정 jobId}/uploads/
  DEV    = 00000000-0000-4000-8000-000000000001
  LHOUSE = 00000000-0000-4000-8000-000000000002
  BIO    = 00000000-0000-4000-8000-000000000003
```
- 정의 위치: `apps/backend/src/modules/dashboard/dashboard.types.ts` (프론트용 동일 정의는 `packages/shared`)
- 자동 수집은 수집 대상 파일만 덮어씀 → 업로드 파일 유지
- 기존 PDF 생성 로직은 jobId 만 이 값으로 넘기면 그대로 재사용됨

**신규 테이블**
```sql
-- 일별 대시보드 스냅샷 (본부 × 날짜 1건)
CREATE TABLE dashboard_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  division_code  VARCHAR(20)  NOT NULL,
  captured_date  DATE         NOT NULL,
  data           JSONB        NOT NULL,   -- 지표 JSON (차트 시리즈·KPI·인사이트)
  sources        JSONB        NOT NULL,   -- 소스별 상태(수집/업로드 시각, 성공여부)
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (division_code, captured_date)
);

-- 자동 수집 실행 이력
CREATE TABLE collection_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  division_code  VARCHAR(20)  NOT NULL,
  trigger        VARCHAR(20)  NOT NULL,   -- 'cron' | 'manual' | 'upload'
  status         VARCHAR(20)  NOT NULL,   -- 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED'
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  detail         JSONB                    -- 태스크별 성공/실패 내역
);
```

### 2. 자동 수집

- `node-cron` 도입, 새벽 시간대 본부별 **순차** 실행 (Veeva 동시 로그인 충돌 회피)
- 기존 수집 로직(`startDevCollectAll` 등) 재사용, 저장 경로만 workspace로
- 수집 완료 → 스냅샷 계산 → `dashboard_snapshots` upsert (당일 1건)
- **실패 시**: 이전 스냅샷 유지, `collection_runs`에 실패 기록, 대시보드에 "마지막 성공 수집 시각"과 실패 항목 표시

### 3. 지표 추출 (리팩터)

- 기존 차트 빌더(`buildGcpBarCharts` 등)는 이미 숫자 배열(`docV`/`userV`/`loginV`/…)을 계산 → **데이터도 함께 반환**하도록 확장
- 신규 `*.dashboard.service.ts`: 동일 parse 함수를 재사용해 스냅샷 JSON 생성
- PDF 경로는 기존 PNG 렌더링 그대로 유지 (회귀 없음)
- 업로드 완료 시 스냅샷 재계산 트리거

### 4. API

| 엔드포인트 | 용도 |
|---|---|
| `GET /api/dashboard/:divisionCode` | 최신 스냅샷 + 소스 상태 + 마지막 수집 정보 |
| `GET /api/dashboard/:divisionCode/trend?metric=&days=30` | 일별 추이 |
| `POST /api/dashboard/:divisionCode/refresh` | 수동 재수집 (관리자) |

`divisionGuard` 적용 — 담당자는 소속 본부만, admin은 전체.

### 5. 프론트 대시보드

- `recharts` 도입
- 라우트 `/dashboard/:divisionCode`
- 구성: KPI 카드 → 차트 그리드 → 일별 추이 → 소스 상태 패널(업로드/수집 시각·실패 표시)
- 업로드 패널 유지 (업로드 → 스냅샷 갱신 → 대시보드 반영)

## Phase 분할 / 진행 상황

- **Phase 1 — 기반 ✅ 완료**
  - `dashboard_snapshots` · `collection_runs` 마이그레이션
  - 고정 jobId 작업공간, `dev.dashboard.service.ts`(스냅샷 빌더), `dashboard.service.ts`(저장·조회·추이)
  - API: `GET /api/dashboard/:code`, `GET …/trend`, `POST …/refresh`
- **Phase 2 — 자동화 ✅ 완료**
  - `collection.scheduler.ts` — node-cron, 기본 `0 3 * * *` (Asia/Seoul), 본부 순차, 중복 실행 가드
  - 수집 실패해도 스냅샷은 갱신하고 `collection_runs` 에 사유 기록
  - `POST /api/dashboard/:code/collect` — 즉시 수집(새벽까지 기다리지 않을 때)
  - 업로드 훅: 파일 업로드 시 스냅샷 자동 재계산 (`file.router.ts`)
- **Phase 3 — UI ✅ 완료 (개발본부)**
  - recharts 도입, `/ops/:divisionCode`, 사이드바 "운영 현황" 섹션
  - KPI 타일 · 일별 추이 · 섹션별 차트 · 인사이트 · 데이터 소스 상태
- **Phase 4 — 확장 ✅ 완료 (LHOUSE · BIO)**
  - `snapshot.shared.ts` — 세 본부 공용 변환·집계·소스상태·타임시트 헬퍼
  - `lhouse.dashboard.service.ts` — Veeva Quality System(문서/사용자/접속/품질/교육/업무활용)
  - `bio.dashboard.service.ts` — Veeva eDMS(문서/사용자/접속/업무활용/생성문서구분)
  - `runLhouseCollectAllAwait()` · `runBioCollectAwait()` — 무인 수집
  - 자동 수집 기본 대상: `DEV,LHOUSE,BIO` (순차)
  - 사이드바 "운영 현황" 3개 항목, 업로드 훅도 세 본부 인식

## 본부별 대시보드 범위

| 본부 | 자동 수집 소스 | 대시보드 섹션 |
|---|---|---|
| 개발본부 | GCP 4 + Medcomms 4 + CTMS 2 | GCP Quality System · Medcomms · CTMS/eTMF · Timesheet |
| L HOUSE 공장 | LHOUSE PerfStats/Quality/Training + Activity | Veeva Quality System · Timesheet |
| Bio연구본부 | BIO Activity/PerfStats/DocType | Veeva System(eDMS) · Timesheet |

**미포함**: Bio연구본부의 *임검분 LIMS* · *전자연구노트(ELN)* 는 자동 수집 대상이 아니고
(수동 업로드 전용) 별도 PDF 보고서이므로 대시보드에 포함하지 않았다. 화면에도 그렇게 안내한다.

## 일별 추이 데이터 출처 (중요)

Veeva **Performance Statistics** 리포트에는 두 종류의 행이 섞여 있다.

```
"Created Date (Month): 2026 Apr (30)"   ← 월 그룹 헤더 (값 = 월평균)
"2026-04-01"                             ← 일별 행 (값 = 그날 값)
```

- PDF 리포트 경로(`parseGcpMonthGroups`)는 **월 헤더만** 읽어 월평균 막대를 만든다(그대로 유지).
- 대시보드 추이는 `parseDailySeries`(snapshot.shared.ts)로 **일별 행**을 읽는다.
  → 스냅샷이 하루치뿐이어도 **최근 약 3개월(91일)** 실제 일별 추이를 즉시 볼 수 있다.
- 일별 시리즈는 스냅샷 payload 의 `daily` 에 `KPI key → 시리즈` 로 저장된다.
- `getTrend()` 는 ① 스냅샷의 `daily` 를 우선 사용하고,
  ② 일별 데이터가 없는 지표(품질 이벤트·교육 등 월/카테고리 집계)는
  기존처럼 **스냅샷을 날짜별로 이어 붙이는** 폴백을 쓴다.
- 화면에서 30 / 60 / 90일 범위를 고를 수 있다.

일별 데이터가 있는 지표: 문서 관리 · 등록 사용자 · 일평균 접속 (세 본부 공통,
개발본부는 GCP·Medcomms·CTMS 각각).

## 차트 규칙 (적용됨)

- 카테고리 팔레트는 흰색 카드 표면에 대해 검증 통과(명도·채도·CVD 인접쌍 ΔE 9.1·일반시야 19.6).
  대비 3:1 미달 슬롯(aqua·yellow·magenta)은 **값 직접 레이블**로 완화.
- 슬롯 순서는 CVD 안전장치 — 임의 변경·색 순환 금지. 8개 초과 시 "기타"로 접는다.
- **이중축 금지.** Medcomms 문서 리뷰(Document Count + Time in Review)는 차트 2개로 분리.
- 막대 ≤24px, 데이터 끝 4px 라운드, 누적/인접 막대 2px 표면 간격, 격자 hairline 실선.
- 시리즈 2개 이상 → 범례 항상 / 단일 시리즈 → 범례 없음. 건수·인원 축은 정수 눈금.
- **0 기준선은 막대에만** 적용한다(길이로 크기를 인코딩). 추이 **선**은 데이터 범위에 맞춘
  축을 쓴다 — 0을 강제하면 20만대 지표의 일별 변화가 평평해져 추이를 읽을 수 없다.
  축 눈금에 실제 값이 표기되므로 과장 위험은 없다.
- 점이 40개를 넘으면 개별 마커를 숨기고(hover 시 activeDot), x축 라벨은 약 8개만 노출한다.
- 텍스트는 시리즈 색을 입지 않고 잉크 토큰 사용. 상태는 색 + 라벨(아이콘) 병기.

## 환경변수

| 변수 | 기본값 | 용도 |
|---|---|---|
| `DASHBOARD_CRON` | `0 3 * * *` | 자동 수집 크론식 |
| `DASHBOARD_CRON_TZ` | `Asia/Seoul` | 크론 타임존 |
| `DASHBOARD_CRON_ENABLED` | (활성) | `false` 면 스케줄러 비활성 |
| `DASHBOARD_CRON_DIVISIONS` | `DEV,LHOUSE,BIO` | 자동 수집 대상 본부 CSV |

## UI 노트

- 대시보드의 수동 **"지금 수집" 버튼은 UI 에서 숨김** 상태다
  (`OpsDashboardPage.SHOW_COLLECT_BUTTON = false`). 백엔드
  `POST /api/dashboard/:code/collect` 와 `collectDivision()` 은 그대로 살아 있어
  플래그만 바꾸면 즉시 되살릴 수 있다.

### 주의: 본부 전환 시 상태 초기화

`/ops/:divisionCode` 는 본부가 바뀌어도 **같은 컴포넌트가 재사용**된다(라우터가 리마운트하지 않음).
따라서 `useState` 로 잡은 선택 상태는 이전 본부 값이 남는다. 추이 지표(`metric`)는 본부별 키가
다르므로(`gcp_doc` vs `lh_doc` vs `bio_doc`) 그대로 두면 **빈 그래프**가 나오고 새로고침해야 보인다.

→ 상태를 직접 쓰지 말고 **현재 본부에 존재하는 키인지 확인해 파생값(`activeMetric`)으로** 쓴다.
   본부별 선택 상태를 새로 추가할 때도 같은 방식을 따를 것.

## DB 이식성 (사내 AWS + MariaDB 이관 대비)

대시보드 테이블은 **`JSON`**(≠`JSONB`)을 쓴다. 문서를 통째로 저장·조회할 뿐
jsonb 연산자(`@>` 등)나 GIN 인덱스를 쓰지 않으므로 기능 차이가 없고, MariaDB 에는
JSONB 대응 타입이 없어 그대로 옮길 수 없기 때문이다. (pg 드라이버는 json/jsonb 모두
JS 객체로 파싱하므로 애플리케이션 코드는 동일하다.)

- 적용 컬럼: `dashboard_snapshots.data` · `dashboard_snapshots.sources` · `collection_runs.detail`
- 이미 JSONB 로 만들어진 DB 는 `dashboard.jsonb_to_json` 마이그레이션이 변환한다(멱등).
- **새 컬럼을 추가할 때도 `JSON` 을 쓸 것.**

### 아직 JSONB 인 컬럼 (변환 보류)

`divisions.system_configs` · `uploaded_files.analysis_result` 는 **GIN 인덱스**가 걸려 있고
(`USING GIN`), GIN 은 `json` 에 만들 수 없다. `mail_recipient_groups.emails` 는 인덱스는
없으나 관련 코드가 `jsonb_build_object` 를 쓴다(`admin.router.ts`, `screenshot-config.service.ts`).
→ MariaDB 이관 시 이 3개는 인덱스 전략·해당 기능 코드와 함께 별도로 다뤄야 한다.

## 유지 사항 (회귀 금지)

- 기존 PDF 생성 3종(`/report/generate-dev|lhouse|bio`) 및 History 저장
- 수동 업로드 슬롯 및 파일명 규칙(`Activity_GCP.xlsx`, `SKB_Quallity_MS_Timesheet.xlsx` 등)
- 원클릭 수집 버튼(수동 재수집 경로로 계속 활용)
