import { z } from "zod";

/**
 * Public contract for tenant-scoped workspace API tokens.
 *
 * The database stores only a SHA-256 digest. `plaintext` deliberately exists
 * only on the create/rotate response schema so list responses can never leak
 * a usable credential by accident.
 */
export const API_TOKEN_DISPLAY_PREFIX = "ao_live_" as const;
export const API_TOKEN_SCOPE = "workspace:all" as const;

export const ApiTokenName = z.string().trim().min(1).max(80);
export type ApiTokenName = z.infer<typeof ApiTokenName>;

export const ApiTokenPublic = z
  .object({
    id: z.string().min(1),
    name: ApiTokenName,
    prefix: z.literal(API_TOKEN_DISPLAY_PREFIX),
    scopes: z.array(z.string().min(1)),
    createdAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type ApiTokenPublic = z.infer<typeof ApiTokenPublic>;

export const ListApiTokensResponse = z
  .object({
    items: z.array(ApiTokenPublic),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type ListApiTokensResponse = z.infer<typeof ListApiTokensResponse>;

export const CreateApiTokenBody = z
  .object({
    name: ApiTokenName,
  })
  .strict();
export type CreateApiTokenBody = z.infer<typeof CreateApiTokenBody>;

export const ApiTokenParams = z
  .object({
    id: z.string().trim().min(1).max(160),
  })
  .strict();
export type ApiTokenParams = z.infer<typeof ApiTokenParams>;

export const ApiTokenSecret = ApiTokenPublic.extend({
  plaintext: z.string().startsWith(API_TOKEN_DISPLAY_PREFIX),
}).strict();
export type ApiTokenSecret = z.infer<typeof ApiTokenSecret>;

export const RevokeApiTokenResponse = z
  .object({
    id: z.string().min(1),
    revoked: z.literal(true),
  })
  .strict();
export type RevokeApiTokenResponse = z.infer<typeof RevokeApiTokenResponse>;
