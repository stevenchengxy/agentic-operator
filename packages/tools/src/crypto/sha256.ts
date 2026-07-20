/** Pure, deterministic SHA-256 over utf8, strict base64/hex, or canonical JSON. */

import { createHash } from "node:crypto";
import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";

type JsonRecord = Record<string, unknown>;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const ABSOLUTE_MAX_BYTES = 100 * 1024 * 1024;

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value))
        throw new Error("crypto.sha256 json contains a non-finite number.");
      return JSON.stringify(value);
    case "object": {
      if (seen.has(value))
        throw new Error("crypto.sha256 json contains a cycle.");
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
        }
        const record = value as JsonRecord;
        return `{${Object.keys(record)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`,
          )
          .join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new Error(
        `crypto.sha256 json contains unsupported type '${typeof value}'.`,
      );
  }
}

function strictBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error(
      "crypto.sha256 base64 must be canonical padded standard base64.",
    );
  }
  return Buffer.from(value, "base64");
}

function strictHex(value: string): Buffer {
  if (value.length % 2 !== 0 || !/^[a-fA-F0-9]*$/.test(value)) {
    throw new Error(
      "crypto.sha256 hex must contain an even number of hexadecimal characters.",
    );
  }
  return Buffer.from(value, "hex");
}

export function computeSha256(
  args: JsonRecord,
  config: JsonRecord = {},
): {
  sha256: string;
  bytes: number;
  input_type: "text" | "base64" | "hex" | "json";
} {
  const choices = (["text", "base64", "hex", "json"] as const).filter((name) =>
    Object.prototype.hasOwnProperty.call(args, name),
  );
  if (choices.length !== 1) {
    throw new Error(
      "crypto.sha256 requires exactly one of text, base64, hex, or json.",
    );
  }
  const inputType = choices[0]!;
  let bytes: Buffer;
  if (inputType === "text") {
    if (typeof args.text !== "string")
      throw new Error("crypto.sha256 text must be a string.");
    bytes = Buffer.from(args.text, "utf8");
  } else if (inputType === "base64") {
    if (typeof args.base64 !== "string")
      throw new Error("crypto.sha256 base64 must be a string.");
    bytes = strictBase64(args.base64);
  } else if (inputType === "hex") {
    if (typeof args.hex !== "string")
      throw new Error("crypto.sha256 hex must be a string.");
    bytes = strictHex(args.hex);
  } else {
    bytes = Buffer.from(canonicalJson(args.json), "utf8");
  }
  const configuredMax = config.max_bytes ?? DEFAULT_MAX_BYTES;
  if (
    !Number.isSafeInteger(configuredMax) ||
    (configuredMax as number) <= 0 ||
    (configuredMax as number) > ABSOLUTE_MAX_BYTES
  ) {
    throw new Error(
      `crypto.sha256 config.max_bytes must be between 1 and ${ABSOLUTE_MAX_BYTES}.`,
    );
  }
  if (bytes.length > (configuredMax as number)) {
    throw new Error(
      `crypto.sha256 input exceeds the configured ${configuredMax as number}-byte limit.`,
    );
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    input_type: inputType,
  };
}

export const cryptoSha256 = defineTool({
  name: "crypto.sha256",
  description:
    "Pure deterministic SHA-256 over exactly one of {text, base64, hex, json}. JSON is canonicalized by recursively sorting object keys.",
  output: z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    input_type: z.enum(["text", "base64", "hex", "json"]),
  }),
  async handler(ctx) {
    return {
      data: computeSha256(
        (ctx.event?.data ?? {}) as JsonRecord,
        (ctx.config ?? {}) as JsonRecord,
      ),
      meta: { deterministic: true, algorithm: "sha256" },
    };
  },
});
