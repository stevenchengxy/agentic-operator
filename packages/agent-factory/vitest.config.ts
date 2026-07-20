import { defineConfig } from "vitest/config";

// #REAL-TYPECHECK — validateAgentCode now runs a real semantic ts.createProgram; the FIRST
// call in each worker parses the ES2022 lib set (~2-5s under parallel suite load, then cached
// process-wide). The vitest default 5s testTimeout sat exactly on that edge — any test whose
// first validate lands in a fresh worker flaked. 20s gives deterministic headroom without
// masking real hangs (the module runners have their own tighter internal timeouts).
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});
