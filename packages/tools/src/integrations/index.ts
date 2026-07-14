/**
 * @agentic/tools/integrations — DI seam for DB-backed integration creds.
 *
 * apps/api injects a resolver at boot (`setIntegrationResolver`) so global
 * tools (e.g. the GoHire family) can read per-tenant base-URL + API-key
 * configured in Settings → Integrations, without `@agentic/tools` ever
 * importing the database layer.
 */

export {
  setIntegrationResolver,
  hasIntegrationResolver,
  resolveIntegrationCreds,
  type IntegrationCreds,
  type IntegrationResolver,
} from "./host";
