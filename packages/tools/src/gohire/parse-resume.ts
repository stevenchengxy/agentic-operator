/**
 * gohireParseResumeApi — POST {base}/parse-resume on the GoHire ATS API.
 * Turns a candidate's resume PDF (base64 bytes OR a fetchable URL) into
 * structured candidate data.
 *
 * Mirrors robohire's parseResumeApi transport: multipart/form-data with the
 * file under the `file` field, and a fallback that harvests the PDF bytes
 * from `ctx.lastResult` (typically fs.readFromInbox) so the LLM never has to
 * round-trip a multi-KB base64 string between tool calls (which corrupts it).
 *
 * Input (one of): {resume_base64, filename?, mime?} | {resume_url} | no args.
 * Credential / base-URL resolution: see rest-helper.ts.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

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
    "The wrapper handles multipart encoding. Returns the upstream body under .data.",
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
            "or {resume_url}, OR call fs.readFromInbox in the immediately previous " +
            "tool step so this handler can pick up the bytes from lastResult.",
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
      throw new Error(
        `gohireParseResumeApi: request error — ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep as text */
      }
    }
    if (!res.ok) {
      throw new Error(
        `gohireParseResumeApi: GoHire returned ${res.status} — body=${JSON.stringify(parsed)}`,
      );
    }
    return {
      data: parsed,
      meta: {
        provider: "gohire",
        endpoint: "POST /parse-resume (multipart)",
        upstreamStatus: res.status,
        filename: payload.filename,
        bytes: payload.bytes.length,
      },
    };
  },
});
