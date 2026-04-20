/**
 * Screenshot Config Service
 *
 * divisions.system_configs JSONB 의 screenshotTargets 키를
 * 읽고 쓰는 서비스 레이어.
 *
 * ─ DB 저장 구조 ─────────────────────────────────────────────────────────────
 *  system_configs JSONB:
 *  {
 *    "systems": [...],                  ← 기존 접속 정보 (건드리지 않음)
 *    "screenshotTargets": [             ← 이 서비스가 관리하는 키
 *      { systemName, label, urlPath, selector, ... }
 *    ]
 *  }
 */

import { query }            from "../../config/db";
import { AppError }         from "../../utils/errors";
import type { DivisionCode } from "../../engines/playwright/types";
import {
  type DivisionScreenshotConfig,
  type DivisionSystemConfigs,
  type ScreenshotTargetConfig,
  getScreenshotConfig,
  serializeTargets,
  DEFAULT_SCREENSHOT_CONFIGS,
} from "../../config/screenshot.config";

// ── 조회 ─────────────────────────────────────────────────────────────────────

/**
 * 사업부 ID로 스크린샷 설정을 읽어옵니다.
 * DB 에 저장된 값과 코드 기본값을 병합하여 반환합니다.
 */
export async function getScreenshotConfigByDivisionId(
  divisionId: string
): Promise<DivisionScreenshotConfig> {
  const rows = await query<{
    code:           string;
    system_configs: DivisionSystemConfigs | null;
  }>(
    "SELECT code, system_configs FROM divisions WHERE id = $1",
    [divisionId]
  );

  if (!rows.length) {
    throw new AppError(404, "사업부를 찾을 수 없습니다.");
  }

  const { code, system_configs } = rows[0];
  return getScreenshotConfig(code as DivisionCode, system_configs);
}

/**
 * 사업부 코드로 스크린샷 설정을 읽어옵니다.
 */
export async function getScreenshotConfigByDivisionCode(
  divisionCode: DivisionCode
): Promise<DivisionScreenshotConfig> {
  const rows = await query<{
    id:             string;
    system_configs: DivisionSystemConfigs | null;
  }>(
    "SELECT id, system_configs FROM divisions WHERE code = $1",
    [divisionCode]
  );

  if (!rows.length) {
    throw new AppError(404, `사업부 코드를 찾을 수 없습니다: ${divisionCode}`);
  }

  return getScreenshotConfig(divisionCode, rows[0].system_configs);
}

/**
 * 전체 사업부의 스크린샷 설정을 반환합니다.
 */
export async function getAllScreenshotConfigs(): Promise<DivisionScreenshotConfig[]> {
  const rows = await query<{
    code:           string;
    system_configs: DivisionSystemConfigs | null;
  }>(
    "SELECT code, system_configs FROM divisions ORDER BY code"
  );

  return rows.map(({ code, system_configs }) =>
    getScreenshotConfig(code as DivisionCode, system_configs)
  );
}

// ── 저장 ─────────────────────────────────────────────────────────────────────

/**
 * 사업부의 스크린샷 설정 전체를 교체합니다.
 *
 * ─ 저장 방식 ──────────────────────────────────────────────────────────────
 *  JSONB 병합 연산자(||)로 screenshotTargets 키만 교체합니다.
 *  기존 system_configs 의 다른 키(systems 등)는 보존됩니다.
 *
 * @param divisionId  divisions.id
 * @param targets     저장할 설정 배열 (전체 교체)
 */
export async function saveScreenshotConfig(
  divisionId: string,
  targets:    ScreenshotTargetConfig[]
): Promise<DivisionScreenshotConfig> {
  // 대상 사업부 조회
  const rows = await query<{ code: string }>(
    "SELECT code FROM divisions WHERE id = $1",
    [divisionId]
  );
  if (!rows.length) throw new AppError(404, "사업부를 찾을 수 없습니다.");

  const divisionCode = rows[0].code as DivisionCode;
  const serialized   = serializeTargets(targets);

  await query(
    `UPDATE divisions
     SET system_configs = system_configs || jsonb_build_object('screenshotTargets', $1::jsonb)
     WHERE id = $2`,
    [JSON.stringify(serialized), divisionId]
  );

  return { divisionCode, targets: serialized };
}

/**
 * 특정 시스템의 스크린샷 설정만 부분 업데이트합니다.
 *
 * 나머지 시스템 항목은 현재 DB 값(또는 코드 기본값)을 유지합니다.
 *
 * @param divisionId  divisions.id
 * @param systemName  수정할 시스템 이름 (CrawlerFactory 레지스트리 키)
 * @param patch       변경할 필드만 포함한 부분 객체
 */
export async function patchScreenshotTarget(
  divisionId: string,
  systemName: string,
  patch:      Partial<Omit<ScreenshotTargetConfig, "systemName" | "captureAfterLogin">>
): Promise<ScreenshotTargetConfig> {
  const current = await getScreenshotConfigByDivisionId(divisionId);

  const idx = current.targets.findIndex((t) => t.systemName === systemName);
  if (idx === -1) {
    throw new AppError(404, `시스템을 찾을 수 없습니다: ${systemName}`);
  }

  const updated: ScreenshotTargetConfig[] = current.targets.map((t) =>
    t.systemName === systemName
      ? { ...t, ...patch, captureAfterLogin: true }
      : t
  );

  await saveScreenshotConfig(divisionId, updated);
  return updated[idx];
}

/**
 * DB 에 저장된 스크린샷 설정을 코드 기본값으로 초기화합니다.
 * screenshotTargets 키를 제거하여 코드 기본값이 사용되도록 합니다.
 */
export async function resetScreenshotConfig(divisionId: string): Promise<void> {
  const rows = await query<{ id: string }>(
    "SELECT id FROM divisions WHERE id = $1",
    [divisionId]
  );
  if (!rows.length) throw new AppError(404, "사업부를 찾을 수 없습니다.");

  await query(
    `UPDATE divisions
     SET system_configs = system_configs - 'screenshotTargets'
     WHERE id = $1`,
    [divisionId]
  );
}

// ── 유틸리티 ──────────────────────────────────────────────────────────────────

/**
 * 모든 사업부의 코드 기본값을 반환합니다 (DB 미조회).
 * 관리 화면의 "기본값으로 되돌리기" 미리보기에 사용합니다.
 */
export function getDefaultConfigs(): typeof DEFAULT_SCREENSHOT_CONFIGS {
  return DEFAULT_SCREENSHOT_CONFIGS;
}
