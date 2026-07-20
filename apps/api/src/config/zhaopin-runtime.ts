const present = (
  env: Record<string, string | undefined>,
  name: string,
): boolean => Boolean(env[name]?.trim());

/** Names only; credential values must never be included in startup errors. */
export function zhaopinRuntimeConfigIssues(
  env: Record<string, string | undefined>,
): string[] {
  const missing = [
    "RAAS_POSTGRES_URL",
    "ALLMETA_BASE_URL",
    "ALLMETA_API_KEY",
    "ROBOHIRE_API_KEY",
    "ROBOHIRE_API_BASE_URL",
  ].filter((name) => !present(env, name));

  const persistence =
    env.ZHAOPIN_RAAS_PERSISTENCE_ENABLED?.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(persistence ?? "")) {
    missing.push("ZHAOPIN_RAAS_PERSISTENCE_ENABLED=1");
  }

  const hasHttpTransport = present(env, "RAAS_RESUME_FETCH_URL_TEMPLATE");
  const minioFields = [
    "MINIO_ENDPOINT",
    "MINIO_ACCESS_KEY",
    "MINIO_SECRET_KEY",
  ];
  const hasMinioTransport = minioFields.every((name) => present(env, name));
  if (!hasHttpTransport && !hasMinioTransport) {
    missing.push(
      "RAAS_RESUME_FETCH_URL_TEMPLATE or complete MINIO_ENDPOINT/MINIO_ACCESS_KEY/MINIO_SECRET_KEY",
    );
  }
  return missing;
}

export function assertZhaopinProductionRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): void {
  const issues = zhaopinRuntimeConfigIssues(env);
  if (issues.length > 0) {
    throw new Error(
      `zhaopin RAAS-v1 production dependencies are incomplete: ${issues.join(", ")}`,
    );
  }
}
