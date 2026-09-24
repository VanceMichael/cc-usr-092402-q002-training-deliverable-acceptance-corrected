import crypto from "node:crypto";

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function epoch(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new TypeError(`非法时间：${iso}`);
  return t;
}

export function assertIso(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} 必须是 ISO-8601 时间`);
  }
  return value;
}

export function addHours(iso, hours) {
  return new Date(epoch(iso) + Math.round(hours * 3600_000)).toISOString();
}

/** 返回某 IANA 时区在给定瞬间相对 UTC 的偏移分钟（例如 Asia/Shanghai = 480） */
export function tzOffsetMinutes(timeZone, atIso) {
  // 构造一次即可在非法时区时抛错
  new Intl.DateTimeFormat("en-US", { timeZone });
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(epoch(atIso))).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUtc - epoch(atIso)) / 60_000);
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function hashJson(value) {
  return sha256(canonicalJson(value));
}

export function serial() {
  return crypto.randomBytes(8).toString("hex").toUpperCase();
}
