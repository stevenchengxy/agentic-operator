import type {
  ToolDescriptor,
  ToolWriteProbeLifecycle,
} from "@agentic/agent-kit";
import { stableJson } from "@agentic/shared/cassette";
import { globalWriteProbeLifecycleSourceIdentity } from "@agentic/tools";
import { tenantWriteProbeLifecycleSourceIdentity } from "./tenant-native-tool-provider";

export type CodeOwnedToolSource = "tenant_registry" | "global_registry";

export interface WriteProbeLifecycleLookup {
  source: CodeOwnedToolSource;
  descriptor: ToolDescriptor;
  /** The same catalog/source identity that participates in definitionHash. */
  catalogSourceIdentity?: Record<string, unknown>;
}

export interface WriteProbeLifecycleProvider {
  resolve(input: WriteProbeLifecycleLookup): ToolWriteProbeLifecycle | undefined;
}

function expectedLifecycleIdentity(
  sourceIdentity: Record<string, unknown> | undefined,
): unknown {
  return sourceIdentity?.writeProbeLifecycle;
}

/**
 * Resolve only callbacks attached to the exact descriptor selected by runtime
 * precedence. Ontology/declarative rows can describe `probeSafety`, but they
 * cannot install callbacks and therefore never enter this provider.
 *
 * The catalog identity is checked again at the I/O boundary. This prevents a
 * stale catalog snapshot from authorizing a different cleanup implementation.
 */
export const registryWriteProbeLifecycleProvider: WriteProbeLifecycleProvider = {
  resolve(input) {
    const lifecycle = input.descriptor.factoryWriteProbeLifecycle;
    const expected = expectedLifecycleIdentity(input.catalogSourceIdentity);
    if (!lifecycle) {
      if (expected !== undefined) {
        throw new Error(
          "write-probe lifecycle identity exists but the selected runtime descriptor has no lifecycle",
        );
      }
      return undefined;
    }
    const actual = input.source === "tenant_registry"
      ? tenantWriteProbeLifecycleSourceIdentity(lifecycle)
      : globalWriteProbeLifecycleSourceIdentity(lifecycle);
    if (stableJson(actual) !== stableJson(expected)) {
      throw new Error(
        "write-probe lifecycle identity does not match the selected tool definition",
      );
    }
    return lifecycle;
  },
};
