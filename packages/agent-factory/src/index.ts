// @agentic/agent-factory — the autonomous agent-generation factory, migrated from
// the OLD single-app repo into the new monorepo (see migration-report).
//
// Migration status (M1-b in progress): pure, dependency-free logic is ported first.
// Done so far:
//   - egress-guard       SSRF / egress guard for AI-reachable outbound HTTP
//   - spec-types         GeneratedAgentSpec / IoField / ValidationReport / GenEvent …
//   - ontology-types     OntologyAction / OntologyEvent / DomainOntology …
//   - graph              compile + statically verify the event-orchestration graph
//   - contract           assemble Agent/Event contracts + reconcile payload fields
//   - ports              the 4 injected ports (the migration keystone — DI surface)
// Next (M1-c): port the brain (conductor + stream-gateway + tools) against `ports`,
// then M2 implements the ports for the new apps/api + wires the SSE route + UI tab.
// Until then the fully-working factory still runs in the OLD repo.

export * from "./egress-guard";
export * from "./spec-types";
export * from "./ontology-types";
export * from "./graph";
export * from "./contract";
export * from "./acceptance";
export * from "./verification";
export * from "./sandbox-harness";
export * from "./fixtures";
export * from "./run-analysis";
export * from "./model-router";
export * from "./codegen";
export * from "./code-lint";
export * from "./plan-projection";
export * from "./tool-catalog";
export * from "./ports";
// M1-c — the brain:
export * from "./brain-types";
export * from "./stream-gateway";
export * from "./system-prompt";
export * from "./tools";
export * from "./test-cases";
export * from "./conductor";
