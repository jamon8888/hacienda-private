export type AppErrorCode =
  | "auth"
  | "not_found"
  | "scope"
  | "consent"
  | "store"
  | "model"
  | "bad_request";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  auth: 401,
  not_found: 404,
  scope: 403,
  consent: 403,
  store: 500,
  model: 503,
  bad_request: 400,
};

export class AppError extends Error {
  public readonly code: AppErrorCode;
  public readonly status: number;

  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }

  toJSON(): { error: string; code: AppErrorCode; message: string } {
    return { error: this.name, code: this.code, message: this.message };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
