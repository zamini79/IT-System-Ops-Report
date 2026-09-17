# 폐쇄망 DBeaver 이관 절차

**스키마(테이블 정의)는 사내에서 별도로 생성**한 뒤, 이 꾸러미로 데이터를 넣습니다.
사내 DB 는 샤크라맥스(DB 접근제어)를 거쳐 DBeaver 로 접근하고 클라이언트는 Windows 입니다.

## 꾸러미 구성

```
00_precheck.sql       스키마가 기대대로 만들어졌는지 확인   ← 먼저 실행
01_data.sql           데이터 190행 (239 KB)
02_path_rewrite.sql   파일 경로 치환   ★ 한 줄 수정 필요
03_verify.sql         검증
files/                앱이 읽는 실제 파일 42개 (20.9 MB)
```

## 실행 순서

### 0단계 — 스키마 생성 (사내에서 별도 진행)

`apps/backend/src/config/schema.mariadb.sql` 기준으로 만드시면 됩니다.
문자셋은 반드시 **utf8mb4 / utf8mb4_unicode_ci** 로 하세요.

```sql
CREATE DATABASE skbs_it_report CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 1단계 — `00_precheck.sql`

DBeaver 에서 대상 스키마를 선택하고 **Execute script (Alt+X)** 로 실행합니다.
(`Ctrl+Enter` 는 문장 하나만 실행합니다)

확인할 것:

| 결과 | 기대값 |
|---|---|
| ② 테이블 존재·컬럼 수 | `존재=1`, `기대컬럼수 = 실제컬럼수` (10개 테이블 전부) |
| ③ 없는 컬럼 | **0행** |
| ④ 기존 데이터 | 시드(divisions 3 · users 1)만 있거나 0행 |
| ⑤ 문자셋 | `utf8mb4` |
| ⑥ 타임존 | UTC 권장 |

②③ 이 어긋나면 스키마가 다른 것이니, 진행하지 말고 스키마부터 맞추세요.
그대로 넣으면 `Unknown column` 등으로 중간에 멈춥니다.

### 2단계 — `01_data.sql`

> ⚠️ 이 파일은 맨 앞에서 **대상 테이블을 모두 비웁니다.**
> 스키마 생성 시 들어간 시드와 겹치면 중복 키로 멈추기 때문입니다.
> 1단계 ④ 에서 지워도 되는 데이터인지 먼저 확인하세요.
> 덕분에 중간에 실패해도 처음부터 다시 실행할 수 있습니다.

한 행당 한 문장입니다. 게이트웨이가 문장 단위로 감사·차단하므로,
막히면 **몇 번째 문장에서 멈췄는지 바로 보입니다.**
컬럼명을 명시해 열 순서가 달라도 들어갑니다.

### 3단계 — `02_path_rewrite.sql`

**`@NEW` 한 줄을 수정한 뒤** 실행하세요. `files/` 를 풀어 둔 경로여야 합니다.

```sql
SET @NEW = '/srv/skbs/';   -- ← files/ 를 배치한 경로
```

마지막 조회가 **4개 행 모두 `남은_원본경로 = 0`** 이면 정상입니다.

#### 이 단계를 건너뛰면 안 되는 이유

DB 에는 원본 맥북의 절대경로가 그대로 들어 있습니다.

```
/Users/zamini/Project/IT System Ops Report/uploads/.../GCP_PerfStats.xlsx
```

사내 서버에는 이 경로가 없습니다. 바꾸지 않으면 **DB 는 정상인데 앱이 파일을
찾지 못해 대시보드와 보고서가 오류 없이 빈 값으로** 나옵니다. 알아채기 어렵습니다.

### 4단계 — `03_verify.sql`

결과를 파일 상단 주석의 "원본" 값과 대조합니다.

| 항목 | 기대값 |
|---|---|
| 행 수 | 주석의 원본 행 수와 동일 |
| 최신 스냅샷 | **2026-09-12** (BIO·DEV·LHOUSE) — 하루 밀리면 타임존 문제 |
| 한글 | `Bio연구본부` · `개발본부` · `L HOUSE 공장` |
| 경로 | `@NEW` 로 시작 |

## 파일 배치 (`files/`)

`@NEW` 로 지정한 경로에 `files/` 내용을 그대로 풉니다.

```
<@NEW>/uploads/00000000-0000-4000-8000-000000000001/uploads/…   개발본부
<@NEW>/uploads/00000000-0000-4000-8000-000000000002/uploads/…   L HOUSE
<@NEW>/uploads/00000000-0000-4000-8000-000000000003/uploads/…   Bio연구본부
<@NEW>/uploads/00000000-0000-4000-8000-000000000009/uploads/…   공유 Timesheet
<@NEW>/saved_reports/…                                          과거 보고서 PDF
```

앱 환경변수도 같은 경로로 맞춥니다.

```bash
UPLOAD_DIR=<@NEW>/uploads
OUTPUT_DIR=<@NEW>/outputs
SAVED_REPORTS_DIR=<@NEW>/saved_reports
```

## 시각 처리 — DBA 께 전달

이 앱은 모든 `DATETIME` 에 **UTC 만** 저장하고 KST 변환은 애플리케이션이 합니다
(MariaDB 에는 `TIMESTAMPTZ` 가 없기 때문입니다). 앱은 커넥션마다
`SET time_zone='+00:00'` 을 걸므로 대개 문제가 없지만, DB 에서 직접 조회·집계할 때
값이 어긋나 보입니다. **서버 기본값도 UTC 를 권장**합니다.

- RDS: 파라미터 그룹 `time_zone = UTC`
- 온프레미스: `my.cnf` 에 `default-time-zone = '+00:00'`

## 참고: 의도적으로 뺀 데이터

`uploaded_files.analysis_result` 에 업로드 엑셀의 **전 시트 전 행**이 JSON 으로
들어 있었습니다(단일 값 최대 1.9MB, 합계 6.2MB). 이런 INSERT 한 줄은 DBeaver 와
접근제어 게이트웨이에서 잘리거나 거부되기 쉽습니다.

화면이 실제로 읽는 값은 `status` · `result.type` · `sheetCount`/`pageCount` 뿐이고
("시트 3개" 배지 한 줄) `sheets` 배열은 어디서도 읽지 않으므로 제외했습니다.
6,242KB → 3KB 로 줄었고 화면 표시는 동일합니다.
원본 엑셀은 `files/` 에 있으므로 필요하면 재분석으로 복구할 수 있습니다.

## 다시 만들어야 할 때

맥북에서:

```bash
npx tsx apps/backend/src/scripts/export-sql-for-dbeaver.ts
```
