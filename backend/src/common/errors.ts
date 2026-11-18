export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "TOKEN_EXPIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VERSION_CONFLICT"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "ASSET_NOT_AVAILABLE"
  | "RIGHTS_NOT_GRANTED"
  | "MIX_PLAN_INVALID"
  | "AI_UNAVAILABLE"
  | "MEDIA_URL_EXPIRED"
  | "NOT_IMPLEMENTED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  ASSET_NOT_AVAILABLE: 403,
  RIGHTS_NOT_GRANTED: 403,
  MIX_PLAN_INVALID: 422,
  AI_UNAVAILABLE: 503,
  MEDIA_URL_EXPIRED: 410,
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
};

const RETRYABLE = new Set<ErrorCode>(["RATE_LIMITED", "AI_UNAVAILABLE", "INTERNAL", "MEDIA_URL_EXPIRED"]);

export class ApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
    this.retryable = RETRYABLE.has(code);
  }
}

export const notFound = (what = "Resource") => new ApiError("NOT_FOUND", `${what} not found.`);
export const badRequest = (msg: string, details?: unknown) => new ApiError("VALIDATION_FAILED", msg, details);

export function errorEnvelope(err: ApiError, requestId: string) {
  return {
    error: {
      code: err.code,
      message: err.message,
      requestId,
      retryable: err.retryable,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  };
}
