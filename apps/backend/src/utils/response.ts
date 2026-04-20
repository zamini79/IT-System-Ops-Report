import { Response } from "express";

// ── 공통 응답 타입 ─────────────────────────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?:   T;
  message?: string;
  error?:  string;
}

export interface PageMeta {
  total:      number;
  page:       number;
  limit:      number;
  totalPages: number;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: PageMeta;
}

// ── 응답 헬퍼 ─────────────────────────────────────────────────────────────────
export const respond = {
  /** 200 OK */
  ok<T>(res: Response, data?: T, message?: string): void {
    const body: ApiResponse<T> = { success: true };
    if (data    !== undefined) body.data    = data;
    if (message !== undefined) body.message = message;
    res.json(body);
  },

  /** 201 Created */
  created<T>(res: Response, data?: T, message?: string): void {
    const body: ApiResponse<T> = { success: true };
    if (data    !== undefined) body.data    = data;
    if (message !== undefined) body.message = message;
    res.status(201).json(body);
  },

  /** 200 OK — 페이지네이션 */
  paginated<T>(
    res:   Response,
    items: T[],
    total: number,
    page:  number,
    limit: number
  ): void {
    const body: PaginatedResponse<T> = {
      success: true,
      data:    items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
    res.json(body);
  },

  /** 204 No Content */
  noContent(res: Response): void {
    res.status(204).send();
  },
};
