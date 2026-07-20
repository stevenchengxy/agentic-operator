import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const FACTORY_PRODUCTION_IMAGE_ATTESTATION_SCHEMA =
  "agentic-factory-production-images/v2" as const;
export const DEFAULT_FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS = 5 * 60_000;
export const MAX_FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS = 15 * 60_000;
export type FactoryProductionImageTopology = "external_sandbox" | "single_host_compose";

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const EVIDENCE_HASH = /^sha256:[a-f0-9]{64}$/;
const KEY_ID = /^ed25519:sha256:[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{80,100}$/;
const MAX_ATTESTATION_BYTES = 1024 * 1024;
const MAX_PUBLIC_KEY_BYTES = 64 * 1024;

const FACTORY_CONTROL_PLANE_SERVICES = [
  { service: "api", env: "AGENTIC_API_IMAGE", role: "api" },
  { service: "web", env: "AGENTIC_WEB_IMAGE", role: "web" },
  { service: "codeact-executor", env: "PRODUCTION_CODEACT_EXECUTOR_IMAGE", role: "production-codeact-executor" },
] as const;
const FACTORY_SINGLE_HOST_SANDBOX_SERVICES = [
  { service: "sandbox-runner", env: "FACTORY_SANDBOX_CONTROL_IMAGE", role: "control" },
  { service: "sandbox-workload", env: "FACTORY_SANDBOX_WORKLOAD_IMAGE", role: "workload" },
  { service: "sandbox-broker-gateway", env: "FACTORY_SANDBOX_GATEWAY_IMAGE", role: "gateway" },
] as const;
export const FACTORY_PRODUCTION_SERVICES = [
  ...FACTORY_CONTROL_PLANE_SERVICES,
  ...FACTORY_SINGLE_HOST_SANDBOX_SERVICES,
] as const;

export interface ExpectedProductionImages {
  topology: FactoryProductionImageTopology;
  buildId: string;
  services: Array<{
    service: typeof FACTORY_PRODUCTION_SERVICES[number]["service"];
    imageId: string;
    role: string;
  }>;
  candidateImageId: string;
}

export interface ObservedProductionContainer {
  service: string;
  containerId: string;
  configImage: string;
  imageId: string;
  status: string;
  health?: string;
  buildId?: string;
  role?: string;
}

export interface FactoryProductionImageAttestationBody {
  schema: typeof FACTORY_PRODUCTION_IMAGE_ATTESTATION_SCHEMA;
  topology: FactoryProductionImageTopology;
  keyId: string;
  buildId: string;
  verifiedAt: string;
  expiresAt: string;
  services: Array<{
    service: string;
    imageId: string;
    containerIdHash: string;
    status: "running";
    /** Docker health is based on service-local liveness. Final API readiness is
     * checked independently and still requires this signed identity proof. */
    health: "healthy";
    buildId: string;
    role: string;
  }>;
  candidate: {
    imageId: string;
    buildId: string;
    role: "codeact-candidate";
  };
}

export interface FactoryProductionImageAttestation
  extends FactoryProductionImageAttestationBody {
  evidenceHash: string;
  signature: string;
}

export interface FactoryProductionImageTrustStatus {
  configured: boolean;
  ok: boolean;
  state: "disabled" | "ready" | "blocked";
  topology?: FactoryProductionImageTopology;
  diagnosticOnly?: boolean;
  keyId?: string;
  buildId?: string;
  candidateImageId?: string;
  verifiedAt?: string;
  expiresAt?: string;
  evidenceHash?: string;
  note?: string;
}

export class FactoryProductionImageTrustError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FactoryProductionImageTrustError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (keys.length !== canonical.length || keys.some((key, index) => key !== canonical[index])) {
    throw new FactoryProductionImageTrustError(
      "attestation_shape_invalid",
      `production image attestation ${field} has unknown or missing fields`,
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) throw new Error("canonical JSON contains a non-JSON value");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function parseSingleton(
  value: string | undefined,
  name: string,
  predicate: (entry: string) => boolean = () => true,
): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value ?? "");
  } catch {
    throw new FactoryProductionImageTrustError("production_identity_invalid", `${name} must be a JSON string array`);
  }
  if (
    !Array.isArray(decoded)
    || decoded.length !== 1
    || typeof decoded[0] !== "string"
    || !predicate(decoded[0])
  ) {
    throw new FactoryProductionImageTrustError(
      "production_identity_invalid",
      `${name} must contain exactly one expected identity and no additional entries`,
    );
  }
  return decoded[0];
}

export function expectedProductionImages(
  env: Record<string, string | undefined>,
): ExpectedProductionImages {
  const topology = env.FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY;
  if (topology !== "single_host_compose" && topology !== "external_sandbox") {
    throw new FactoryProductionImageTrustError(
      "production_topology_unsupported",
      "FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY must be external_sandbox or single_host_compose",
    );
  }
  const buildId = env.AGENTIC_BUILD_ID?.trim() ?? "";
  if (!buildId || buildId.length > 200) {
    throw new FactoryProductionImageTrustError("production_identity_invalid", "AGENTIC_BUILD_ID is required");
  }
  // external_sandbox attests only the local control plane. The remote runner,
  // workload and gateway are proven by their own signed execution receipt plus
  // the exact remote build/image allowlists; they must not be invented as local
  // Docker containers. single_host_compose remains a diagnostic topology.
  const serviceDefinitions = topology === "external_sandbox"
    ? FACTORY_CONTROL_PLANE_SERVICES
    : FACTORY_PRODUCTION_SERVICES;
  const services = serviceDefinitions.map((entry) => {
    const imageId = env[entry.env]?.trim() ?? "";
    if (!IMAGE_ID.test(imageId)) {
      throw new FactoryProductionImageTrustError(
        "production_identity_invalid",
        `${entry.env} must be an exact local sha256 image ID`,
      );
    }
    return { service: entry.service, imageId, role: entry.role };
  });

  // The candidate expectation is owned by the production environment, never by
  // the attestation being verified. The API intentionally receives no candidate
  // launcher image variable; this singleton is its only candidate trust input.
  const candidateImageId = parseSingleton(
    env.PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS,
    "PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS",
    (entry) => IMAGE_ID.test(entry),
  );
  const configuredCandidate = env.FACTORY_CODEACT_CANDIDATE_IMAGE?.trim();
  if (configuredCandidate && configuredCandidate !== candidateImageId) {
    throw new FactoryProductionImageTrustError(
      "production_identity_invalid",
      "FACTORY_CODEACT_CANDIDATE_IMAGE does not equal the production candidate singleton",
    );
  }

  const identities = [...services.map((entry) => entry.imageId), candidateImageId];
  if (new Set(identities).size !== identities.length) {
    throw new FactoryProductionImageTrustError(
      "production_identity_invalid",
      "every curated production image must have a distinct immutable ID",
    );
  }
  const runtimeImage = env.FACTORY_SB_RUNTIME_IMAGE_DIGEST?.trim() ?? "";
  if (!IMAGE_ID.test(runtimeImage)) throw new FactoryProductionImageTrustError(
    "production_identity_invalid",
    "FACTORY_SB_RUNTIME_IMAGE_DIGEST must be an exact remote/local workload image ID",
  );
  const allowedRunnerBuild = parseSingleton(env.FACTORY_SB_ALLOWED_BUILD_IDS, "FACTORY_SB_ALLOWED_BUILD_IDS");
  if (topology === "single_host_compose") {
    const workloadImage = services.find((row) => row.service === "sandbox-workload")!.imageId;
    if (runtimeImage !== workloadImage) {
      throw new FactoryProductionImageTrustError(
        "production_identity_invalid",
        "sandbox runtime receipt identity does not equal the local workload image ID",
      );
    }
    if (allowedRunnerBuild !== buildId) {
      throw new FactoryProductionImageTrustError(
        "production_identity_invalid",
        "FACTORY_SB_ALLOWED_BUILD_IDS does not equal AGENTIC_BUILD_ID in single-host diagnostic mode",
      );
    }
  }
  if (
    parseSingleton(
      env.FACTORY_SB_ALLOWED_IMAGE_DIGESTS,
      "FACTORY_SB_ALLOWED_IMAGE_DIGESTS",
      (entry) => IMAGE_ID.test(entry),
    ) !== runtimeImage
  ) {
    throw new FactoryProductionImageTrustError(
      "production_identity_invalid",
      "FACTORY_SB_ALLOWED_IMAGE_DIGESTS does not equal the workload image ID",
    );
  }
  for (const name of [
    "FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS",
    "PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS",
  ]) {
    // The API deliberately receives no direct candidate launcher authority, so
    // Compose clears FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS there. If present on
    // the host/executor it must still be the exact singleton.
    if (name === "FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS" && !env[name]?.trim()) continue;
    if (parseSingleton(env[name], name, (entry) => IMAGE_ID.test(entry)) !== candidateImageId) {
      throw new FactoryProductionImageTrustError(
        "production_identity_invalid",
        `${name} does not equal the production candidate singleton`,
      );
    }
  }
  return { topology, buildId, services, candidateImageId };
}

function publicKey(value: string | Buffer | KeyObject): KeyObject {
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    const text = value.toString();
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n/.test(text)) {
      throw new FactoryProductionImageTrustError(
        "public_key_invalid",
        "production image trust root must be an Ed25519 public key",
      );
    }
  }
  let key: KeyObject;
  try {
    key = value instanceof KeyObject && value.type === "public"
      ? value
      // Node's runtime accepts a KeyObject here; @types/node 26 narrowed the
      // declared input union, so bridge the KeyObject case through the
      // function's own parameter type.
      : createPublicKey(value as Parameters<typeof createPublicKey>[0]);
  } catch {
    throw new FactoryProductionImageTrustError(
      "public_key_invalid",
      "production image trust root public key is invalid",
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new FactoryProductionImageTrustError(
      "public_key_invalid",
      "production image trust root must use Ed25519",
    );
  }
  return key;
}

export function productionImageAttestationKeyId(value: string | Buffer | KeyObject): string {
  const key = publicKey(value);
  const der = key.export({ type: "spki", format: "der" });
  return `ed25519:sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function verifyProductionImageObservation(input: {
  expected: ExpectedProductionImages;
  containers: ObservedProductionContainer[];
  candidate: { imageId: string; buildId?: string; role?: string };
  keyId: string;
  now?: Date;
  ttlMs?: number;
}): FactoryProductionImageAttestationBody {
  if (!KEY_ID.test(input.keyId)) throw new Error("production image attestation key id is invalid");
  const ttlMs = input.ttlMs ?? DEFAULT_FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > MAX_FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS) {
    throw new Error("production image attestation TTL must be between 10 seconds and 15 minutes");
  }
  const rows = input.expected.services.map((expected) => {
    const matches = input.containers.filter((row) => row.service === expected.service);
    if (matches.length !== 1) throw new Error(`${expected.service} must resolve to exactly one Compose container`);
    const observed = matches[0]!;
    if (observed.configImage !== expected.imageId || observed.imageId !== expected.imageId) {
      throw new Error(`${expected.service} is not running its configured immutable image ID`);
    }
    if (observed.status !== "running") throw new Error(`${expected.service} is not running`);
    if (observed.health !== "healthy") throw new Error(`${expected.service} liveness health is ${observed.health ?? "not configured"}`);
    if (observed.buildId !== input.expected.buildId) throw new Error(`${expected.service} image build label does not match AGENTIC_BUILD_ID`);
    if (observed.role !== expected.role) throw new Error(`${expected.service} image role label is invalid`);
    return {
      service: expected.service,
      imageId: expected.imageId,
      containerIdHash: hash(observed.containerId),
      status: "running" as const,
      health: "healthy" as const,
      buildId: observed.buildId,
      role: observed.role,
    };
  });
  if (
    input.candidate.imageId !== input.expected.candidateImageId
    || input.candidate.buildId !== input.expected.buildId
    || input.candidate.role !== "codeact-candidate"
  ) throw new Error("candidate image identity/build/role observation is invalid");
  const verifiedAt = input.now ?? new Date();
  return {
    schema: FACTORY_PRODUCTION_IMAGE_ATTESTATION_SCHEMA,
    topology: input.expected.topology,
    keyId: input.keyId,
    buildId: input.expected.buildId,
    verifiedAt: verifiedAt.toISOString(),
    expiresAt: new Date(verifiedAt.getTime() + ttlMs).toISOString(),
    services: rows,
    candidate: {
      imageId: input.candidate.imageId,
      buildId: input.candidate.buildId,
      role: "codeact-candidate",
    },
  };
}

export function signFactoryProductionImageAttestation(
  body: FactoryProductionImageAttestationBody,
  privateKeyPem: string | Buffer | KeyObject,
): FactoryProductionImageAttestation {
  let key: KeyObject;
  try {
    key = privateKeyPem instanceof KeyObject
      ? privateKeyPem
      : createPrivateKey(privateKeyPem);
  } catch {
    throw new Error("production image attestation private key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("production image attestation private key must use Ed25519");
  const derivedKeyId = productionImageAttestationKeyId(
    // Runtime accepts a private KeyObject to derive its public half; bridge
    // the @types/node 26 narrowed input union.
    createPublicKey(key as unknown as Parameters<typeof createPublicKey>[0]),
  );
  if (body.keyId !== derivedKeyId) throw new Error("production image attestation key id does not match private key");
  const evidenceHash = hash(body);
  const signature = sign(
    null,
    Buffer.from(canonicalJson({ ...body, evidenceHash }), "utf8"),
    key,
  ).toString("base64url");
  return { ...body, evidenceHash, signature };
}

function validateAttestationShape(value: unknown): FactoryProductionImageAttestation {
  if (!isRecord(value)) {
    throw new FactoryProductionImageTrustError("attestation_invalid", "production image attestation is not an object");
  }
  exactKeys(value, [
    "schema", "topology", "keyId", "buildId", "verifiedAt", "expiresAt", "services", "candidate", "evidenceHash", "signature",
  ], "document");
  if (
    value.schema !== FACTORY_PRODUCTION_IMAGE_ATTESTATION_SCHEMA
    || (value.topology !== "single_host_compose" && value.topology !== "external_sandbox")
    || typeof value.keyId !== "string" || !KEY_ID.test(value.keyId)
    || typeof value.buildId !== "string" || !value.buildId
    || typeof value.verifiedAt !== "string"
    || typeof value.expiresAt !== "string"
    || typeof value.evidenceHash !== "string" || !EVIDENCE_HASH.test(value.evidenceHash)
    || typeof value.signature !== "string" || !SIGNATURE.test(value.signature)
    || !Array.isArray(value.services)
    || !isRecord(value.candidate)
  ) {
    throw new FactoryProductionImageTrustError("attestation_shape_invalid", "production image attestation shape is invalid");
  }
  for (const entry of value.services) {
    if (!isRecord(entry)) throw new FactoryProductionImageTrustError("attestation_shape_invalid", "production image service evidence is invalid");
    exactKeys(entry, ["service", "imageId", "containerIdHash", "status", "health", "buildId", "role"], "service evidence");
    if (
      typeof entry.service !== "string" || !entry.service
      || typeof entry.imageId !== "string" || !IMAGE_ID.test(entry.imageId)
      || typeof entry.containerIdHash !== "string" || !EVIDENCE_HASH.test(entry.containerIdHash)
      || entry.status !== "running"
      || entry.health !== "healthy"
      || typeof entry.buildId !== "string" || !entry.buildId
      || typeof entry.role !== "string" || !entry.role
    ) throw new FactoryProductionImageTrustError("attestation_shape_invalid", "production image service evidence is invalid");
  }
  exactKeys(value.candidate, ["imageId", "buildId", "role"], "candidate evidence");
  if (
    typeof value.candidate.imageId !== "string" || !IMAGE_ID.test(value.candidate.imageId)
    || typeof value.candidate.buildId !== "string" || !value.candidate.buildId
    || value.candidate.role !== "codeact-candidate"
  ) throw new FactoryProductionImageTrustError("attestation_shape_invalid", "production candidate evidence is invalid");
  return value as unknown as FactoryProductionImageAttestation;
}

export function assertFactoryProductionImageAttestation(
  value: unknown,
  expected: ExpectedProductionImages,
  options: {
    publicKey: string | Buffer | KeyObject;
    now?: Date;
    maxTtlMs?: number;
  },
): asserts value is FactoryProductionImageAttestation {
  const row = validateAttestationShape(value);
  const key = publicKey(options.publicKey);
  const expectedKeyId = productionImageAttestationKeyId(key);
  if (row.keyId !== expectedKeyId) {
    throw new FactoryProductionImageTrustError("attestation_key_mismatch", "production image attestation key id is not trusted");
  }
  const { evidenceHash, signature, ...body } = row;
  if (evidenceHash !== hash(body)) {
    throw new FactoryProductionImageTrustError("attestation_hash_invalid", "production image attestation hash is invalid");
  }
  if (!verify(
    null,
    Buffer.from(canonicalJson({ ...body, evidenceHash }), "utf8"),
    key,
    Buffer.from(signature, "base64url"),
  )) {
    throw new FactoryProductionImageTrustError("attestation_signature_invalid", "production image attestation signature is invalid");
  }
  if (
    row.buildId !== expected.buildId
    || row.topology !== expected.topology
    || row.services.length !== expected.services.length
  ) throw new FactoryProductionImageTrustError("attestation_identity_invalid", "production image attestation identity is invalid");

  const verifiedAt = Date.parse(row.verifiedAt);
  const expiresAt = Date.parse(row.expiresAt);
  const now = (options.now ?? new Date()).getTime();
  const maxTtlMs = options.maxTtlMs ?? DEFAULT_FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS;
  if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs < 10_000 || maxTtlMs > MAX_FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS) {
    throw new FactoryProductionImageTrustError("attestation_ttl_invalid", "production image attestation TTL policy is invalid");
  }
  if (
    !Number.isFinite(verifiedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= verifiedAt
    || expiresAt - verifiedAt > maxTtlMs
    || verifiedAt > now + 5_000
    || now >= expiresAt
  ) throw new FactoryProductionImageTrustError("attestation_expired", "production image attestation is stale or expired");

  for (const image of expected.services) {
    const matches = row.services.filter((entry) => entry.service === image.service);
    const observed = matches[0];
    if (
      matches.length !== 1
      || observed?.imageId !== image.imageId
      || observed.buildId !== expected.buildId
      || observed.role !== image.role
      || observed.status !== "running"
      || observed.health !== "healthy"
      || !EVIDENCE_HASH.test(observed.containerIdHash)
    ) throw new FactoryProductionImageTrustError(
      "attestation_identity_invalid",
      `production image attestation mismatch for ${image.service}`,
    );
  }
  if (
    row.candidate.imageId !== expected.candidateImageId
    || row.candidate.buildId !== expected.buildId
    || row.candidate.role !== "codeact-candidate"
  ) throw new FactoryProductionImageTrustError(
    "attestation_identity_invalid",
    "production candidate image attestation is invalid",
  );
}

function ttlFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS?.trim();
  const ttl = raw ? Number(raw) : DEFAULT_FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 10_000 || ttl > MAX_FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS) {
    throw new FactoryProductionImageTrustError(
      "attestation_ttl_invalid",
      "FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS must be between 10000 and 900000",
    );
  }
  return ttl;
}

function boundedFile(filename: string, maxBytes: number, label: string): Buffer {
  if (!path.isAbsolute(filename)) {
    throw new FactoryProductionImageTrustError("attestation_config_invalid", `${label} must be an absolute path`);
  }
  try {
    const content = readFileSync(filename);
    if (!content.length || content.length > maxBytes) throw new Error("size");
    return content;
  } catch {
    throw new FactoryProductionImageTrustError("attestation_unavailable", `${label} is unavailable or invalid`);
  }
}

export function assertFactoryProductionImageTrustReady(options: {
  env?: Record<string, string | undefined>;
  now?: Date;
  requiredTopology?: FactoryProductionImageTopology;
} = {}): FactoryProductionImageTrustStatus {
  const env = options.env ?? process.env;
  if (env.NODE_ENV !== "production") return { configured: false, ok: true, state: "disabled" };
  const attestationFile = env.FACTORY_PRODUCTION_IMAGE_ATTESTATION_FILE?.trim() ?? "";
  const publicKeyFile = env.FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_FILE?.trim() ?? "";
  if (!attestationFile || !publicKeyFile) {
    throw new FactoryProductionImageTrustError(
      "attestation_config_invalid",
      "production image attestation file and public trust root are required",
    );
  }
  const expected = expectedProductionImages(env);
  if (options.requiredTopology && expected.topology !== options.requiredTopology) {
    throw new FactoryProductionImageTrustError(
      "production_topology_not_promotable",
      `this operation requires ${options.requiredTopology}; ${expected.topology} is diagnostic-only for sandbox execution`,
    );
  }
  const raw = boundedFile(attestationFile, MAX_ATTESTATION_BYTES, "production image attestation file");
  const publicKeyPem = boundedFile(publicKeyFile, MAX_PUBLIC_KEY_BYTES, "production image public trust root");
  let attestation: unknown;
  try {
    attestation = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new FactoryProductionImageTrustError("attestation_invalid", "production image attestation JSON is invalid");
  }
  assertFactoryProductionImageAttestation(attestation, expected, {
    publicKey: publicKeyPem,
    now: options.now,
    maxTtlMs: ttlFromEnv(env),
  });
  return {
    configured: true,
    ok: true,
    state: "ready",
    topology: expected.topology,
    diagnosticOnly: expected.topology === "single_host_compose",
    keyId: attestation.keyId,
    buildId: expected.buildId,
    candidateImageId: expected.candidateImageId,
    verifiedAt: attestation.verifiedAt,
    expiresAt: attestation.expiresAt,
    evidenceHash: attestation.evidenceHash,
  };
}

export function checkFactoryProductionImageTrust(options: {
  env?: Record<string, string | undefined>;
  now?: Date;
  requiredTopology?: FactoryProductionImageTopology;
} = {}): FactoryProductionImageTrustStatus {
  try {
    return assertFactoryProductionImageTrustReady(options);
  } catch (error) {
    return {
      configured: (options.env ?? process.env).NODE_ENV === "production",
      ok: false,
      state: "blocked",
      note: String((error as Error)?.message ?? error).slice(0, 240),
    };
  }
}
