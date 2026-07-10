// #SCALE-BLOB — hand-rolled AWS Signature V4 (node:crypto only, NO aws-sdk). ~80 lines buys the
// entire S3-compatible universe (AWS S3 / Cloudflare R2 / MinIO / Ceph RGW) as a blob backend
// without a multi-MB dependency. Pure function → verifiable against AWS's published test vectors.

import { createHash, createHmac } from "node:crypto";

export interface SigV4Input {
  method: string;
  host: string;
  /** URI path, already URI-encoded per segment (S3 keys here are hex hashes — no special chars). */
  path: string;
  /** canonical query string ("" for none; must be pre-sorted if multiple params). */
  query?: string;
  /** extra headers to sign beyond host/x-amz-date (lowercase keys). */
  headers?: Record<string, string>;
  /** hex sha256 of the request body ("" body → e3b0c442…). */
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** ISO basic timestamp, e.g. 20150830T123600Z. Injectable for the official test vectors. */
  amzDate: string;
}

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

export const EMPTY_PAYLOAD_SHA256 = sha256hex("");

/** Sign a request; returns the headers to send (host, x-amz-date, x-amz-content-sha256 for S3,
 *  optional session token, and the Authorization header). */
export function sigV4Sign(input: SigV4Input): Record<string, string> {
  const dateStamp = input.amzDate.slice(0, 8);
  const baseHeaders: Record<string, string> = {
    host: input.host,
    "x-amz-date": input.amzDate,
    ...(input.service === "s3" ? { "x-amz-content-sha256": input.payloadHash } : {}),
    ...(input.sessionToken ? { "x-amz-security-token": input.sessionToken } : {}),
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
  };
  const signedHeaderNames = Object.keys(baseHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${baseHeaders[k]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path || "/",
    input.query ?? "",
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  // signing key: HMAC chain AWS4<secret> → date → region → service → "aws4_request"
  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    ...baseHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Current time as SigV4 basic-format timestamp (20260702T031500Z). */
export function amzNow(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
