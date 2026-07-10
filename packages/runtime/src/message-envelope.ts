// #COMMS — the inter-agent message envelope + payload assembler.
//
// PROBLEM this solves (verified against the runtime data plane):
//   1. 遗漏数据 (data loss): today an agent's emit carries ONLY `last_result` (its final step's
//      output). Any field that arrived in the trigger — or was produced mid-chain — but that the
//      final step didn't echo is SILENTLY DROPPED. And external triggers put business fields at the
//      TOP LEVEL of event.data while agent emits bury them under `last_result`, so field-precise
//      downstream access breaks across an agent→agent edge.
//   2. context 过大 (bloat): a large blob (e.g. a base64 PDF) sitting in `last_result` rides INLINE
//      across every hop, bloating every event row, NDJSON ledger line and step artifact.
//
// FIX: assembleEmitPayload UNIFIES the emit shape to top-level (carry-forward the incoming business
// fields, overlay this agent's outputs), KEEPS `last_result` for back-compat, stamps `_meta`
// provenance, and OFFLOADS oversized fields to a content-addressed reference (`BlobRef`) via an
// injected offloader — so the wire/storage stays small and each blob is stored once. rehydratePayload
// resolves refs back on the consume side. This module is PURE (offloader + resolver injected) so it's
// unit-testable without disk.

/** A content-addressed reference that replaces an oversized field on the wire. */
export interface BlobRef {
  __ref: "blob";
  hash: string;
  bytes: number;
  contentType?: string;
  /** short human-readable preview for logs / UI (never the full value). */
  preview?: string;
}

export function isBlobRef(x: unknown): x is BlobRef {
  return !!x && typeof x === "object" && (x as BlobRef).__ref === "blob" && typeof (x as BlobRef).hash === "string";
}

/** #P2 — envelope schema version stamped into `_meta.v`. Bump when the wire shape changes so a
 *  migration can handle field removals/renames explicitly (additions are carry-forward-safe). */
export const ENVELOPE_VERSION = 1;

/** Provenance stamped alongside the business fields (kept under `_meta` so it never shadows them). */
export interface EnvelopeMeta {
  subject?: string;
  correlationId?: string;
  /** the event id that CAUSED this emit (the trigger), for lineage. */
  causationId?: string;
  /** the agent that produced this event. */
  producedBy?: string;
  sourceRun?: string;
}

// Wrapper/meta keys that are NOT business fields (so carry-forward doesn't drag them along).
const META_KEYS = new Set([
  "source_agent",
  "source_run",
  "last_result",
  "_meta",
  "__triggerEventId",
  "__correlationId",
  "subject",
]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Extract the BUSINESS fields from an incoming event.data, unifying the two entry shapes:
 *   - external trigger : business fields already at the top level
 *   - legacy agent emit : business fields under `last_result`
 * Returns `{ ...legacyLastResultFields, ...topLevelBusinessFields }` (top-level wins), stripped of
 * meta/wrapper keys. This is what makes carry-forward work across BOTH entry shapes.
 */
export function extractBusinessFields(incoming: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const src = incoming ?? {};
  const out: Record<string, unknown> = {};
  const lr = asRecord(src.last_result);
  if (lr) for (const [k, v] of Object.entries(lr)) if (!k.startsWith("__")) out[k] = v;
  for (const [k, v] of Object.entries(src)) {
    if (META_KEYS.has(k) || k.startsWith("__")) continue;
    out[k] = v;
  }
  return out;
}

export interface AssembleInput {
  /** the trigger event.data this agent received (its inbound context). */
  incoming?: Record<string, unknown>;
  /** this agent's final step output. */
  lastResult?: unknown;
  /** provenance to stamp on the outbound event. */
  meta: EnvelopeMeta;
  /** OPTIONAL declared contract fields (the emit event's event_data) that MUST be present — a
   *  missing one is reported as a data-gap, not silently dropped. */
  contractFields?: string[];
  /** offloader: given (fieldPath, value) return a BlobRef to replace an oversized value, else null.
   *  Injected so the size policy + content-addressed store live outside this pure module. */
  offload?: (fieldPath: string, value: unknown) => BlobRef | null;
}

export interface AssembleResult {
  /** the assembled event.data: top-level business fields + `last_result` (back-compat) + `_meta`. */
  payload: Record<string, unknown>;
  /** incoming business fields carried forward that the final step did NOT echo (would have been lost). */
  carried: string[];
  /** #W1-6 — inbound fields OVERWRITTEN by a same-named (different-valued) producer output. */
  shadowed: string[];
  /** fields replaced by a BlobRef (offloaded). */
  offloaded: string[];
  /** declared contract fields missing from the assembled payload (a data gap). */
  missing: string[];
}

/** Assemble the outbound event payload: carry-forward ⊕ overlay, unify to top-level, offload big
 *  fields, keep last_result, stamp provenance. Pure — no I/O. */
export function assembleEmitPayload(input: AssembleInput): AssembleResult {
  const carriedSource = extractBusinessFields(input.incoming);
  const lrFields = asRecord(input.lastResult) ?? {};
  // Business fields = carried-forward inputs, overlaid by THIS agent's outputs (the producer wins).
  const merged: Record<string, unknown> = { ...carriedSource, ...lrFields };
  const carried = Object.keys(carriedSource).filter((k) => !(k in lrFields));
  // #W1-6 — COLLISION visibility: the producer's output intentionally wins over a same-named inbound
  // field, but that shadowing was silent. Report which inbound fields were overwritten (and whether
  // the value actually changed) so a miscopied field is legible in emit.envelope instead of vanishing.
  const shadowed = Object.keys(carriedSource).filter(
    (k) => k in lrFields && JSON.stringify(carriedSource[k]) !== JSON.stringify(lrFields[k]),
  );

  const offloaded: string[] = [];
  if (input.offload) {
    for (const [k, v] of Object.entries(merged)) {
      if (isBlobRef(v)) continue; // already a ref (carried forward)
      const ref = input.offload(k, v);
      if (ref) {
        merged[k] = ref;
        offloaded.push(k);
      }
    }
  }

  // Back-compat: keep `last_result`. Offload its oversized fields too (same content-addressed hash →
  // the store dedups, so the blob lives on disk once even though it's referenced twice).
  let lastResultOut: unknown = input.lastResult;
  const lrObj = asRecord(input.lastResult);
  if (input.offload && lrObj) {
    const lrCopy: Record<string, unknown> = { ...lrObj };
    for (const [k, v] of Object.entries(lrCopy)) {
      if (isBlobRef(v)) continue;
      const ref = input.offload(`last_result.${k}`, v);
      if (ref) lrCopy[k] = ref;
    }
    lastResultOut = lrCopy;
  }

  const payload: Record<string, unknown> = {
    ...merged,
    last_result: lastResultOut,
    // legacy meta fields kept so existing consumers reading these still work.
    source_agent: input.meta.producedBy,
    source_run: input.meta.sourceRun,
    subject: input.meta.subject,
    // structured provenance envelope. #P2 — `v` stamps the envelope schema version so a consumer can
    // detect a shape change; carry-forward makes field ADDITIONS backward-compatible, and the version
    // lets a future migration handle removals/renames explicitly instead of silently.
    _meta: {
      v: ENVELOPE_VERSION,
      subject: input.meta.subject,
      correlationId: input.meta.correlationId,
      causationId: input.meta.causationId,
      producedBy: input.meta.producedBy,
      sourceRun: input.meta.sourceRun,
    },
  };

  const missing = (input.contractFields ?? []).filter((f) => !(f in merged) || merged[f] == null);
  return { payload, carried, shadowed, offloaded, missing };
}

/** Async twin of rehydratePayload — for resolvers that can fall back to a SHARED backend on local
 *  miss (#SCALE-BLOB multi-instance: instance B consumes an event whose blob was written on A).
 *  Same shape/semantics; the register.ts consume path uses this one. */
export async function rehydratePayloadAsync(
  payload: Record<string, unknown>,
  resolve: (ref: BlobRef) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (isBlobRef(v)) out[k] = await resolve(v);
    else {
      const rec = asRecord(v);
      out[k] = rec ? await rehydratePayloadAsync(rec, resolve) : v;
    }
  }
  return out;
}

/** Rehydrate any `BlobRef` in a payload back to its real value via an injected resolver. Recurses
 *  into nested plain objects (so `last_result.pdf` refs resolve too). Arrays are left as-is. */
export function rehydratePayload(
  payload: Record<string, unknown>,
  resolve: (ref: BlobRef) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (isBlobRef(v)) out[k] = resolve(v);
    else {
      const rec = asRecord(v);
      out[k] = rec ? rehydratePayload(rec, resolve) : v;
    }
  }
  return out;
}
