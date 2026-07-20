import { describe, expect, it } from "vitest";
import { loadBootstrapAdminConfig } from "../../../packages/db/src/seed";

describe("production bootstrap seed configuration", () => {
  it("requires an explicit email, name, and password", () => {
    expect(() => loadBootstrapAdminConfig({})).toThrow(
      "AGENTIC_BOOTSTRAP_ADMIN_EMAIL is required",
    );
    expect(() =>
      loadBootstrapAdminConfig({
        AGENTIC_BOOTSTRAP_ADMIN_EMAIL: "owner@example.com",
      }),
    ).toThrow("AGENTIC_BOOTSTRAP_ADMIN_NAME is required");
    expect(() =>
      loadBootstrapAdminConfig({
        AGENTIC_BOOTSTRAP_ADMIN_EMAIL: "owner@example.com",
        AGENTIC_BOOTSTRAP_ADMIN_NAME: "Owner",
      }),
    ).toThrow("AGENTIC_BOOTSTRAP_ADMIN_PASSWORD is required");
  });

  it("rejects invalid email and short credentials", () => {
    expect(() =>
      loadBootstrapAdminConfig({
        AGENTIC_BOOTSTRAP_ADMIN_EMAIL: "not-an-email",
        AGENTIC_BOOTSTRAP_ADMIN_NAME: "Owner",
        AGENTIC_BOOTSTRAP_ADMIN_PASSWORD: "long-enough-password",
      }),
    ).toThrow("must be a valid email address");

    expect(() =>
      loadBootstrapAdminConfig({
        AGENTIC_BOOTSTRAP_ADMIN_EMAIL: "owner@example.com",
        AGENTIC_BOOTSTRAP_ADMIN_NAME: "Owner",
        AGENTIC_BOOTSTRAP_ADMIN_PASSWORD: "too-short",
      }),
    ).toThrow("must be at least 12 bytes long");
  });

  it("normalizes identity fields without rewriting the secret", () => {
    expect(
      loadBootstrapAdminConfig({
        AGENTIC_BOOTSTRAP_ADMIN_EMAIL: "  Owner@Example.COM ",
        AGENTIC_BOOTSTRAP_ADMIN_NAME: "  Cheng Yuhan  ",
        AGENTIC_BOOTSTRAP_ADMIN_PASSWORD: "  keep-spaces-secret  ",
      }),
    ).toEqual({
      email: "owner@example.com",
      name: "Cheng Yuhan",
      password: "  keep-spaces-secret  ",
    });
  });

  it("does not recognize the removed shared seed password", () => {
    expect(() =>
      loadBootstrapAdminConfig({
        AGENTIC_SEED_PASSWORD: "legacy-shared-password",
      }),
    ).toThrow("AGENTIC_BOOTSTRAP_ADMIN_EMAIL is required");
  });
});
