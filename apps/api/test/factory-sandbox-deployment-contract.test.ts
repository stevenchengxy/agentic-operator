import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd(), "../..");
const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
const productionCompose = readFileSync(
  path.join(root, "docker-compose.production.yml"),
  "utf8",
);
const dockerfile = readFileSync(path.join(root, "apps/api/Dockerfile"), "utf8");
const sandboxRunnerSource = readFileSync(
  path.join(root, "apps/api/src/sandbox-runner.ts"),
  "utf8",
);
const dockerignore = readFileSync(path.join(root, ".dockerignore"), "utf8");
const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");

function between(source: string, start: string, end: string): string {
  const startToken = `\n${start}`;
  const endToken = `\n${end}`;
  const located = source.indexOf(startToken);
  const from = located < 0 ? source.indexOf(start) : located + 1;
  const to = source.indexOf(endToken, from + start.length);
  if (from < 0 || to < 0) throw new Error(`deployment contract section missing: ${start}`);
  return source.slice(from, to);
}

describe("external Factory sandbox deployment contract", () => {
  it("keeps every atomic manifest staging directory on its models filesystem", () => {
    const api = between(compose, "  api:\n", "  web:\n");
    const workload = between(compose, "  sandbox-workload:\n", "  sandbox-inngest:\n");
    const runtime = between(
      dockerfile,
      "FROM ${NODE_BASE_IMAGE} AS runtime",
      "FROM ${NODE_BASE_IMAGE} AS sandbox-common",
    );

    expect(api).toContain("AGENTIC_MODELS_DIR: /app/models");
    expect(api).toContain("AGENTIC_IMPORTS_DIR: /app/models/.imports");
    expect(api).toMatch(/^\s*-\s+agentic-models:\/app\/models\s*$/m);
    expect(runtime).toContain("ENV AGENTIC_IMPORTS_DIR=/app/models/.imports");
    expect(runtime).toContain("/app/models/.imports");
    expect(workload).toContain("AGENTIC_MODELS_DIR: /sandbox/models");
    expect(workload).toContain("AGENTIC_IMPORTS_DIR: /sandbox/models/.imports");
    expect(workload).toMatch(/^\s*-\s+factory-sandbox-models:\/sandbox\/models\s*$/m);
    expect(gitignore).toMatch(/^models\/\.imports\/$/m);
    expect(dockerignore).toMatch(/^models\/\.imports$/m);
  });

  it("builds distinct control and workload targets without production model bytes", () => {
    const common = between(dockerfile, "FROM ${NODE_BASE_IMAGE} AS sandbox-common", "FROM ${NODE_BASE_IMAGE} AS sandbox-workload-base");
    const workloadBase = between(dockerfile, "FROM ${NODE_BASE_IMAGE} AS sandbox-workload-base", "FROM sandbox-common AS sandbox-control");
    const control = between(dockerfile, "FROM sandbox-common AS sandbox-control", "FROM sandbox-common AS sandbox-broker-gateway");
    const workload = between(dockerfile, "FROM sandbox-workload-base AS sandbox-workload", "FROM ${NODE_BASE_IMAGE} AS codeact-candidate");

    expect(common).not.toMatch(/COPY[^\n]*\/models(?:\s|\/)/);
    expect(dockerfile).toContain("ARG NODE_BASE_IMAGE=node:26-slim");
    expect(control).not.toMatch(/COPY[^\n]*\/tenants(?:\s|\/)/);
    expect(control).not.toContain("sandbox-runner-executor.ts");
    expect(control).not.toContain("bootstrap.ts");
    expect(`${workloadBase}\n${workload}`).toContain("/app/tenants");
    expect(`${workloadBase}\n${workload}`).not.toMatch(/COPY[^\n]*\/models(?:\s|\/)/);
    expect(workload).toContain("mkdir -p /sandbox/models/.imports");
    expect(workload).toContain("ENV AGENTIC_IMPORTS_DIR=/sandbox/models/.imports");
  });

  it("keeps API, signer, executor and broker on explicit internal networks", () => {
    const control = between(compose, "  sandbox-runner:\n", "  sandbox-workload:\n");
    const workload = between(compose, "  sandbox-workload:\n", "  sandbox-inngest:\n");
    const networks = compose.slice(compose.lastIndexOf("\nnetworks:"));

    expect(control).toContain("target: sandbox-control");
    expect(control).toContain("AGENTIC_PROCESS_ROLE: sandbox-runner-control");
    expect(control).toContain("SANDBOX_RUNNER_ROLE: control");
    expect(control).toContain("/internal/health/delete-control");
    expect(control.slice(control.indexOf("    depends_on:")))
      .not.toMatch(/sandbox-workload:\s*[\s\S]*?condition:/);
    expect(workload).toContain("target: sandbox-workload");
    expect(workload).toContain("AGENTIC_PROCESS_ROLE: sandbox-runner-workload");
    expect(workload).toContain("SANDBOX_RUNNER_ROLE: workload");
    expect(workload).toContain("SANDBOX_RUNNER_EGRESS_MODE: deny_all");
    expect(workload).toContain('"devModeEnv":"SANDBOX_INNGEST_DEV_MODE"');
    expect(workload).toContain('SANDBOX_INNGEST_DEV_MODE: "${SANDBOX_INNGEST_DEV_MODE:-1}"');
    expect(workload).not.toMatch(/^\s+INNGEST_DEV:/m);
    expect(workload).toContain("FACTORY_SANDBOX_ATTEMPT_LEASE_MS:");
    expect(workload).toContain("FACTORY_SANDBOX_ATTEMPT_HEARTBEAT_MS:");
    expect(workload).toContain("FACTORY_SANDBOX_DELETE_VERIFY_MS:");
    expect(workload).toContain("SANDBOX_INTERNAL_CONTROL_ORIGIN:");
    expect(workload).not.toContain("SANDBOX_RUNNER_REQUEST_HMAC");
    expect(workload).not.toContain("SANDBOX_RUNNER_RESULT_HMAC");
    expect(workload).toContain("SANDBOX_MODEL_PROXY_TOKEN_FILE:");
    expect(workload).toContain("SANDBOX_MODEL_PROXY_HTTP_ALLOWED_HOSTS:");
    expect(workload).toContain("factory-sandbox-model");
    expect(workload.slice(workload.indexOf("    depends_on:")))
      .toMatch(/sandbox-runner:\s*[\s\S]*?condition: service_healthy/);
    expect(control).not.toContain("SANDBOX_MODEL_PROXY_TOKEN");
    expect(control).not.toContain("FACTORY_SB_MODEL_PROXY_TOKEN");
    expect(control).not.toContain("factory-sandbox-model");
    const api = between(compose, "  api:\n", "  web:\n");
    expect(api).toContain('SANDBOX_INNGEST_DEV_MODE: ""');
    expect(networks).toMatch(/factory-sandbox-control:[\s\S]*?internal: true/);
    expect(networks).toMatch(/factory-sandbox-execution:[\s\S]*?internal: true/);
  });

  it("starts delete control before workload recovery without a production health cycle", () => {
    const control = between(
      productionCompose,
      "  sandbox-runner:\n",
      "  sandbox-workload:\n",
    );
    const workload = between(
      productionCompose,
      "  sandbox-workload:\n",
      "  sandbox-broker-gateway:\n",
    );
    const controlDependencies = control.slice(control.indexOf("    depends_on:"));
    const workloadDependencies = workload.slice(workload.indexOf("    depends_on:"));

    expect(controlDependencies).toMatch(
      /sandbox-broker-gateway:\s*[\s\S]*?condition: service_healthy/,
    );
    expect(controlDependencies).not.toMatch(/sandbox-workload:\s*[\s\S]*?condition:/);
    expect(workloadDependencies).toMatch(
      /sandbox-broker-gateway:\s*[\s\S]*?condition: service_healthy/,
    );
    expect(workloadDependencies).toMatch(
      /sandbox-runner:\s*[\s\S]*?condition: service_healthy/,
    );
    expect(sandboxRunnerSource).toMatch(
      /role === "workload"[\s\S]*?await waitForSandboxDeleteControlReady\([\s\S]*?await sandboxReaper\.reconcileFactorySandboxOrphans\(\{ startup: true \}\)/,
    );
  });
});
