/**
 * Portal primitives — public barrel (P2-FE-06).
 *
 * THIS IS THE STABLE PUBLIC CONTRACT for view engineers (B + C).
 *
 * Every primitive lives in `apps/web/app/portal/components/<name>.tsx`. The
 * prop signatures intentionally match v1_1 components.jsx (and the cross-view
 * helpers from views/runs.jsx, views/tasks.jsx, views/agent-code.jsx) so JSX
 * can be copy-pasted from the prototype with minimal modification.
 *
 * Cross-cutting plumbing:
 *   - design/density tokens → `apps/web/styles/tokens.css` (P2-FE-02/20)
 *   - tenant hook           → `apps/web/app/portal/lib/use-tenant.ts` (P2-FE-25)
 *   - formatters            → `apps/web/app/portal/lib/format.ts`
 *
 * Style policy: per audit §7 R-1, every primitive uses inline `style={{}}`.
 * Don't migrate to Tailwind / CSS-in-JS without coordinating with the
 * Foundation engineer — the v1_1 fidelity contract depends on it.
 */

export { Icon, type IconName, type IconProps } from "./Icon";
export {
  Badge,
  ActorTag,
  StatusDot,
  Kbd,
  Empty,
  eventTone,
  type BadgeProps,
  type BadgeTone,
  type ActorTagProps,
  type StatusDotProps,
  type StatusName,
} from "./atoms";
export { Panel, type PanelProps } from "./panel";
export { Stat, type StatProps } from "./stat";
export {
  Sparkline,
  computeSparkPaths,
  type SparklineProps,
  type SparkPaths,
} from "./sparkline";
export { ViewHeader, type ViewHeaderProps } from "./view-header";
export { Button, type ButtonProps, type ButtonTone } from "./button";
export { CountUp, GrowBar } from "./motion";

export {
  SearchInput,
  FilterChip,
  CodeBlock,
  Th,
  Td,
  type SearchInputProps,
  type FilterChipProps,
} from "./inputs";

export { KV, type KVProps } from "./kv";

export { HelpTip } from "./help-tip";

export { Markdown } from "./markdown";

export { Splitter, type SplitterProps } from "./Splitter";
export { ModalOverlay } from "./Modal";

export { MonacoEditor, type MonacoEditorProps } from "./MonacoEditor";

// Cross-cutting plumbing
export { ToastRegion, useToast, type ToastTone } from "./toast";
export { CommandPalette, useCommandPalette } from "./cmd-k";
