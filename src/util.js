import crypto from "node:crypto";

export const newId = (prefix = "id") =>
  `${prefix}_${crypto.randomBytes(10).toString("hex")}`;

export const nowIso = () => new Date().toISOString();

// 领域错误：携带稳定 code，HTTP 层据此映射状态码。
export class DomainError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    Object.assign(this, extra);
  }
}

export const requireFields = (body, fields) => {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === "") {
      throw new DomainError("VALIDATION", `缺少必填字段: ${f}`);
    }
  }
};

// 将 ISO 字符串与可选偏移量一并规整为 UTC ISO。
// 输入可以是 UTC ISO，或本地时间 + 来源时区偏移（分钟，东八区=480）。
export function toUtcIso(value, offsetMinutes = 0) {
  if (value === undefined || value === null) return null;
  const asIs = new Date(value);
  if (!Number.isNaN(asIs.getTime()) && /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    return asIs.toISOString();
  }
  // 不带时区信息的“墙上时间”，按给定偏移解释。
  const guess = new Date(value);
  if (Number.isNaN(guess.getTime())) {
    throw new DomainError("VALIDATION", `无法解析时间: ${value}`);
  }
  return new Date(guess.getTime() - offsetMinutes * 60_000).toISOString();
}

// 校验时区标识（IANA）或显式偏移；仅做轻量校验。
export function normalizeTz(tz) {
  if (!tz) return "UTC";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    throw new DomainError("VALIDATION", `不支持的时区: ${tz}`);
  }
}

export const sha256 = (text) =>
  crypto.createHash("sha256").update(text, "utf8").digest("hex");
