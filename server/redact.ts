// Che secret trước khi bất kỳ chuỗi nào rời server. Mẫu cố ý rộng.
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const KEY_VALUE = /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth|bearer|cookie|mật khẩu)["']?\s*[:=]\s*["']?)([^\s"',;}{]{4,})/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi;
export const MASK = '••••';

export function redact(input: string): string {
  let output = input;
  for (const pattern of TOKEN_PATTERNS) output = output.replace(pattern, MASK);
  return output
    .replace(KEY_VALUE, (_match, key: string) => `${key}${MASK}`)
    .replace(BEARER, (_match, prefix: string) => `${prefix}${MASK}`)
    .replace(URL_CREDENTIALS, (_match, head: string, at: string) => `${head}${MASK}${at}`);
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)])) as T;
  }
  return value;
}
