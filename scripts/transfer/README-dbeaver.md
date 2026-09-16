# 폐쇄망 DBeaver 반입 절차

사내 DB 는 샤크라맥스(DB 접근제어)를 거쳐 **DBeaver 로만** 접근하고, 클라이언트는
폐쇄망 Windows 입니다. bash 스크립트도 `mariadb` CLI 도 쓸 수 없으므로,
**DBeaver 에서 그대로 실행하는 .sql 4개**로 이관합니다.

## 반입할 파일

```
transfer-sql/
  01_schema.sql        테이블 정의 (10개)
  02_data.sql          데이터 190행, 238 KB
  03_path_rewrite.sql  파일 경로 치환  ★ 한 줄 수정 필요
  04_verify.sql        검증
```

전부 텍스트라 합계 **약 250KB** 입니다. 메일·USB 어느 쪽이든 부담 없습니다.

## 실행 순서 (DBeaver)

1. 대상 DB 에 연결하고 **스키마를 선택**합니다
   (선택하지 않으면 엉뚱한 스키마에 생성될 수 있습니다)
2. `01_schema.sql` 열기 → **Execute script** (Alt+X). `Execute statement`(Ctrl+Enter)가
   아니라 **script** 여야 전체가 실행됩니다
3. `02_data.sql` → Execute script
4. `03_path_rewrite.sql` → **`@NEW` 한 줄을 사내 경로로 수정한 뒤** Execute script
5. `04_verify.sql` → Execute script, 결과를 파일 상단 주석의 "원본 행 수" 와 대조

DB 생성 권한이 없으면 DBA 에게 아래를 요청하세요.

```sql
CREATE DATABASE skbs_it_report CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

## ★ 3단계를 건너뛰면 안 되는 이유

DB 에는 원본 맥북의 절대경로가 그대로 들어 있습니다.

```
/Users/zamini/Project/IT System Ops Report/uploads/.../GCP_PerfStats.xlsx
```

사내 서버에는 이 경로가 없습니다. 치환하지 않으면 **DB 는 정상인데 앱이 파일을
찾지 못해 대시보드와 보고서가 오류 없이 빈 값으로** 나옵니다. 알아채기 어렵습니다.

`03_path_rewrite.sql` 마지막 줄이 `남은_원본경로 = 0` 을 돌려주면 정상입니다.

## 확인할 것

| 항목 | 기대값 |
|---|---|
| 행 수 | `04_verify.sql` 상단 주석의 "원본 행 수" 와 동일 |
| 최신 스냅샷 날짜 | **2026-09-12** — 하루 밀리면 타임존 문제 |
| 한글 | `Bio연구본부` · `개발본부` · `L HOUSE 공장` 이 깨지지 않을 것 |
| 서버 타임존 | UTC 권장 (아래 참고) |

## 시각 처리 — DBA 에게 전달할 사항

이 앱은 모든 `DATETIME` 에 **UTC 만** 저장하고 KST 변환은 애플리케이션이 합니다
(MariaDB 에는 `TIMESTAMPTZ` 가 없기 때문입니다). 앱은 커넥션마다
`SET time_zone='+00:00'` 을 걸므로 대개 문제가 없지만, DB 에서 직접 조회·집계할 때
값이 어긋나 보입니다. **서버 기본값도 UTC 로 맞추기를 권장**합니다.

- RDS: 파라미터 그룹 `time_zone = UTC`
- 온프레미스: `my.cnf` 에 `default-time-zone = '+00:00'`

## 파일(엑셀·이미지·PDF)은 별도입니다

이 SQL 꾸러미는 **DB 내용만** 옮깁니다. 앱이 읽는 실제 파일 약 22MB 는
애플리케이션 서버의 파일 경로(`UPLOAD_DIR` 등)에 따로 배치해야 합니다.
`transfer-package.tar.gz` 의 `files/` 가 그 내용이며, 3단계에서 지정한
`@NEW` 경로와 같은 곳에 두면 됩니다.

```
<@NEW>/uploads/00000000-0000-4000-8000-00000000000{1,2,3,9}/uploads/…
<@NEW>/saved_reports/…
```

## 참고: 빠진 데이터가 하나 있습니다 (의도적)

`uploaded_files.analysis_result` 에는 업로드 엑셀의 **전 시트 전 행**이 JSON 으로
들어 있었습니다(단일 값 최대 1.9MB, 합계 6.2MB). 이런 INSERT 한 줄은 DBeaver 와
접근제어 게이트웨이에서 잘리거나 거부되기 쉽습니다.

화면이 실제로 읽는 값은 `status` · `result.type` · `sheetCount`/`pageCount` 뿐이고
("시트 3개" 배지 한 줄) `sheets` 배열은 어디서도 읽지 않으므로 제외했습니다.
그 결과 6,242KB → 3KB 로 줄었고 화면 표시는 동일합니다.
원본 엑셀 파일은 그대로 있으므로 필요하면 재분석으로 복구할 수 있습니다.

## 다시 만들어야 할 때

맥북에서:

```bash
npx tsx apps/backend/src/scripts/export-sql-for-dbeaver.ts
```
