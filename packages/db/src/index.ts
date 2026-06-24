export * from "./client";
export * from "./schema";
export * from "./with-tenant";
export { hashPassword, verifyPassword } from "./password";
// Re-export the common drizzle query operators so DB-backed tenant tools (e.g.
// the RAAS candidateDedupLookup) can build queries via `@agentic/db` without a
// separate `drizzle-orm` dependency.
export { eq, and, or, sql, desc, asc, inArray } from "drizzle-orm";
export { wipeRuntime } from "./wipe-runtime";
export {
  pruneRolledBackDeployments,
  DEFAULT_ROLLED_BACK_RETENTION,
  type PruneDeploymentsReport,
} from "./prune-deployments";
