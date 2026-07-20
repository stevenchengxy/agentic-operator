import { z } from "zod";

/**
 * @agentic/contracts/integrations — shapes for the `/v1/integrations`
 * surface backing Settings → Integrations.
 *
 * An integration is a per-tenant binding to an external service (the first
 * is the GoHire ATS): a base URL + an API key. The key is encrypted at rest
 * in apps/api; it NEVER crosses this contract in plaintext on the way out —
 * responses carry only a masked fragment + `hasKey`. The plaintext is only
 * ever accepted inbound on the upsert body.
 */

/** Catalog of providers an operator can configure. Drives the "Add
 *  integration" picker; keep in sync with the GoHire tool family + any
 *  future ATS wrappers in @agentic/tools. */
export const INTEGRATION_PROVIDERS = [
  {
    id: "gohire",
    name: "GoHire",
    kind: "ATS",
    defaultBaseUrl: "https://api.gohire.io/v1",
    description:
      "GoHire applicant-tracking system. Powers the gohire* tool family (parse/match/invite) for any agent that lists them in tool_use[].",
    docsUrl: "https://gohire.io",
  },
] as const;

export type IntegrationProviderId = (typeof INTEGRATION_PROVIDERS)[number]["id"];

/** The set of provider ids accepted by the upsert route. */
export const IntegrationProvider = z.enum(
  INTEGRATION_PROVIDERS.map((p) => p.id) as [string, ...string[]],
);

export const IntegrationStatus = z.enum(["unconfigured", "ok", "error"]);
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

/** Public, secret-free view of one configured integration. */
export const IntegrationPublic = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  baseUrl: z.string().nullable(),
  /** Masked fragment of the key (e.g. "gh_ab…wxyz"); never the plaintext. */
  keyMasked: z.string().nullable(),
  /** True when an API key is stored for this integration. */
  hasKey: z.boolean(),
  status: IntegrationStatus,
  lastCheckedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type IntegrationPublic = z.infer<typeof IntegrationPublic>;

export const ListIntegrationsResponse = z.object({
  integrations: z.array(IntegrationPublic),
  /** The provider catalog so the UI can offer "Add integration" choices. */
  available: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      defaultBaseUrl: z.string(),
      description: z.string(),
      docsUrl: z.string().optional(),
    }),
  ),
});
export type ListIntegrationsResponse = z.infer<typeof ListIntegrationsResponse>;

/**
 * Upsert one integration. Keyed on (tenant, provider): a second PUT for the
 * same provider updates the existing row. `apiKey` is optional on update —
 * omit it to leave the stored key untouched (so the operator can change just
 * the base URL without re-entering the secret). Send an empty string to
 * clear the key.
 */
export const UpsertIntegrationBody = z.object({
  provider: IntegrationProvider,
  name: z.string().min(1).max(80).optional(),
  baseUrl: z.string().url().max(2048).optional(),
  apiKey: z.string().max(4096).optional(),
  enabled: z.boolean().optional(),
});
export type UpsertIntegrationBody = z.infer<typeof UpsertIntegrationBody>;

/** Result of a connection test (calls the provider's health endpoint). */
export const TestIntegrationResponse = z.object({
  ok: z.boolean(),
  status: IntegrationStatus,
  message: z.string().nullable(),
  checkedAt: z.number(),
});
export type TestIntegrationResponse = z.infer<typeof TestIntegrationResponse>;
