# 사내 MariaDB 이관 꾸러미

맥북 로컬 MariaDB 의 내용을 사내 MariaDB 로 옮기기 위한 꾸러미입니다.

## 담긴 것

| 파일 | 내용 |
|---|---|
| `db.sql.gz` | 전체 DB 덤프 (utf8mb4, 10개 테이블) |
| `files/` | 앱이 실제로 읽는 파일 — 수집 결과·수동 업로드·저장된 보고서 |
| `restore.sh` | 사내에서 실행할 복원 스크립트 |

크롤러가 단계마다 찍은 디버그 캡처와 PDF 렌더 중 생성된 차트 이미지는 제외했습니다
(재생성되는 파일이라 옮길 필요가 없고, 전체 514MB 중 대부분을 차지합니다).

## 복원

`mariadb`(또는 `mysql`) 클라이언트와 `tar`·`gzip` 만 있으면 됩니다. Node 는 필요 없습니다.

```bash
# TCP 접속
DB_HOST=<호스트> DB_USER=<계정> DB_PASS=<비밀번호> \
DB_NAME=skbs_it_report TARGET_ROOT=/srv/skbs \
  bash restore.sh

# 유닉스 소켓 인증 서버
DB_SOCKET=/var/run/mysqld/mysqld.sock DB_USER=<계정> \
DB_NAME=skbs_it_report TARGET_ROOT=/srv/skbs \
  bash restore.sh
```

`TARGET_ROOT` 는 파일을 둘 위치입니다. 스크립트가 파일을 그곳에 배치하고,
**DB 안에 저장된 절대경로를 그 값으로 바꿉니다.**

### 이 단계가 왜 중요한가

DB 에는 원본 맥북의 절대경로가 그대로 들어 있습니다.

```
/Users/zamini/Project/IT System Ops Report/uploads/.../GCP_PerfStats.xlsx
```

사내 서버에는 이 경로가 없으므로, 치환하지 않으면 **DB 는 정상인데 파일을 찾지 못해
대시보드와 보고서가 조용히 빈 값으로 나옵니다.** 오류가 뜨지 않아 알아채기 어렵습니다.
`restore.sh` 가 치환과 검증을 함께 수행합니다.

## 복원 후 설정

```bash
DATABASE_URL=mysql://<user>:<pass>@<host>:3306/skbs_it_report
DB_SSL=true                      # TLS 필수인 경우
UPLOAD_DIR=<TARGET_ROOT>/uploads
OUTPUT_DIR=<TARGET_ROOT>/outputs
SAVED_REPORTS_DIR=<TARGET_ROOT>/saved_reports
```

## 시각 처리 — 반드시 확인

이 앱은 모든 `DATETIME` 에 **UTC 만** 저장하고 KST 변환은 애플리케이션이 합니다
(MariaDB 에는 `TIMESTAMPTZ` 가 없기 때문입니다). 앱은 커넥션마다
`SET time_zone='+00:00'` 을 걸지만, **서버 기본값도 UTC 로 맞추는 것을 권장**합니다.
어긋나면 새벽 자동 수집의 날짜 경계가 틀어져 스냅샷이 엉뚱한 날짜로 저장됩니다.

- RDS: 파라미터 그룹에서 `time_zone = UTC`
- 온프레미스: `my.cnf` 에 `default-time-zone = '+00:00'`

복원 스크립트가 현재 값을 출력하고 UTC 가 아니면 경고합니다.

## 검증 항목

`restore.sh` 가 자동으로 확인합니다.

- 테이블별 행 수
- 최신 스냅샷 날짜 — **원본과 같아야 합니다.** 하루 밀리면 타임존 문제입니다
- 서버 타임존
- 앱이 읽는 파일이 실제로 존재하는지 (고정 작업공간 + 공유 Timesheet)
- 저장된 보고서 PDF 존재 여부

## 참고

`uploaded_files` 에는 과거 이력 행이 남아 있고 일부는 파일이 없습니다
(구 슬롯명 `Systemusage_CTMS.png`, 구 포맷 `LIMS.png` 등). 앱은 본부별 고정
작업공간의 파일만 읽으므로 동작에 영향이 없어 그대로 두었습니다.
