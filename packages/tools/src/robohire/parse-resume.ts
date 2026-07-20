/**
 * parseResumeApi — wraps POST /api/v1/parse-resume on the real RoboHire.io
 * API. Turns a candidate's resume (raw PDF bytes via base64 OR a fetchable
 * URL) into structured candidate data downstream agents can score.
 *
 * Transport (probed 2026-05-27 against the live host):
 *   - The endpoint is `multipart/form-data` ONLY. JSON body returns
 *     `400 "PDF file is required"`. The multipart field MUST be named
 *     `file`; `pdf` and `resume` both return 500.
 *
 * Input contract (one of):
 *   {
 *     resume_base64: string,    // base64-encoded PDF bytes
 *     filename?:     string,    // optional; used as the upload filename
 *     mime?:         string,    // optional content-type hint
 *   }
 *   OR
 *   {
 *     resume_url: string,       // fetchable URL we'll download once before
 *                               // forwarding the bytes to RoboHire.
 *   }
 *   OR no args — the tool falls back to ctx.lastResult (typically the
 *   output of objectStore.getObject / fs.readFromInbox / readResumeFromDisk in the immediately
 *   preceding tool step). This avoids round-tripping a 4 KB base64 string
 *   through the LLM, which corrupts it (observed against Haiku 4.5).
 *
 * `resume_text` is intentionally NOT supported here — the upstream rejects
 * it. Use a separate text-to-pdf pipeline if you only have plain text.
 *
 * Per-tenant configuration (confirmed integration profile):
 *   { api_key_env: string, base_url_env: string, timeout_ms?: number }
 * Both required strings are environment-variable names. Literal credentials,
 * literal endpoints and implicit global fallbacks are rejected by rest-helper.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

import { rhBaseUrl, rhAuthToken, rhTimeoutMs } from "./rest-helper";

const PARSE_RESUME_FIELD = "file";
const DEFAULT_FILENAME = "resume.pdf";
const DEFAULT_MIME = "application/pdf";

interface ResumeBytes {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  mime: string;
}

export type ParseResumeFailureKind =
  | "dependency_degradation"
  | "document_failure"
  | "upstream_rejection";

export type ParseResumeFailureCode =
  | "parse_resume_dependency_degradation"
  | "parse_resume_document_failure"
  | "parse_resume_upstream_rejected";

/**
 * Stable error facts consumed by the runtime's generic error-policy ladder.
 * A nominal HTTP 2xx with no parsed resume is a retryable provider
 * degradation. Only explicit evidence about the document itself is terminal.
 */
export class ParseResumeApiError extends Error {
  readonly terminal: boolean;

  constructor(
    readonly kind: ParseResumeFailureKind,
    readonly code: ParseResumeFailureCode,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = "ParseResumeApiError";
    this.terminal = !retryable;
  }
}

export type ResumeContentKind =
  | "raw_text"
  | "name"
  | "contact"
  | "experience"
  | "education"
  | "skills";

interface PayloadCandidate {
  record: Record<string, unknown>;
  depth: number;
  hasWrapperChild: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const normalizedKey = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const PLACEHOLDER_TEXT =
  /^(?:n[./]?a|none|null|undefined|unknown|untitled|not\s+(?:available|provided)|unavailable|no\s+data|empty|\[\]|\{\}|-+)$/i;

function usableText(value: unknown, minimumLength = 1): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  return candidate.length >= minimumLength && !PLACEHOLDER_TEXT.test(candidate);
}

function hasSubstantiveValue(value: unknown, depth = 0): boolean {
  if (depth > 4 || value == null) return false;
  if (typeof value === "string") return usableText(value);
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (Array.isArray(value)) {
    return value.some((item) => hasSubstantiveValue(item, depth + 1));
  }
  const record = asRecord(value);
  return record
    ? Object.values(record).some((item) => hasSubstantiveValue(item, depth + 1))
    : false;
}

const CONTENT_FIELDS: Readonly<Record<ResumeContentKind, ReadonlySet<string>>> = {
  raw_text: new Set([
    "rawtext",
    "rawresume",
    "resumetext",
    "parsedtext",
    "parsedcontent",
    "extractedtext",
    "plaintext",
    "fulltext",
    "summary",
    "profilesummary",
    "professionalsummary",
    "objective",
  ]),
  name: new Set(["name", "fullname", "candidatename", "applicantname"]),
  contact: new Set([
    "email",
    "emailaddress",
    "phone",
    "phonenumber",
    "mobile",
    "mobilenumber",
    "telephone",
    "contact",
    "contactinfo",
    "contactdetails",
    "linkedin",
    "website",
    "github",
  ]),
  experience: new Set([
    "experience",
    "experiences",
    "workexperience",
    "workexperiences",
    "professionalexperience",
    "employment",
    "employmenthistory",
    "workhistory",
  ]),
  education: new Set([
    "education",
    "educations",
    "educationhistory",
    "academicbackground",
    "academicexperience",
    "qualifications",
  ]),
  skills: new Set([
    "skill",
    "skills",
    "skillset",
    "technicalskills",
    "competencies",
    "technologies",
    "certification",
    "certifications",
    "certificate",
    "certificates",
    "languages",
  ]),
};

const WRAPPER_FIELDS = new Set([
  "data",
  "result",
  "payload",
  "response",
  "output",
  "document",
  "resume",
  "resumedata",
  "parsedresume",
  "parsed",
  "extracted",
  "extraction",
  "candidate",
  "candidatedata",
]);

function substantiveResumeFields(
  record: Record<string, unknown>,
): ResumeContentKind[] {
  const found = new Set<ResumeContentKind>();
  for (const [rawKey, value] of Object.entries(record)) {
    const key = normalizedKey(rawKey);
    for (const [kind, fields] of Object.entries(CONTENT_FIELDS) as Array<
      [ResumeContentKind, ReadonlySet<string>]
    >) {
      if (!fields.has(key)) continue;
      const useful =
        kind === "raw_text"
          ? usableText(value, 8)
          : kind === "name"
            ? usableText(value)
            : hasSubstantiveValue(value);
      if (useful) found.add(kind);
    }
  }
  return [...found];
}

function collectPayloadCandidates(
  value: unknown,
  candidates: PayloadCandidate[],
  seen: Set<unknown>,
  depth = 0,
): void {
  if (depth > 8 || value == null || seen.has(value)) return;
  if (typeof value === "object") seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPayloadCandidates(item, candidates, seen, depth + 1);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const wrapperChildren = Object.entries(record)
    .filter(([key, child]) => {
      if (!WRAPPER_FIELDS.has(normalizedKey(key))) return false;
      return asRecord(child) !== null || Array.isArray(child);
    })
    .map(([, child]) => child);
  // Deepest wrapper wins. This turns { data: { result: <resume> } } into the
  // same public payload shape as an unwrapped <resume> response. Once a
  // record already has substantive resume fields, nested objects are content
  // sections rather than transport envelopes and must not replace the record.
  const ownContent = substantiveResumeFields(record);
  if (
    ownContent.length === 0 ||
    ownContent.every((kind) => kind === "name")
  ) {
    for (const child of wrapperChildren) {
      collectPayloadCandidates(child, candidates, seen, depth + 1);
    }
  }
  candidates.push({
    record,
    depth,
    hasWrapperChild: wrapperChildren.length > 0,
  });
}

export function selectResumePayload(value: unknown): {
  payload: Record<string, unknown>;
  content: ResumeContentKind[];
  depth: number;
} | null {
  const candidates: PayloadCandidate[] = [];
  collectPayloadCandidates(value, candidates, new Set());
  for (const candidate of candidates) {
    const content = substantiveResumeFields(candidate.record);
    if (content.length === 0) continue;
    // An envelope may itself be named (for example { name: "resume-parser",
    // data: {} }). Do not confuse that service label with a candidate name.
    if (
      candidate.hasWrapperChild &&
      content.every((kind) => kind === "name")
    ) {
      continue;
    }
    return { payload: candidate.record, content, depth: candidate.depth };
  }
  return null;
}

const DIAGNOSTIC_FIELDS = new Set([
  "code",
  "errorcode",
  "failurecode",
  "message",
  "errormessage",
  "reason",
  "error",
  "errors",
  "detail",
  "details",
  "status",
  "state",
  "parsestatus",
  "extractionstatus",
]);

const FAILURE_CONTAINER_FIELDS = new Set([
  ...WRAPPER_FIELDS,
  "meta",
  "stage",
  "stages",
]);

export function collectDiagnostics(
  value: unknown,
  output: string[] = [],
  seen = new Set<unknown>(),
  depth = 0,
): string[] {
  if (depth > 8 || value == null || seen.has(value)) return output;
  if (typeof value === "object") seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectDiagnostics(item, output, seen, depth + 1);
    return output;
  }
  const record = asRecord(value);
  if (!record) return output;
  for (const [rawKey, child] of Object.entries(record)) {
    if (DIAGNOSTIC_FIELDS.has(normalizedKey(rawKey))) {
      if (typeof child === "string" && child.trim()) output.push(child.trim());
      else if (typeof child === "number") output.push(String(child));
    }
    const key = normalizedKey(rawKey);
    if (
      child !== null &&
      typeof child === "object" &&
      (DIAGNOSTIC_FIELDS.has(key) || FAILURE_CONTAINER_FIELDS.has(key))
    ) {
      collectDiagnostics(child, output, seen, depth + 1);
    }
  }
  return [...new Set(output)];
}

export function hasExplicitFailure(
  value: unknown,
  seen = new Set<unknown>(),
  depth = 0,
): boolean {
  if (depth > 8 || value == null || seen.has(value)) return false;
  if (typeof value === "object") seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasExplicitFailure(item, seen, depth + 1));
  }
  const record = asRecord(value);
  if (!record) return false;
  for (const [rawKey, child] of Object.entries(record)) {
    const key = normalizedKey(rawKey);
    if ((key === "success" || key === "ok") && child === false) return true;
    if (
      ["status", "state", "parsestatus", "extractionstatus"].includes(key) &&
      typeof child === "string" &&
      /^(?:failed|failure|error|degraded|rejected|unsupported|unparseable|unparsable)$/i.test(
        child.trim(),
      )
    ) {
      return true;
    }
    if ((key === "error" || key === "errors") && hasSubstantiveValue(child)) {
      return true;
    }
    if (
      child !== null &&
      typeof child === "object" &&
      FAILURE_CONTAINER_FIELDS.has(key) &&
      hasExplicitFailure(child, seen, depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

export function terminalDocumentEvidence(diagnostics: readonly string[]): string | null {
  for (const diagnostic of diagnostics) {
    const value = diagnostic.trim();
    const token = value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (
      /^(?:error_)?(?:unparseable|unparsable)(?:_(?:document|file|pdf|resume))?$/.test(
        token,
      ) ||
      /^(?:unsupported_(?:document|file|file_type|format|mime|pdf|resume)|scanned_(?:document|file|pdf|resume)|image_only_(?:document|file|pdf|resume)|no_extractable_text|ocr_required|password_protected)$/.test(
        token,
      ) ||
      /(?:unsupported|unparseable|unparsable)[\s_-]*(?:document|file|file type|format|mime|pdf|resume)/i.test(
        value,
      ) ||
      /(?:document|file|pdf|resume)[\s_-]*(?:is\s+)?(?:unsupported|unparseable|unparsable)/i.test(
        value,
      ) ||
      /(?:cannot|can't|unable to|failed to)\s+(?:read|extract|parse)[^\n]{0,80}(?:document|file|pdf|resume)/i.test(
        value,
      ) ||
      /(?:no|without)\s+(?:extractable|readable|machine-readable)\s+text/i.test(
        value,
      ) ||
      /(?:no\s+text[^\n]{0,80}extract|extract[^\n]{0,80}no\s+text)/i.test(
        value,
      ) ||
      /could(?:n['’]?t|\s+not)\s+extract[^\n]{0,80}(?:text|document|file|pdf|resume)/i.test(
        value,
      ) ||
      /(?:corrupt|corrupted)\s+(?:document|file|pdf|resume)/i.test(value) ||
      /(?:image[\s-]*only|scanned)[^\n]{0,80}(?:unsupported|cannot|unable|no\s+(?:extractable|readable)\s+text|ocr\s+required)/i.test(
        value,
      ) ||
      /password[\s-]*protected[^\n]{0,40}(?:document|file|pdf|resume)?/i.test(
        value,
      ) ||
      /扫描件|不支持的?(?:文档|文件|格式)|(?:无法|不能|不可)解析(?:文档|文件|简历)|无可提取(?:文本|文字)|密码保护(?:文档|文件|PDF)?/i.test(
        value,
      )
    ) {
      return value.slice(0, 240);
    }
  }
  return null;
}

export function failureDetails(
  upstreamStatus: number,
  diagnostics: readonly string[],
): Record<string, unknown> {
  return {
    upstreamStatus,
    diagnostics: diagnostics.slice(0, 5).map((item) => item.slice(0, 240)),
  };
}

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  // `Buffer.from(..., 'base64')` returns a Buffer whose underlying
  // ArrayBuffer can be a pooled SharedArrayBuffer slice — `new Blob([buf])`
  // then trips the lib.dom Blob typings (which only accept regular
  // ArrayBuffer-backed views). Copy bytes into a fresh ArrayBuffer-backed
  // Uint8Array so the value satisfies BlobPart.
  const buf = Buffer.from(b64, "base64");
  const ab = new ArrayBuffer(buf.byteLength);
  const view = new Uint8Array(ab);
  view.set(buf);
  return view;
}

async function fetchUrl(url: string, timeoutMs: number): Promise<ResumeBytes> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(
        `parseResumeApi: GET ${url} failed: ${res.status} ${res.statusText}`,
      );
    }
    const downloaded = await res.arrayBuffer();
    const ab = new ArrayBuffer(downloaded.byteLength);
    const buf = new Uint8Array(ab);
    buf.set(new Uint8Array(downloaded));
    let filename = DEFAULT_FILENAME;
    try {
      const u = new URL(url);
      const last = u.pathname.split("/").filter(Boolean).pop();
      if (last && last.length > 0) filename = last;
    } catch {
      /* keep default */
    }
    const mime = res.headers.get("content-type") ?? DEFAULT_MIME;
    return { bytes: buf, filename, mime };
  } finally {
    clearTimeout(timer);
  }
}

export const parseResumeApi = defineTool({
  name: "parseResumeApi",
  description:
    "Call RoboHire.io POST /api/v1/parse-resume to turn a resume PDF into " +
    "structured candidate data. Pass {resume_base64, filename?, mime?} OR " +
    "{resume_url} OR no args (will chain from the previous tool's output, " +
    "e.g. objectStore.getObject or fs.readFromInbox). The wrapper handles multipart encoding so the " +
    "caller stays in JSON-shaped input. It unwraps common response envelopes, " +
    "requires substantive parsed content, and exposes typed retryable versus " +
    "terminal failures instead of trusting HTTP 2xx alone.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const raw = (ctx.event?.data ?? {}) as Record<string, unknown>;

    let payload: ResumeBytes;
    if (typeof raw.resume_base64 === "string" && raw.resume_base64.length > 0) {
      payload = {
        bytes: decodeBase64(raw.resume_base64),
        filename:
          typeof raw.filename === "string" && raw.filename.length > 0
            ? raw.filename
            : DEFAULT_FILENAME,
        mime:
          typeof raw.mime === "string" && raw.mime.length > 0
            ? raw.mime
            : DEFAULT_MIME,
      };
    } else if (typeof raw.resume_url === "string" && raw.resume_url.length > 0) {
      payload = await fetchUrl(raw.resume_url, rhTimeoutMs(ctx));
    } else {
      // Last-resort: harvest from the previous tool's output. We accept
      // the objectStore.getObject / fs.readFromInbox / readResumeFromDisk shape
      // `{ base64, filename, mime, ... }`. Removes the need for the LLM
      // to echo a 4 KB base64 string between two tool_use blocks (which
      // Haiku 4.5 reliably corrupts on inputs of this size).
      const prev = (ctx.lastResult ?? null) as Record<string, unknown> | null;
      const prevB64 =
        prev && typeof prev.base64 === "string" ? (prev.base64 as string) : "";
      if (!prev || prevB64.length === 0) {
        throw new Error(
          "parseResumeApi: no input. Pass {resume_base64, filename?, mime?} " +
            "or {resume_url}, OR call objectStore.getObject/fs.readFromInbox in the immediately " +
            "previous tool step so this handler can pick up the bytes from " +
            "lastResult (preferred for PDF intake — avoids round-tripping " +
            "a 4 KB base64 string through the LLM, which corrupts it).",
        );
      }
      payload = {
        bytes: decodeBase64(prevB64),
        filename:
          typeof prev.filename === "string" && (prev.filename as string).length > 0
            ? (prev.filename as string)
            : DEFAULT_FILENAME,
        mime:
          typeof prev.mime === "string" && (prev.mime as string).length > 0
            ? (prev.mime as string)
            : DEFAULT_MIME,
      };
    }

    const url = `${rhBaseUrl(ctx)}/parse-resume`;
    const form = new FormData();
    form.append(
      PARSE_RESUME_FIELD,
      new Blob([payload.bytes], { type: payload.mime }),
      payload.filename,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), rhTimeoutMs(ctx));
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        // Authorization only — DO NOT set Content-Type ourselves; the
        // runtime needs to generate the multipart boundary header.
        headers: { Authorization: `Bearer ${rhAuthToken(ctx)}` },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      throw new ParseResumeApiError(
        "dependency_degradation",
        "parse_resume_dependency_degradation",
        `parseResumeApi: request failed — ${err instanceof Error ? err.message : String(err)}`,
        502,
        true,
        undefined,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    const responseText = await res.text();
    let parsed: unknown;
    let parsedJson = false;
    if (responseText.trim().length > 0) {
      try {
        parsed = JSON.parse(responseText);
        parsedJson = true;
      } catch {
        parsed = undefined;
      }
    }

    const diagnostics = parsedJson
      ? collectDiagnostics(parsed)
      : responseText.trim()
        ? [responseText.trim().slice(0, 500)]
        : [];
    const terminalEvidence = terminalDocumentEvidence(diagnostics);

    if (!res.ok) {
      if (terminalEvidence) {
        throw new ParseResumeApiError(
          "document_failure",
          "parse_resume_document_failure",
          `parseResumeApi: document cannot be parsed — ${terminalEvidence}`,
          422,
          false,
          failureDetails(res.status, diagnostics),
        );
      }
      const retryable = res.status === 429 || res.status >= 500;
      throw new ParseResumeApiError(
        retryable ? "dependency_degradation" : "upstream_rejection",
        retryable
          ? "parse_resume_dependency_degradation"
          : "parse_resume_upstream_rejected",
        `parseResumeApi: RoboHire returned HTTP ${res.status}`,
        retryable ? 502 : res.status,
        retryable,
        failureDetails(res.status, diagnostics),
      );
    }

    if (!parsedJson) {
      if (terminalEvidence) {
        throw new ParseResumeApiError(
          "document_failure",
          "parse_resume_document_failure",
          `parseResumeApi: document cannot be parsed — ${terminalEvidence}`,
          422,
          false,
          failureDetails(res.status, diagnostics),
        );
      }
      throw new ParseResumeApiError(
        "dependency_degradation",
        "parse_resume_dependency_degradation",
        "parseResumeApi: upstream returned an empty or non-JSON success body",
        502,
        true,
        // A non-JSON 2xx body may be raw candidate text rather than a safe
        // provider diagnostic. Do not copy it into the error/audit surface.
        failureDetails(res.status, []),
      );
    }

    const selected = selectResumePayload(parsed);
    const explicitFailure = hasExplicitFailure(parsed);
    if (terminalEvidence && (explicitFailure || !selected)) {
      throw new ParseResumeApiError(
        "document_failure",
        "parse_resume_document_failure",
        `parseResumeApi: document cannot be parsed — ${terminalEvidence}`,
        422,
        false,
        failureDetails(res.status, diagnostics),
      );
    }
    if (!selected || explicitFailure) {
      throw new ParseResumeApiError(
        "dependency_degradation",
        "parse_resume_dependency_degradation",
        explicitFailure
          ? "parseResumeApi: upstream reported a degraded parse without a usable success result"
          : "parseResumeApi: upstream returned no usable parsed resume content",
        502,
        true,
        failureDetails(res.status, diagnostics),
      );
    }

    return {
      data: selected.payload,
      meta: {
        provider: "robohire.io",
        endpoint: "POST /api/v1/parse-resume (multipart)",
        upstreamStatus: res.status,
        filename: payload.filename,
        bytes: payload.bytes.length,
        responseWrapped: selected.depth > 0,
        validatedContent: selected.content,
      },
    };
  },
});
