# Agentic Operator Portal — Style Guide

Source-of-truth aesthetic spec for the TSX port (P2-FE-03). The v1_1 SPA at
`agentic-operator_v1_1/` is the visual reference; the audit at
`docs/audits/01-product-design-fidelity.md` enumerates every component, token,
and view in fine-grained detail.

## Inline-style port policy

**All component styling is inline `style={{ ... }}` on JSX.** Do not migrate
to Tailwind, CSS modules, or a CSS-in-JS runtime without coordinating with
the Foundation engineer. The v1_1 prototype is unusual in carrying full
inline style props on every node; matching its pixel fidelity inside a
Tailwind translation would require either a near-complete `@apply` shadow
table or persistent risk of drift. Inline preserves the v1_1 mental model
verbatim — copy-paste JSX from the prototype, replace `var(--foo)`-style
strings as needed, ship.

The only globally-scoped CSS lives in `apps/web/styles/tokens.css`:

- Theme tokens (light + dark)
- Density modes (`--density-mult`)
- The z-index ladder (`--z-base / --z-overlay / --z-modal / --z-toast / --z-tooltip`)
- `@keyframes` (pulse / tick / spin / shimmer / fadein / dot-flow / edge-flow)
- Reset (`* { box-sizing }`, `body { font … }`)
- `::selection`, `::-webkit-scrollbar*`
- A handful of utility classes: `.mono`, `.display`, `.muted`, `.dim`,
  `.nowrap`, `.live-dot`

Anything that can be expressed as an inline style **belongs in the JSX**.

## When you need a pseudo-selector

`:hover` / `:focus` / `:active` cannot be expressed inline. v1_1 worked
around this with local `useState` (e.g. `Button` toggles its background
from `onMouseEnter` / `onMouseLeave`). Keep that pattern for hover.
`:focus-visible` is the one exception — it's global in `tokens.css` to
guarantee every interactive element gets a lime outline ring.

## z-index discipline (P2-FE-26)

Never write a literal `z-index: 50` (or `100`, etc.) inline. Always go
through one of the tokens declared in `tokens.css`:

| Layer       | Token             | Value |
| ----------- | ----------------- | ----- |
| Base        | `--z-base`        | 0     |
| Overlay     | `--z-overlay`     | 100   |
| Modal       | `--z-modal`       | 200   |
| Toast       | `--z-toast`       | 300   |
| Tooltip     | `--z-tooltip`     | 400   |

In TSX, use the variable as a string and let CSS interpret it:

```tsx
style={{ zIndex: "var(--z-modal)" as unknown as number }}
```

The cast is unfortunate — React's CSS typings want `number` for `zIndex`,
but CSS happily accepts a custom property. A future ESLint rule will fail
the build on literal `zIndex: <number>` inside `.tsx` files (P2-FE-26).

## Density (P2-FE-20)

Three modes, configured by `data-density` on `<html>`. The Tweaks panel
mutates the attribute; `tokens.css` translates it to `--density-mult`:

| Density       | `--density-mult` |
| ------------- | ---------------- |
| compact       | 0.85             |
| default       | 1                |
| comfortable   | 1.18             |

If a component needs density-aware sizing, use `calc()` with the shared CSS
variable inside an inline string:

```tsx
style={{ padding: "calc(14px * var(--density-mult))" }}
```

Most primitives don't need density-specific sizing — the prototype's whitespace is forgiving.
Reserve density scaling for KPI rows and table cells where the difference
between 0.85 and 1.18 is visible.

## Adding a new primitive

1. Create the file at `apps/web/app/portal/components/<name>.tsx`. Use
   lowercase-kebab filenames; the barrel re-export is the export the rest of
   the codebase sees.
2. Use `inline style={{}}` per above. If the component needs hover/active
   state, mark it `"use client"` and use local state.
3. Add a named export to `apps/web/app/portal/components/index.ts`.
4. If the prop signature deviates from v1_1, document why in the file
   header — drift here breaks copy-paste portability.
5. Add a Vitest unit test in `apps/web/test/portal/<name>.test.tsx` if the
   component contains pure logic (math, derivation, formatting).

## Things that are NOT inline

- Animations driven by `@keyframes` (they're global; only the
  `animation: <name> Xs Yfn` string is inline)
- Pseudo-element decoration (`::before`, `::after`) — avoid; if you must,
  drop a className and a rule in `tokens.css`
- Print styles — out of scope for v1

## Migration paths the audit flagged

These are documented here so view engineers don't have to dig through the
audit:

- **Monaco from npm, not unpkg.** The `MonacoEditor` primitive in
  `app/portal/components/monaco.tsx` already imports from `monaco-editor`.
  No CDN, no `data:` worker bootstrap.
- **postMessage → localStorage.** The Tweaks panel writes to
  `localStorage["agentic.tweaks"]` instead of posting to a host iframe.
- **window globals → React Query.** Views read live data through
  `useRuns / useEvents / useTasks / useAgents`. The DataContext provides
  the synchronous snapshot (agents, stages, events, sample log) needed by
  the workflow graph and similar static surfaces.
