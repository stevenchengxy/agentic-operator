const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const SECRET_KEY = /^(?:api_key|access_key|private_key|secret_key|client_key|key|access_token|refresh_token|token|authorization|authorization_header|auth|auth_header|bearer|bearer_token|password|passwd|secret|cookie|credential|credentials|session|session_id)$/i;
const SECRET_KEY_PART = /(?:^|_)(?:api_key|access_key|private_key|secret_key|client_key|access_token|refresh_token|authorization|auth|password|passwd|secret|cookie|credential|credentials|session_id|token)(?:$|_)/i;
const SAFE_DIGEST_TOKEN = /^(?:authorize_(?:probe|integration_profile|sandbox_design_review):v\d:|decline_(?:integration_profile|sandbox_design_review):v\d:|(?:probe|integration_profile|sandbox_design_review)_authorization:v\d:|consumed_(?:probe|integration_profile|sandbox_design_review)_authorization:v\d:)[a-f0-9]{32,}$/i;
// Angle brackets are not a generic trust boundary: `<real-secret>` must not
// bypass scanning merely because it looks placeholder-ish. Keep only the
// small, explicit placeholder vocabulary produced by our own UI/templates.
const SAFE_PLACEHOLDER = /^(?:\[REDACTED(?:_[A-Z]+)?\]|<(?:REDACTED(?:_[A-Z]+)?|ENV_NAME|ENV:[A-Za-z_][A-Za-z0-9_]*)>|(?:Bearer|Basic)\s+\{[A-Za-z0-9_.-]+\}|\{[A-Za-z0-9_.-]+\})$/i;

const SECRET_VALUE_PATTERNS = [
  /\b(?:Bearer|Basic)\s+(?!\{)[A-Za-z0-9+/_=.:-]{4,}\b/i,
  /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|passwd|secret|credential|cookie|session)\s*[:=]\s*(?!\{|\[REDACTED)[^\s,;"'}]{3,}/i,
  /["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|passwd|secret|credential|cookie|session)["']\s*:\s*["'](?!\{|\[REDACTED)[^"']{3,}["']/i,
] as const;

export const canonicalSensitiveInputKey = (key: string): string => key
  .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
  .replace(/[^a-zA-Z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "")
  .toLowerCase();

export function isSensitiveEnvironmentReferenceField(key: string): boolean {
  const canonical = canonicalSensitiveInputKey(key);
  return canonical.length > 4 && canonical.endsWith("_env");
}

function isSecretKey(key: string): boolean {
  // `~key`, `~0key` and `~1key` are business/JSON-Pointer field names used by
  // fixture-path data. Keep the exemption narrow: `~auth` and `auth~note`
  // must not become ways around the credential detector. Secret-shaped values
  // remain blocked independently by the value scan below.
  if (/^~(?:[01])?key$/i.test(key)) return false;
  const canonical = canonicalSensitiveInputKey(key);
  if (/^authorization_(?:question|context|value)$|^side_effect_summary$/i.test(canonical)) return false;
  return SECRET_KEY.test(canonical) || SECRET_KEY_PART.test(canonical);
}

function isSafeValueForSensitiveKey(key: string, value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (SAFE_PLACEHOLDER.test(text) || SAFE_DIGEST_TOKEN.test(text)) return true;
  return isSensitiveEnvironmentReferenceField(key) && ENV_NAME.test(text);
}

export function isSecretShapedString(value: string): boolean {
  const text = value.trim();
  if (!text || SAFE_PLACEHOLDER.test(text) || SAFE_DIGEST_TOKEN.test(text)) return false;
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

export interface SensitiveInputScan {
  sanitized: unknown;
  paths: string[];
}

export interface SensitiveInputScanOptions {
  /** Narrow schema-owned exception for enum-like fields such as
   * `auth: "anonymous"`. This must never be used to allow arbitrary values;
   * environment references already have their own built-in rule. */
  allowSensitiveField?: (input: { path: string; key: string; value: unknown }) => boolean;
}

/**
 * Recursively redact both secret-named fields and secret-shaped values. This
 * is suitable for untrusted model/API input before it reaches an event,
 * transcript or durable store. Environment reference names and digest-only
 * one-shot authorization tokens are deliberately preserved.
 */
export function sanitizeSensitiveInput(
  value: unknown,
  rootPath = "args",
  options: SensitiveInputScanOptions = {},
): SensitiveInputScan {
  const paths: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (item: unknown, path: string, key = "", depth = 0): unknown => {
    if (depth > 20) return "[REDACTED_DEPTH]";
    const explicitlyAllowed = key
      ? options.allowSensitiveField?.({ path, key, value: item }) === true
      : false;
    if (typeof item === "string") {
      if (!explicitlyAllowed && ((isSecretKey(key) && !isSafeValueForSensitiveKey(key, item)) || isSecretShapedString(item))) {
        paths.push(path);
        return "[REDACTED]";
      }
      return item;
    }
    if (item === null || item === undefined || typeof item !== "object") {
      if (!explicitlyAllowed && isSecretKey(key) && !isSafeValueForSensitiveKey(key, item)) {
        paths.push(path);
        return "[REDACTED]";
      }
      return item;
    }
    if (!explicitlyAllowed && isSecretKey(key) && !isSensitiveEnvironmentReferenceField(key)) {
      paths.push(path);
      return "[REDACTED]";
    }
    if (seen.has(item)) return "[REDACTED_CIRCULAR]";
    seen.add(item);
    if (Array.isArray(item)) {
      return item.map((entry, index) => visit(entry, `${path}[${index}]`, "", depth + 1));
    }
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([childKey, entry]) => [
      childKey,
      visit(entry, `${path}.${childKey}`, childKey, depth + 1),
    ]));
  };
  return { sanitized: visit(value, rootPath), paths: [...new Set(paths)] };
}

export function findSensitiveInputPath(
  value: unknown,
  rootPath = "args",
  options: SensitiveInputScanOptions = {},
): string | undefined {
  return sanitizeSensitiveInput(value, rootPath, options).paths[0];
}
