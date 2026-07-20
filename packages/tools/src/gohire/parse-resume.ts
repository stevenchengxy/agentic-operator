/**
 * gohireParseResumeApi — POST {base}/parse-resume on the GoHire ATS API.
 * Canonical implementation for recruitment resume parsing; the legacy
 * `parseResumeApi` / `gohire.parseResume` names alias here.
 *
 * TRANSPORT QUIRK (probed 2026-05-27 against the live host): the endpoint is
 * `multipart/form-data` ONLY. A JSON body returns `400 "PDF file is
 * required"`, and the multipart field MUST be named `file` (`pdf` and
 * `resume` both return 500). This wrapper always sends FormData + Blob with
 * the `file` field, and harvests PDF bytes from `ctx.lastResult` (typically
 * fs.readFromInbox / objectStore.getObject) so the LLM never round-trips a
 * multi-KB base64 string between tool calls (which corrupts it).
 *
 * RESPONSE CONTRACT (shared with the RoboHire wrapper — one validation core
 * in ../robohire/parse-resume): a nominal HTTP 2xx succeeds only when it
 * contains substantive parsed resume content. Common `{data}`/`{result}`
 * envelopes are unwrapped at the right depth; empty or degraded responses
 * are typed retryable dependency failures, and explicit unsupported /
 * unparseable-document evidence is terminal. Never trust HTTP 200 alone.
 *
 * Input (one of): {resume_base64, filename?, mime?} | {resume_url} | no args.
 * Credential / base-URL resolution: see rest-helper.ts.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

import {
  ParseResumeApiError,
  collectDiagnostics,
  failureDetails,
  hasExplicitFailure,
  selectResumePayload,
  terminalDocumentEvidence,
} from "../robohire/parse-resume";
import { ghBaseUrl, ghAuthToken, ghTimeoutMs } from "./rest-helper";

const PARSE_RESUME_FIELD = "file";
const DEFAULT_FILENAME = "resume.pdf";
const DEFAULT_MIME = "application/pdf";

interface ResumeBytes {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  mime: string;
}

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
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
        `gohireParseResumeApi: GET ${url} failed: ${res.status} ${res.statusText}`,
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

export const gohireParseResumeApi = defineTool({
  name: "gohireParseResumeApi",
  description:
    "Call GoHire POST /parse-resume to turn a resume PDF into structured " +
    "candidate data. Pass {resume_base64, filename?, mime?} OR {resume_url} " +
    "OR no args (chains from the previous tool's output, e.g. fs.readFromInbox). " +
    "The wrapper handles multipart encoding, unwraps common response envelopes, " +
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
      payload = await fetchUrl(raw.resume_url, ghTimeoutMs(ctx));
    } else {
      const prev = (ctx.lastResult ?? null) as Record<string, unknown> | null;
      const prevB64 =
        prev && typeof prev.base64 === "string" ? (prev.base64 as string) : "";
      if (!prev || prevB64.length === 0) {
        throw new Error(
          "gohireParseResumeApi: no input. Pass {resume_base64, filename?, mime?} " +
            "or {resume_url}, OR call fs.readFromInbox/objectStore.getObject in the " +
            "immediately previous tool step so this handler can pick up the bytes " +
            "from lastResult (preferred for PDF intake — avoids round-tripping " +
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

    const url = `${ghBaseUrl(ctx)}/parse-resume`;
    const form = new FormData();
    form.append(
      PARSE_RESUME_FIELD,
      new Blob([payload.bytes], { type: payload.mime }),
      payload.filename,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ghTimeoutMs(ctx));
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        // Authorization only — let the runtime set the multipart boundary.
        headers: { Authorization: `Bearer ${ghAuthToken(ctx)}` },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      throw new ParseResumeApiError(
        "dependency_degradation",
        "parse_resume_dependency_degradation",
        `gohireParseResumeApi: request failed — ${err instanceof Error ? err.message : String(err)}`,
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
          `gohireParseResumeApi: document cannot be parsed — ${terminalEvidence}`,
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
        `gohireParseResumeApi: GoHire returned HTTP ${res.status}`,
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
          `gohireParseResumeApi: document cannot be parsed — ${terminalEvidence}`,
          422,
          false,
          failureDetails(res.status, diagnostics),
        );
      }
      throw new ParseResumeApiError(
        "dependency_degradation",
        "parse_resume_dependency_degradation",
        "gohireParseResumeApi: upstream returned an empty or non-JSON success body",
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
        `gohireParseResumeApi: document cannot be parsed — ${terminalEvidence}`,
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
          ? "gohireParseResumeApi: upstream reported a degraded parse without a usable success result"
          : "gohireParseResumeApi: upstream returned no usable parsed resume content",
        502,
        true,
        failureDetails(res.status, diagnostics),
      );
    }

    return {
      data: selected.payload,
      meta: {
        provider: "gohire",
        endpoint: "POST /parse-resume (multipart)",
        upstreamStatus: res.status,
        filename: payload.filename,
        bytes: payload.bytes.length,
        responseWrapped: selected.depth > 0,
        validatedContent: selected.content,
      },
    };
  },
});
