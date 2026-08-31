/**
 * Veeva Vault 리포트 URL 이동 (공용)
 *
 * ─ 왜 별도 모듈인가 ──────────────────────────────────────────────────────────
 *  같은 이동 로직이 VeevaReportExportCrawler / DevGcpActivityCrawler /
 *  LhouseVeevaCrawler 세 곳에 복제되어 있었고, 세 곳 모두 같은 버그를 갖고 있었다.
 *  한 곳에서만 구현하도록 분리한다.
 *
 * ─ 고쳐진 버그 ───────────────────────────────────────────────────────────────
 *  기존 코드는 이미 같은 문서(sk-gcp.veevavault.com/ui/)에 있으면
 *  `window.location.href = 리포트URL` 로 **해시만** 바꾸고 고정 2초를 기다렸다.
 *  해시 변경은 문서를 다시 로드하지 않으므로, 로그인/Vault 전환 직후 아직 부팅 중인
 *  Veeva SPA 가 자체 기본 라우팅(Home ▸ All Tasks)으로 우리 해시를 덮어쓰는
 *  **경쟁 상태**가 발생했다. 이동 성공 여부를 검증하지 않아 잘못된 페이지에서 그대로
 *  진행하다가 "Export to Excel 메뉴를 찾을 수 없습니다"로 오진 실패했다.
 *  (실측: 같은 실행에서 GCP PerfStats·Activity 는 실패, Quality·Training 은 성공)
 *
 *  수정:
 *   1) 해시를 먼저 심고 **강제 재로딩**한다 → URL 에 리포트 해시가 있는 상태로 SPA 가
 *      부팅하므로 "부팅 후 기본 라우팅"과 경쟁하지 않는다.
 *   2) 이동 후 URL 이 리포트 라우트를 **일정 시간 계속 유지**하는지 검증한다
 *      (SPA 가 1~2초 뒤 덮어쓰는 경우를 잡아낸다).
 *   3) 실패 시 재시도하고, 끝내 실패하면 **진짜 원인**을 담아 즉시 throw 한다
 *      (잘못된 페이지에서 15회 재시도로 3분 넘게 낭비하지 않는다).
 */

import type { Page } from "playwright";

export interface OpenReportOptions {
  /** 진행 로그 콜백 */
  emit?:      (message: string) => void;
  /** 이동 시도 횟수 (기본 3) */
  attempts?:  number;
  /** 이동 후 리포트 라우트 유지 확인 제한 시간 (기본 15초) */
  verifyMs?:  number;
  /** 라우트가 이만큼 연속 유지되면 성공으로 본다 (기본 2.5초) */
  stableMs?:  number;
}

/**
 * URL 해시에서 리포트 라우트 토큰을 뽑는다.
 *   "https://…/ui/#reporting/viewer/0RP000000017001?Perf…BETWEEN=…"
 *   → "reporting/viewer/0RP000000017001"
 * 쿼리(날짜 필터)는 SPA 가 바꿀 수 있으므로 제외하고 라우트 경로만 비교한다.
 */
export function reportRouteToken(url: string): string | null {
  const hash = url.split("#")[1];
  if (!hash) return null;
  const route = hash.split("?")[0].replace(/^\/+/, "").trim();
  return route || null;
}

/** URL 이 토큰을 stableMs 동안 연속 유지하는지 확인 */
async function urlHoldsRoute(
  page: Page, token: string, timeoutMs: number, stableMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let heldSince: number | null = null;

  while (Date.now() < deadline) {
    if (page.url().includes(token)) {
      if (heldSince === null) heldSince = Date.now();
      if (Date.now() - heldSince >= stableMs) return true;
    } else {
      heldSince = null;   // SPA 가 덮어썼다 — 처음부터 다시
    }
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * 리포트 URL 로 이동하고, 실제로 그 리포트 라우트에 머물렀는지 검증한다.
 *
 * @throws 이동에 실패하면(SPA 가 기본 화면으로 되돌린 경우 등) 명확한 메시지로 예외
 */
export async function openVeevaReportUrl(
  page: Page, targetUrl: string, opts: OpenReportOptions = {}
): Promise<void> {
  const emit     = opts.emit ?? (() => {});
  const attempts = opts.attempts ?? 3;
  const verifyMs = opts.verifyMs ?? 15_000;
  const stableMs = opts.stableMs ?? 2_500;
  const token    = reportRouteToken(targetUrl);

  let lastUrl = page.url();

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const sameDoc = page.url().split("#")[0] === targetUrl.split("#")[0];

    try {
      if (sameDoc) {
        // 해시만 다른 경우 goto 는 same-document 이동이라 문서를 다시 로드하지 않는다.
        // 해시를 심은 뒤 reload 해서 "리포트 해시를 가진 상태로 부팅"시킨다.
        await page.evaluate((u) => { window.location.replace(u); }, targetUrl).catch(() => {});
        await page.waitForTimeout(300);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      } else {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // SPA 해시 이동이 same-document 로 처리되어 ABORT 되는 경우는 무시하고 검증으로 넘어간다
      if (!msg.includes("ERR_ABORTED")) {
        emit(`이동 오류(시도 ${attempt}/${attempts}): ${msg}`);
      }
    }

    await page.waitForLoadState("domcontentloaded").catch(() => {});

    // 검증할 라우트가 없는 URL(해시 없음)이면 그대로 진행
    if (!token) return;

    if (await urlHoldsRoute(page, token, verifyMs, stableMs)) {
      emit(`리포트 페이지 진입 확인 (시도 ${attempt}/${attempts})`);
      return;
    }

    lastUrl = page.url();
    emit(`리포트 라우트 이탈 감지 — 재시도 ${attempt}/${attempts} (현재 URL: ${lastUrl})`);
  }

  throw new Error(
    `리포트 페이지로 이동하지 못했습니다 (${attempts}회 시도). ` +
    `Veeva SPA 가 기본 화면으로 되돌렸거나 해당 리포트에 접근할 수 없습니다.\n` +
    `목표 URL: ${targetUrl}\n` +
    `현재 URL: ${lastUrl}`
  );
}

/**
 * Veeva 콜아웃(안내 말풍선) 해제
 *
 * ─ 왜 필요한가 ───────────────────────────────────────────────────────────────
 *  Vault 업그레이드 안내("Your Vault has been upgraded to 26R2…")가 뜨면 Veeva 는
 *  말풍선 뒤에 **화면 전체를 덮는** `.vv-callout-background` + `.vv-callout-focus-trap`
 *  (0,0 ~ 뷰포트 전체)을 깔아 다른 요소의 클릭을 모두 가로챈다.
 *  이 상태에서 Vault 드롭다운을 클릭하면 Playwright 가
 *  "<div class='vv-callout-background'> … intercepts pointer events" 로 30초를
 *  소진하고 타임아웃 실패한다. (실측: 2026-08-31 GCP 3개 리포트 동시 실패)
 *
 *  해제 순서 — 부작용이 작은 것부터:
 *   1) 콜아웃의 "Dismiss" 버튼 클릭 (Veeva 가 의도한 정상 경로. 서버에 읽음 처리)
 *   2) Escape 키
 *   3) 그래도 남으면 오버레이 DOM 을 직접 제거 (콜아웃 종류가 달라 1·2가 안 먹는 경우)
 *
 *  콜아웃은 로그인 직후뿐 아니라 페이지 전환 뒤에도 뜰 수 있으므로 클릭 전 매번 호출한다.
 *  콜아웃이 없으면 즉시 반환하므로(있는지 먼저 확인) 상시 호출해도 비용이 거의 없다.
 */
export async function dismissVeevaCallouts(
  page: Page, emit: (message: string) => void = () => {}
): Promise<boolean> {
  const BLOCKERS = ".vv-callout-background, .vv-callout-focus-trap, .vv-callout-content-overlay";

  const blockerCount = async (): Promise<number> =>
    page.evaluate((sel) => document.querySelectorAll(sel).length, BLOCKERS).catch(() => 0);

  if (await blockerCount() === 0) return false;
  emit("Veeva 안내 팝업 감지 — 닫는 중…");

  // 1) Dismiss 버튼 (여러 개가 쌓여 있을 수 있어 최대 3회)
  for (let i = 0; i < 3; i++) {
    const btn = page.locator(".vv-callout-content-dismiss").first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) break;
    // force: 콜아웃 배경이 자기 자신의 Dismiss 버튼까지 가리는 경우가 있다
    await btn.click({ timeout: 3_000, force: true }).catch(() => {});
    await page.waitForTimeout(400);
    if (await blockerCount() === 0) break;
  }

  // 2) Escape
  if (await blockerCount() > 0) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  }

  // 3) 최후 수단 — 오버레이 DOM 제거 (말풍선 자체는 남겨도 클릭은 통과한다)
  const remaining = await blockerCount();
  if (remaining > 0) {
    await page.evaluate((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    }, BLOCKERS).catch(() => {});
    emit(`Veeva 안내 팝업 오버레이 ${remaining}개 강제 제거`);
  } else {
    emit("Veeva 안내 팝업 닫음");
  }
  return true;
}
