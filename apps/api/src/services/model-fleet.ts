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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  catalogModelPolicy,
  findCatalogModel,
  PROVIDER_IDS,
  type ProviderId,
} from "@agentic/contracts";
import { makeId } from "@agentic/shared";

export type FleetRole = "primary" | "fallback" | "shadow";
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
  /** null means use the provider/model default and omit the parameter. */
  temperature: number | null;
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

const FLEET_PATH = defaultPath();
let cache: FleetFile | null = null;

function load(): FleetFile {
  if (cache) return cache;
  if (!existsSync(FLEET_PATH)) {
    cache = { entries: [] };
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(FLEET_PATH, "utf8")) as FleetFile;
    if (!Array.isArray(parsed.entries)) throw new Error("malformed fleet file");
    cache = parsed;
    return parsed;
  } catch (err) {
    throw new Error(
      `model-fleet file at ${FLEET_PATH} is unreadable: ${(err as Error).message}`,
    );
  }
}

function persist(file: FleetFile): void {
  mkdirSync(dirname(FLEET_PATH), { recursive: true });
  writeFileSync(FLEET_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
  cache = file;
}

function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

function isFleetRole(s: unknown): s is FleetRole {
  return typeof s === "string" && (FLEET_ROLES as readonly string[]).includes(s);
}

export function listFleet(tenantSlug: string): ModelFleetEntry[] {
  return load()
    .entries.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.tenantSlug === tenantSlug)
    // Date.now() can repeat for back-to-back writes. File order is the
    // authoritative insertion order, so use the later array position as a
    // deterministic newest-first tie-breaker.
    .sort((a, b) => b.entry.addedAt - a.entry.addedAt || b.index - a.index)
    .map(({ entry }) => entry);
}

export interface AddFleetInput {
  tenantSlug: string;
  provider: string;
  modelName: string;
  alias?: string;
  role?: string;
  dailyCapUsd?: number;
  maxOutTokens?: number;
  temperature?: number | null;
  addedBy?: string | null;
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
  const modelName = (input.modelName ?? "").trim();
  if (!modelName) {
    throw new FleetValidationError("modelName is required");
  }
  // Known legacy/restricted catalog rows cannot be newly added. Unknown IDs
  // remain valid because live discovery inventories are larger than the
  // checked-in catalog, and custom/private deployments cannot be curated.
  // Existing fleet rows are never revalidated here, preserving configured
  // historical models for replay and controlled migration.
  const catalogModel = findCatalogModel(input.provider, modelName);
  if (catalogModel) {
    const policy = catalogModelPolicy(catalogModel);
    if (!policy.selectable) {
      throw new FleetValidationError(
        `${input.provider}/${modelName} is not selectable (${policy.reason})`,
      );
    }
  }
  const role: FleetRole = isFleetRole(input.role) ? input.role : "primary";
  const alias = (input.alias ?? "").trim() || modelName;
  const dailyCapUsd = Number.isFinite(input.dailyCapUsd) ? Math.max(0, Number(input.dailyCapUsd)) : 30;
  const maxOutTokens = Number.isInteger(input.maxOutTokens) && input.maxOutTokens! > 0
    ? input.maxOutTokens!
    : 2048;
  let temperature: number | null = null;
  if (input.temperature !== undefined && input.temperature !== null) {
    if (!Number.isFinite(input.temperature)) {
      throw new FleetValidationError("temperature must be a finite number or null");
    }
    if (catalogModel?.temperatureRange === null) {
      throw new FleetValidationError(
        `${input.provider}/${modelName} does not support temperature; leave it unset`,
      );
    }
    const range = catalogModel?.temperatureRange ?? { min: 0, max: 2 };
    if (input.temperature < range.min || input.temperature > range.max) {
      throw new FleetValidationError(
        `temperature must be between ${range.min} and ${range.max}`,
      );
    }
    temperature = input.temperature;
  }

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
  temperature?: number | null;
}

export function updateFleetEntry(
  tenantSlug: string,
  id: string,
  patch: UpdateFleetInput,
): ModelFleetEntry | null {
  const file = load();
  const idx = file.entries.findIndex(
    (e) => e.id === id && e.tenantSlug === tenantSlug,
  );
  if (idx < 0) return null;
  const cur = file.entries[idx]!;
  const next: ModelFleetEntry = { ...cur };
  if (typeof patch.alias === "string") {
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
  if (patch.dailyCapUsd !== undefined && Number.isFinite(patch.dailyCapUsd)) {
    next.dailyCapUsd = Math.max(0, patch.dailyCapUsd);
  }
  if (patch.maxOutTokens !== undefined && Number.isInteger(patch.maxOutTokens) && patch.maxOutTokens > 0) {
    next.maxOutTokens = patch.maxOutTokens;
  }
  if (patch.temperature !== undefined) {
    if (patch.temperature === null) {
      next.temperature = null;
    } else {
      if (!Number.isFinite(patch.temperature)) {
        throw new FleetValidationError(
          "temperature must be a finite number or null",
        );
      }
      const catalog = findCatalogModel(cur.provider, cur.modelName);
      if (catalog?.temperatureRange === null) {
        throw new FleetValidationError(
          `${cur.provider}/${cur.modelName} does not support temperature; leave it unset`,
        );
      }
      const range = catalog?.temperatureRange ?? { min: 0, max: 2 };
      if (patch.temperature < range.min || patch.temperature > range.max) {
        throw new FleetValidationError(
          `temperature must be between ${range.min} and ${range.max}`,
        );
      }
      next.temperature = patch.temperature;
    }
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
