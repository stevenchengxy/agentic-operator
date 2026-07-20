/**
 * Model-fleet vault — persists the set of upstream models that each tenant
 * has chosen to expose to its agents.
 *
 * Stored at `data/model-fleet.json` (gitignored), one JSON document with all
 * entries; rows are tagged with `tenantSlug` and filtered on read. The model
 * fleet is operator-managed config (small, low-churn), not run-state, so a
 * flat JSON file is the right granularity — no migration overhead, easy to
 * inspect, atomic write per change.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { PROVIDER_IDS, type ProviderId } from "@agentic/contracts";
import { makeId } from "@agentic/shared";

export type FleetRole = "primary" | "fallback" | "shadow";
export type ModelAvailability = "provider_confirmed" | "unverified";
const FLEET_ROLES: readonly FleetRole[] = ["primary", "fallback", "shadow"];

export interface ModelFleetEntry {
  id: string;
  tenantSlug: string;
  provider: ProviderId;
  /** Canonical provider-native model name (e.g. "anthropic/claude-sonnet-4-5"). */
  modelName: string;
  /** Operator-facing display name. Defaults to `modelName`. */
  alias: string;
  role: FleetRole;
  dailyCapUsd: number;
  maxOutTokens: number;
  temperature: number;
  /** provider_confirmed means the exact id appeared in a live upstream
   * listing at add time. Unsupported providers remain explicitly unverified. */
  availability: ModelAvailability;
  availabilityCheckedAt: number | null;
  availabilityMessage: string | null;
  addedAt: number;
  addedBy: string | null;
}

interface FleetFile {
  entries: ModelFleetEntry[];
}

function defaultPath(): string {
  if (process.env.AGENTIC_MODEL_FLEET_PATH) return process.env.AGENTIC_MODEL_FLEET_PATH;
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && dbUrl.startsWith("file:")) {
    return join(dirname(dbUrl.slice(5)), "model-fleet.json");
  }
  return join(process.cwd(), "data", "model-fleet.json");
}

let cache: { path: string; file: FleetFile } | null = null;

function load(): FleetFile {
  const fleetPath = defaultPath();
  if (cache?.path === fleetPath) return cache.file;
  if (!existsSync(fleetPath)) {
    const file = { entries: [] };
    cache = { path: fleetPath, file };
    return file;
  }
  try {
    const parsed = JSON.parse(readFileSync(fleetPath, "utf8")) as FleetFile;
    if (!Array.isArray(parsed.entries)) throw new Error("malformed fleet file");
    const normalized: FleetFile = {
      entries: parsed.entries.map((entry) => ({
        ...entry,
        availability:
          entry.availability === "provider_confirmed"
            ? "provider_confirmed"
            : "unverified",
        availabilityCheckedAt:
          typeof entry.availabilityCheckedAt === "number"
            ? entry.availabilityCheckedAt
            : null,
        availabilityMessage:
          typeof entry.availabilityMessage === "string"
            ? entry.availabilityMessage
            : "Legacy entry was not provider-confirmed",
      })),
    };
    cache = { path: fleetPath, file: normalized };
    return normalized;
  } catch (err) {
    throw new Error(
      `model-fleet file at ${fleetPath} is unreadable: ${(err as Error).message}`,
    );
  }
}

function persist(file: FleetFile): void {
  const fleetPath = defaultPath();
  mkdirSync(dirname(fleetPath), { recursive: true });
  const temp = `${fleetPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(file, null, 2), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, fleetPath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  cache = { path: fleetPath, file };
}

function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

function isFleetRole(s: unknown): s is FleetRole {
  return typeof s === "string" && (FLEET_ROLES as readonly string[]).includes(s);
}

export function listFleet(tenantSlug: string): ModelFleetEntry[] {
  return load()
    .entries.filter((e) => e.tenantSlug === tenantSlug)
    .sort((a, b) => b.addedAt - a.addedAt);
}

export interface AddFleetInput {
  tenantSlug: string;
  provider: string;
  modelName: string;
  alias?: string;
  role?: string;
  dailyCapUsd?: number;
  maxOutTokens?: number;
  temperature?: number;
  addedBy?: string | null;
  availability?: ModelAvailability;
  availabilityCheckedAt?: number | null;
  availabilityMessage?: string | null;
}

export class FleetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetValidationError";
  }
}

export function addFleetEntry(input: AddFleetInput): ModelFleetEntry {
  if (!isProviderId(input.provider)) {
    throw new FleetValidationError(`unknown provider: ${input.provider}`);
  }
  if (typeof input.modelName !== "string") {
    throw new FleetValidationError("modelName must be a string");
  }
  const modelName = input.modelName.trim();
  if (!modelName) {
    throw new FleetValidationError("modelName is required");
  }
  // We used to reject any modelName not in PROVIDER_MODEL_CATALOG, but the
  // catalog is a curated subset (≤6 per provider) while live discovery
  // returns the provider's full inventory — OpenRouter alone serves ~360.
  // The picker shows live results; rejecting them at add-time was a
  // permanent footgun. The catalog now serves UI metadata only; bad
  // modelNames surface at invocation time when the upstream returns 404.
  if (input.role !== undefined && !isFleetRole(input.role)) {
    throw new FleetValidationError(`invalid role: ${String(input.role)}`);
  }
  if (input.alias !== undefined && typeof input.alias !== "string") {
    throw new FleetValidationError("alias must be a string");
  }
  const role: FleetRole = input.role ?? "primary";
  const alias = (input.alias ?? "").trim() || modelName;
  const dailyCapUsd = input.dailyCapUsd === undefined
    ? 30
    : requireFiniteRange("dailyCapUsd", input.dailyCapUsd, 0, Number.MAX_SAFE_INTEGER);
  const maxOutTokens = input.maxOutTokens === undefined
    ? 2048
    : requirePositiveInteger("maxOutTokens", input.maxOutTokens);
  const temperature = input.temperature === undefined
    ? 0.2
    : requireFiniteRange("temperature", input.temperature, 0, 2);

  const file = load();
  // Duplicate guard: same tenant + provider + modelName means it's already in
  // the fleet. Aliases must also be unique per tenant.
  const dupModel = file.entries.find(
    (e) =>
      e.tenantSlug === input.tenantSlug &&
      e.provider === input.provider &&
      e.modelName === modelName,
  );
  if (dupModel) {
    throw new FleetValidationError(
      `${input.provider}/${modelName} is already in this tenant's fleet`,
    );
  }
  const dupAlias = file.entries.find(
    (e) => e.tenantSlug === input.tenantSlug && e.alias === alias,
  );
  if (dupAlias) {
    throw new FleetValidationError(`alias "${alias}" is already used in this tenant`);
  }

  const entry: ModelFleetEntry = {
    id: makeId("mdl"),
    tenantSlug: input.tenantSlug,
    provider: input.provider,
    modelName,
    alias,
    role,
    dailyCapUsd,
    maxOutTokens,
    temperature,
    availability:
      input.availability === "provider_confirmed"
        ? "provider_confirmed"
        : "unverified",
    availabilityCheckedAt:
      input.availability === "provider_confirmed"
        ? (input.availabilityCheckedAt ?? Date.now())
        : null,
    availabilityMessage: input.availabilityMessage ?? null,
    addedAt: Date.now(),
    addedBy: input.addedBy ?? null,
  };
  persist({ entries: [...file.entries, entry] });
  return entry;
}

export interface UpdateFleetInput {
  alias?: string;
  role?: string;
  dailyCapUsd?: number;
  maxOutTokens?: number;
  temperature?: number;
}

function requireFiniteRange(
  name: string,
  value: unknown,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new FleetValidationError(
      `${name} must be a finite number between ${min} and ${max}`,
    );
  }
  return value;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new FleetValidationError(`${name} must be a positive integer`);
  }
  return value;
}

export function updateFleetEntry(
  tenantSlug: string,
  id: string,
  patch: UpdateFleetInput,
): ModelFleetEntry | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new FleetValidationError("update body must be an object");
  }
  const allowed = new Set([
    "alias",
    "role",
    "dailyCapUsd",
    "maxOutTokens",
    "temperature",
  ]);
  const keys = Object.keys(patch as Record<string, unknown>);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new FleetValidationError(
      `unknown fleet update field(s): ${unknown.join(", ")}`,
    );
  }
  if (keys.length === 0) {
    throw new FleetValidationError("at least one fleet field is required");
  }
  const file = load();
  const idx = file.entries.findIndex(
    (e) => e.id === id && e.tenantSlug === tenantSlug,
  );
  if (idx < 0) return null;
  const cur = file.entries[idx]!;
  const next: ModelFleetEntry = { ...cur };
  if (patch.alias !== undefined) {
    if (typeof patch.alias !== "string") {
      throw new FleetValidationError("alias must be a string");
    }
    const alias = patch.alias.trim() || cur.modelName;
    const dup = file.entries.find(
      (e) => e.id !== cur.id && e.tenantSlug === tenantSlug && e.alias === alias,
    );
    if (dup) {
      throw new FleetValidationError(`alias "${alias}" is already used in this tenant`);
    }
    next.alias = alias;
  }
  if (patch.role !== undefined) {
    if (!isFleetRole(patch.role)) {
      throw new FleetValidationError(`invalid role: ${patch.role}`);
    }
    next.role = patch.role;
  }
  if (patch.dailyCapUsd !== undefined) {
    next.dailyCapUsd = requireFiniteRange(
      "dailyCapUsd",
      patch.dailyCapUsd,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (patch.maxOutTokens !== undefined) {
    next.maxOutTokens = requirePositiveInteger(
      "maxOutTokens",
      patch.maxOutTokens,
    );
  }
  if (patch.temperature !== undefined) {
    next.temperature = requireFiniteRange(
      "temperature",
      patch.temperature,
      0,
      2,
    );
  }
  const entries = [...file.entries];
  entries[idx] = next;
  persist({ entries });
  return next;
}

export function deleteFleetEntry(tenantSlug: string, id: string): boolean {
  const file = load();
  const before = file.entries.length;
  const after = file.entries.filter(
    (e) => !(e.id === id && e.tenantSlug === tenantSlug),
  );
  if (after.length === before) return false;
  persist({ entries: after });
  return true;
}

/** Test-only — drop the cache so the next read re-loads from disk. */
export function _resetFleetCache(): void {
  cache = null;
}
