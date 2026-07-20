import { describe, expect, it } from "vitest";
import {
  assertZhaopinProductionRuntimeConfig,
  zhaopinRuntimeConfigIssues,
} from "../src/config/zhaopin-runtime";

const base = {
  RAAS_POSTGRES_URL: "postgres://example.invalid/raas",
  ALLMETA_BASE_URL: "https://allmeta.invalid",
  ALLMETA_API_KEY: "allmeta-test-key",
  ROBOHIRE_API_KEY: "robohire-test-key",
  ROBOHIRE_API_BASE_URL: "https://robohire.invalid",
  ZHAOPIN_RAAS_PERSISTENCE_ENABLED: "1",
  RAAS_RESUME_FETCH_URL_TEMPLATE:
    "https://raas.invalid/resumes/{upload_id}/raw",
};

describe("zhaopin production dependency preflight", () => {
  it("accepts the complete HTTP resume transport profile", () => {
    expect(zhaopinRuntimeConfigIssues(base)).toEqual([]);
    expect(() => assertZhaopinProductionRuntimeConfig(base)).not.toThrow();
  });

  it("accepts complete MinIO transport instead of HTTP", () => {
    const env = {
      ...base,
      RAAS_RESUME_FETCH_URL_TEMPLATE: "",
      MINIO_ENDPOINT: "minio.internal",
      MINIO_ACCESS_KEY: "access",
      MINIO_SECRET_KEY: "secret",
    };
    expect(zhaopinRuntimeConfigIssues(env)).toEqual([]);
  });

  it("fails with configuration names only when dependencies are incomplete", () => {
    expect(() =>
      assertZhaopinProductionRuntimeConfig({
        ...base,
        RAAS_POSTGRES_URL: "",
        RAAS_RESUME_FETCH_URL_TEMPLATE: "",
      }),
    ).toThrow(/RAAS_POSTGRES_URL.*RAAS_RESUME_FETCH_URL_TEMPLATE/);
  });
});
