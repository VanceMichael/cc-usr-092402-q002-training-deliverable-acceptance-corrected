export class DomainError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (code, message, details) => new DomainError(code, message, { status: 400, details });
export const unauthorized = (code = "unauthorized", message = "缺少有效操作者") =>
  new DomainError(code, message, { status: 401 });
export const forbidden = (code, message, details) => new DomainError(code, message, { status: 403, details });
export const notFound = (resource, id) =>
  new DomainError("not_found", `${resource} 不存在：${id ?? ""}`.trim(), { status: 404 });
export const conflict = (code, message, details) => new DomainError(code, message, { status: 409, details });

/** 把 SQLite 约束错误转成 409，其余原样抛出 */
export function rethrowUnique(e, code, message) {
  if (String(e.message).includes("UNIQUE constraint failed") || String(e.message).includes("constraint")) {
    throw conflict(code, message);
  }
  throw e;
}
