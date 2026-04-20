/**
 * 크롤러 날짜 범위 유틸리티
 * 외부 라이브러리 없이 순수 Date 사용
 */

export interface DateRange {
  from: string;
  to:   string;
}

/**
 * 오늘 기준 최근 N개월의 시작/종료일을 반환합니다.
 *
 * @param months     기간 (기본 3개월)
 * @param format     날짜 포맷 토큰 (기본 'YYYY-MM-DD')
 *                   지원 토큰: YYYY MM DD YY M D
 */
export function getLastNMonths(months = 3, format = "YYYY-MM-DD"): DateRange {
  const to   = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - months);
  from.setDate(1); // 시작일은 해당 월 1일

  return {
    from: formatDate(from, format),
    to:   formatDate(to,   format),
  };
}

/** 시스템 날짜 포맷 문자열로 Date를 변환합니다. */
export function formatDate(date: Date, format: string): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");

  const Y  = date.getFullYear();
  const M  = date.getMonth() + 1;
  const D  = date.getDate();

  return format
    .replace("YYYY", String(Y))
    .replace("YY",   String(Y).slice(-2))
    .replace("MM",   pad(M))
    .replace("M",    String(M))
    .replace("DD",   pad(D))
    .replace("D",    String(D));
}

/** YYYY-MM-DD → Date */
export function parseDate(str: string): Date {
  return new Date(str);
}
