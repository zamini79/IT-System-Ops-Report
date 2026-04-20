/**
 * 예측 가능한 운영 오류.
 * statusCode를 명시하면 글로벌 에러 핸들러가 해당 HTTP 상태로 응답합니다.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}
