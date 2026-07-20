"use client";

/**
 * DirtyContext — tracks unsaved-edit state across the portal.
 *
 * Wave 4 / UC-V11-15: when an operator has an unsaved workflow draft (or
 * any other editor with pending changes), tenant-switch and other
 * destructive navigation should prompt for confirmation instead of silently
 * discarding their work.
 *
 * Usage pattern:
 *
 *   // In the editor view (e.g. workflows/page.tsx):
 *   const dirty = useDirty();
 *   useEffect(() => {
 *     dirty.setDirty("workflow-draft", isDirty ? draftLabel : null);
 *     return () => dirty.setDirty("workflow-draft", null);
 *   }, [isDirty, draftLabel, dirty]);
 *
 *   // Consumers (e.g. useTenantNavigate):
 *   const dirty = useDirty();
 *   if (dirty.isDirty() && !window.confirm(...)) return;
 *
 * The store is intentionally lightweight — it's a Map keyed by scope name,
 * holding an optional human-readable label. Multiple editors can register
 * independently; navigation guards prompt with the joined labels.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface DirtyApi {
  /** Register/clear a dirty scope. Pass `null` to clear. */
  setDirty: (scope: string, label: string | null) => void;
  /** True if any scope is currently dirty. */
  isDirty: () => boolean;
  /** Labels for active dirty scopes, joined for prompt copy. */
  describe: () => string;
}

const DirtyCtx = createContext<DirtyApi | null>(null);

export function DirtyProvider({ children }: { children: ReactNode }) {
  // We hold the map in a ref so navigation guards can read the *latest*
  // value synchronously (window.confirm + router.push race React batching).
  // A state copy keeps consumers re-rendering on change for UI badges.
  const ref = useRef<Map<string, string>>(new Map());
  const [, setVersion] = useState(0);

  const setDirty = useCallback((scope: string, label: string | null) => {
    const cur = ref.current.get(scope);
    if (label == null) {
      if (cur == null) return;
      ref.current.delete(scope);
    } else {
      if (cur === label) return;
      ref.current.set(scope, label);
    }
    setVersion((v) => v + 1);
  }, []);

  const isDirty = useCallback(() => ref.current.size > 0, []);
  const describe = useCallback(
    () => Array.from(ref.current.values()).join(", "),
    [],
  );

  const value = useMemo<DirtyApi>(
    () => ({ setDirty, isDirty, describe }),
    [setDirty, isDirty, describe],
  );

  return <DirtyCtx.Provider value={value}>{children}</DirtyCtx.Provider>;
}

/** Access the live dirty-state registry. Missing provider wiring is a safety
 * error: returning a no-op here would silently bypass unsaved-change guards. */
export function useDirty(): DirtyApi {
  const ctx = useContext(DirtyCtx);
  if (ctx) return ctx;
  throw new Error("useDirty must be used within DirtyProvider");
}
