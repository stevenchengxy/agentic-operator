/**
 * Password hashing (P6-AUTH) — scrypt via `node:crypto`.
 *
 * We deliberately avoid an argon2/bcrypt native dependency: this project is
 * already sensitive to native-module ABI breakage (better-sqlite3 / Node 26),
 * and scrypt is a memory-hard KDF built into Node with no compilation step.
 *
 * Stored format (single column, self-describing):
 *
 *     scrypt$<N>$<saltB64>$<hashB64>
 *
 * `N` is the scrypt cost parameter so we can raise it later without breaking
 * existing hashes (verify reads the cost from the stored string).
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const COST = 16384; // scrypt N — ~tens of ms per hash on a modern core
const KEYLEN = 32;
const SALT_BYTES = 16;

/** Hash a plaintext password into the self-describing `scrypt$…` string. */
export function hashPassword(plain: string): string {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, KEYLEN, { N: COST });
  return `scrypt$${COST}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * Verify a plaintext password against a stored hash. Returns false (never
 * throws) on any malformed/legacy/empty stored value so callers can treat
 * "no usable credential" and "wrong password" identically.
 */
export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored || typeof plain !== "string" || plain.length === 0) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const cost = Number(parts[1]);
  if (!Number.isFinite(cost) || cost <= 0) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2]!, "base64");
    expected = Buffer.from(parts[3]!, "base64");
  } catch {
    return false;
  }
  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, expected.length, { N: cost });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
