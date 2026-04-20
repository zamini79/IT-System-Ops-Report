/**
 * @deprecated 새 코드에서는 modules/auth/auth.guard 를 직접 import하세요.
 * 이 파일은 기존 routes/reports.ts 와의 호환성을 위해 유지됩니다.
 */
export {
  authGuard as authenticate,
  divisionGuard as authorize,
  AuthRequest,
} from "../modules/auth/auth.guard";

export type { AccessPayload as AuthPayload } from "../modules/auth/auth.types";
