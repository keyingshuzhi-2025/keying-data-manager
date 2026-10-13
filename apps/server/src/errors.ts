export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'TOO_MANY_REQUESTS'
  | 'STORAGE_ERROR'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError(400, 'BAD_REQUEST', message, details);
}

export function unauthorized(message = '请先登录'): AppError {
  return new AppError(401, 'UNAUTHORIZED', message);
}

export function forbidden(message = '当前账号无权执行此操作'): AppError {
  return new AppError(403, 'FORBIDDEN', message);
}

export function notFound(resource: string): AppError {
  return new AppError(404, 'NOT_FOUND', `资源不存在: ${resource}`);
}

export function conflict(message: string): AppError {
  return new AppError(409, 'CONFLICT', message);
}

export function payloadTooLarge(message = '文件超过大小限制'): AppError {
  return new AppError(413, 'PAYLOAD_TOO_LARGE', message);
}

export function unsupportedMediaType(message = '不支持的文件类型'): AppError {
  return new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', message);
}

export function tooManyRequests(retryAfterSeconds = 60, message = '请求过于频繁，请稍后再试'): AppError {
  return new AppError(429, 'TOO_MANY_REQUESTS', message, { retryAfterSeconds });
}

export function storageError(message: string, details?: unknown): AppError {
  return new AppError(500, 'STORAGE_ERROR', message, details);
}
