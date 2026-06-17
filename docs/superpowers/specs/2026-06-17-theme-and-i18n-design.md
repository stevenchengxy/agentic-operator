# Theme (light/dark) + i18n (中/EN) — Design Spec

*2026-06-17 · Portal (`apps/web`) · Status: approved design, pre-implementation · Rev 2 (post spec-review)*

## 1. Goal & scope

Make the Agentic Operator portal support **light/dark color modes** and **Chinese/English UI switching**, with both controls discoverable and their state persisted.

Two halves, very different starting points:

- **Theme is ~80% built already.** [`apps/web/styles/tokens.css`](../../../apps/web/styles/tokens.css) defines a full light palette under `html[data-theme="light"]` (lines 65–81) alongside the dark `:root` default. [`use-tweaks.ts`](../../../apps/web/app/portal/components/tweaks/use-tweaks.ts) persists `theme: "dark"|"light"` to localStorage (`agentic.tweaks`) and applies it to `<html data-theme>` on change, with cross-tab sync. A working toggle exists — but only inside the floating developer **Tweaks panel** (`⌘⇧T` / bottom-right cog). The theme work is therefore **surface + polish**, not a rebuild.
- **i18n does not exist.** `<html lang="en">` is hardcoded ([`app/layout.tsx:21`](../../../apps/web/app/layout.tsx)). There is no translation layer, dictionary, or locale state. This half is **net-new**.

### In scope
1. Discoverable theme control (top bar + Settings), `system|light|dark`, with the first-paint flash eliminated for explicit choices.
2. A lightweight i18n layer (custom, zero new deps) covering **chrome + Settings** strings.
3. A UI-**language** control (top bar + Settings), English default, manual switch, persisted.
4. Make the Tweaks panel readable in dark mode and add a language row.

### Out of scope (YAGNI)
- Translating all portal views' body text, or dynamic data (agent titles, run statuses, event names).
- Locale-prefixed routing (`/en/...`, `/zh/...`) or full server-side translation of chrome text.
- Changing density/accent behavior (surfaced, not redesigned).
- Backend/API changes outside `apps/web` (this is frontend-only). The Next.js-local `app/api/prefs/route.ts` is **not** modified — see §3.4.
- **Consolidating the two existing preference stores.** The live portal persists via localStorage (`use-tweaks.ts`); a separate cookie store (`lib/prefs.ts` + `/api/prefs`, read by `useWorkspace`) coexists. We deliberately do NOT merge them in this change (§3.4 explains why). The new language field lives in the localStorage store next to `theme`.

### Decisions locked with the user
- Theme half: **surface + polish** (top-bar toggle + Settings section + flash fix + "follow system" default + themed Tweaks panel).
- i18n coverage: **chrome + Settings first** (a foundation other views adopt incrementally later).
- Control location: **top bar + Settings** (mirrored).
- Default language: **English**, manual switch, persisted (mirrors theme pattern).
- Theme default: **`system`** for new visitors (an existing stored `dark`/`light` choice is respected).
- Settings placement: **a new "Appearance" section** (not folded into Workspace).

## 2. Current-state facts (grounding)

- **Tokens:** `apps/web/styles/tokens.css` — dark in `:root`, light in `html[data-theme="light"]`; density in `html[data-density="…"]`. Components consume `var(--token)` inline; **no Tailwind, no CSS-in-JS lib**.
- **Live preferences (localStorage):** `apps/web/app/portal/components/tweaks/use-tweaks.ts` — `Tweaks = {theme, density, liveStream, showDebug, tenant, accent, dataSource}`, key `agentic.tweaks`, applies `data-theme`/`data-density`/`--signal` in a `useEffect`, cross-tab via the `storage` event. **State is per-hook-instance `useState`**, so multiple in-tab consumers would NOT stay in sync (the `storage` event does not fire in the originating tab). `useTweaks` has **exactly two call sites**: `topbar.tsx:46` and `panel.tsx:48` (verified by grep). `useDensity` in `app/portal/lib/density.ts` does **not** call `useTweaks` — it reads `data-density` off the DOM via a `MutationObserver`, so it is unaffected by how the attribute gets set.
- **Separate cookie store (server-readable):** `apps/web/lib/prefs.ts` exposes `readPrefs()` (`cookies()` → `agentic_prefs`, fields `theme/density/accent/tenant/liveStream`) and was built to "Read server-side in layouts to set `<html>` attributes." It is currently consumed **only by `app/_portal_legacy/*`** (the dead SPA-port path) — the live `app/layout.tsx` does NOT call it. `useWorkspace` (`lib/hooks/useWorkspace.ts`) reads/writes the same cookie for `{timezone, locale}`. `app/api/prefs/route.ts`'s zod `Body` allows only `theme/density/accent/tenant/liveStream` (NOT `timezone`/`locale`). This cookie subsystem is partially wired and has its own pre-existing gaps; §3.4 explains why we leave it alone.
- **Existing "Locale" field:** `settings/sections/Workspace.tsx` (line ~117) renders a `Locale` `<SelectIn>` backed by `useWorkspace()` with 6 options (`en-US`,`en-GB`,`zh-CN`,`zh-TW`,`ja-JP`,`ko-KR`) from `data.ts → LOCALES`, whose purpose is **number/date formatting**. This is conceptually distinct from a UI display language — see §3.3.
- **Top bar:** `apps/web/app/portal/components/shell/topbar.tsx` — 44px strip; right cluster = Cmd-K search, LIVE/PAUSED, user chip; already calls `useTweaks`. `VIEW_TITLE_CASE` holds hardcoded English breadcrumb titles.
- **Sidebar:** `apps/web/app/portal/components/shell/sidebar.tsx` — hardcodes **3 group labels** (`Run`, `Observe`, `Manage`) and **11 item labels** (`Dashboard`, `Workflows`, `Agents`, `Runs`, `Events`, `Human tasks`, `Logs`, `Deployments`, `Agentic Tools`, `Tenants`, `Settings`). `nav.tsx` holds only the generic `NavGroup`/`NavItem` primitives (no labels).
- **Root layout:** `apps/web/app/layout.tsx` — Server Component; `<html lang="en" data-theme="dark" data-density="default">` hardcoded; imports `tokens.css` + `global.css`.
- **Client providers:** `apps/web/app/portal/components/shell/providers.tsx` — `PortalProviders` wraps `QueryClientProvider` + `DirtyProvider`. Mount point for the new context.
- **Settings render chain:** `app/portal/[tenant]/(views)/settings/page.tsx` renders sections via a **hardcoded import list + JSX switch** (`{section === "workspace" && <WorkspaceSection />}` … lines 139–147) plus a `ROUTED_SECTIONS` map (line 50). A new section id in `SETTINGS_SECTIONS` (`data.ts`) appears in the nav rail but renders nothing unless this file is also edited.
- **Icons:** `app/portal/components/Icon.tsx` defines `moon` but **no `sun`** and no globe/language glyph. New icons must be added, not reused.

## 3. Architecture

### 3.1 `PreferencesProvider` — single in-tab source of truth
A new client context (`apps/web/app/portal/lib/preferences-context.tsx`) mounted inside `PortalProviders`. It owns the preferences object (theme, language, density, accent, liveStream, showDebug, tenant, dataSource), persists to localStorage (`agentic.tweaks`), and applies side effects to `<html>` exactly once. Rationale: surfacing theme/language in three places (top bar, Settings, Tweaks panel) requires same-tab sync that the current per-instance `useState` cannot provide.

Responsibilities:
- Hold state; expose `prefs` + `setPref(key,val | edits)` via context.
- Persist to `agentic.tweaks` (extended with `theme:"system"|"light"|"dark"` and `language:"en"|"zh"`).
- Apply on change: `html.dataset.theme = resolvedTheme` (system → `matchMedia` result), `html.dataset.density`, `--signal`/`--signal-dim`, and `html.lang = language`.
- Subscribe to `matchMedia('(prefers-color-scheme: dark)')` so a `system` choice live-updates when the OS flips.
- Cross-tab sync via the `storage` event (preserve existing behavior).

`useTweaks()` is **rewritten as a thin consumer** of this context returning `[tweaks, setTweak]` with an **identical signature**. Both call sites (`topbar.tsx`, `panel.tsx`) already render inside `PortalProviders`, so no call-site code changes. The only public-type change is widening `Tweaks.theme` from `"dark"|"light"` to `"system"|"light"|"dark"` and adding `language` — both additive. `useDensity`'s `MutationObserver` keeps working because the provider still sets `data-density`.

> `tenant` persistence stays in the provider, but tenant **navigation** stays at the call site: `panel.tsx` keeps its existing `onTenantChange(v)` router push alongside `setTweak("tenant", v)`. The provider never drives navigation.

### 3.2 i18n layer (Approach A: lightweight custom)
`apps/web/lib/i18n/`:
- `types.ts` — `export type Language = "en" | "zh"`; the `TranslationKey` union (keys of the `en` dictionary) for compile-time safety.
- `en.ts`, `zh.ts` — plain nested objects, namespaced: `nav.*` (11 items + 3 group labels), `topbar.*` (breadcrumb view titles, search placeholder, LIVE/PAUSED, Cmd-K), `settings.*` (section nav + Appearance copy), `common.*` (Save/Cancel/Close/…), `toast.*`, `empty.*`. `zh` keys must mirror `en` exactly (enforced by test, §7).
- `index.ts` — `translate(language, key, vars?)`: dot-path lookup, `{var}` interpolation, fallback chain `zh → en → key` (never throws, never blank); dev-only `console.warn` on miss.

`useI18n()` (exposed from `preferences-context.tsx`) returns `{ language, setLanguage, t }` where `t(key, vars?) = translate(language, key, vars)`. `setLanguage` delegates to `setPref("language", …)` so language and theme share one persistence + apply path.

Why custom over next-intl/react-i18next: zero new deps (repo norm), no locale-routing refactor (next-intl would collide with `/portal/[tenant]/…` and `next.config.mjs` rewrites), and the chrome-only scope doesn't need ICU/extraction tooling.

### 3.3 Relationship to the existing Workspace "Locale" field
The new control is named **"Language"** (`language: "en"|"zh"`) and governs **UI chrome text + `<html lang>`**. It is intentionally **orthogonal** to the existing Workspace **"Locale"** (`en-US`/`zh-CN`/…) which governs **number/date formatting** via `useWorkspace`. They coexist:
- Different concern (display language vs regional formatting), different value-space, different store (localStorage vs cookie).
- We do **not** reconcile or auto-link them in this change (changing 中 does not flip the formatting Locale). To prevent confusion, the Workspace "Locale" field's helper text is clarified to "Number & date formatting" (label unchanged), and the Appearance "Language" field carries helper text "Interface language / 界面语言". No behavioral coupling.
- This non-coupling is a deliberate scope boundary; a future change may unify them.

### 3.4 Persistence choice & why the cookie store is left alone
The new language + widened theme live in the **localStorage `agentic.tweaks`** store, because that is what the **live portal already uses** (`use-tweaks.ts` drives the real topbar/panel today). The alternative — consolidating onto the server-readable cookie (`lib/prefs.ts`) to get fully SSR-rendered, zero-flash attributes — was considered and **deferred**: that subsystem is only wired into dead `_portal_legacy` code, its `/api/prefs` schema omits `timezone`/`locale` (a pre-existing inconsistency), and migrating would mean touching the cookie writers, cross-tab semantics, and that route's validation — scope and risk beyond "add theme + language." We therefore keep localStorage as the source of truth and accept the one limitation it imposes (chrome **text** cannot be server-rendered in the chosen language — see §3.5). `lib/prefs.ts`, `/api/prefs`, and `useWorkspace` are untouched.

### 3.5 First-paint behavior (flash handling)
A small synchronous `<script dangerouslySetInnerHTML>` in `app/layout.tsx` `<head>`, before first paint:
```js
try {
  var t = JSON.parse(localStorage.getItem('agentic.tweaks') || '{}');
  var theme = t.theme || 'system';
  if (theme === 'system')
    theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  var d = document.documentElement;
  d.setAttribute('data-theme', theme);
  if (t.density) d.setAttribute('data-density', t.density);
  if (t.language) d.setAttribute('lang', t.language);
} catch (e) {}
```
Because the script mutates `<html>` (server-rendered as `data-theme="dark" lang="en"`) before React hydrates, **`<html>` MUST carry `suppressHydrationWarning`** in `layout.tsx` to avoid a hydration-attribute-mismatch warning. (Standard next-themes pattern.)

**What this guarantees and what it does not:**
- ✅ No **color/theme** flash for explicit `light`/`dark` and for resolved `system` (the script sets `data-theme` pre-paint).
- ✅ `<html lang>` is correct pre-paint (helps a11y/SEO and CSS `:lang()`).
- ⚠️ Chrome **text** rendered by `t()` still comes from React context, which defaults to `en` for the server pass and the first client render (the provider reads `language` from localStorage on mount). So a user with `language:"zh"` saved sees a **one-frame English flash of chrome text** before hydration. This is accepted (it mirrors how theme behaved before, and the attribute-level `lang` is already correct). Eliminating it would require the cookie/SSR path deferred in §3.4.

## 4. Components & file changes

| File | Change |
|---|---|
| `apps/web/app/portal/lib/preferences-context.tsx` | **New.** `PreferencesProvider`, `usePreferences`, `useI18n`. Owns state, persistence, html side-effects, system-theme listener. |
| `apps/web/app/portal/components/tweaks/use-tweaks.ts` | Rewrite as thin `usePreferences` consumer returning `[tweaks, setTweak]`. Extend `Tweaks.theme` → `"system"|"light"|"dark"`; add `language:"en"|"zh"`. `DEFAULT_TWEAKS` gains `theme:"system"`, `language:"en"`. |
| `apps/web/app/portal/components/shell/providers.tsx` | Wrap children in `PreferencesProvider` (outermost, so chrome + Settings + panel share it). |
| `apps/web/app/layout.tsx` | Add the first-paint `<script>` in `<head>`; add `suppressHydrationWarning` to `<html>`. |
| `apps/web/lib/i18n/{types,en,zh,index}.ts` | **New.** Dictionaries (11 nav items + 3 group labels + topbar + settings + common + toast + empty) + `translate()`. |
| `apps/web/app/portal/components/Icon.tsx` | **Add** a `sun` icon (and a `languages`/globe glyph if the language control uses an icon; otherwise the language pill is text `EN`/`中` and only `sun` is needed). |
| `apps/web/app/portal/components/shell/topbar.tsx` | Add theme control (sun/moon, popover for System/Light/Dark) + language pill (`EN`/`中`) to the right cluster. Replace hardcoded strings (`VIEW_TITLE_CASE`, search placeholder, LIVE/PAUSED) with `t()`. |
| `apps/web/app/portal/components/shell/sidebar.tsx` | Replace the 11 item labels + 3 group labels with `t("nav.*")`. |
| `apps/web/app/portal/components/settings/sections/Appearance.tsx` | **New.** Radios: Theme (System/Light/Dark), Language (English/中文); surface Density + Accent. Consumes context. Helper text per §3.3. |
| `apps/web/app/portal/components/settings/data.ts` | Register the `appearance` section in `SETTINGS_SECTIONS`. |
| `apps/web/app/portal/[tenant]/(views)/settings/page.tsx` | **Required wiring:** import `AppearanceSection` and add `{section === "appearance" && <AppearanceSection />}` to the render switch. |
| `apps/web/app/portal/components/settings/sections/Workspace.tsx` | Minor: clarify the existing "Locale" helper text to "Number & date formatting" (§3.3). No behavior change. |
| `apps/web/app/portal/components/tweaks/panel.tsx` | Restyle to theme tokens (`--panel`/`--text`/`--border`) so it's readable in dark mode; add "System" to the Theme radio options; add a Language row. |
| Toasts / shared empty states in chrome + Settings | Swap hardcoded English copy to `t()`. |

### Top-bar layout (target)
```
[breadcrumb …]                 [ ⌘K search ]  [ ◐ ]  [ EN | 中 ]  [▌LIVE]  (LW) Liu Wei
                                                theme   language
```

## 5. Data flow

```
user clicks top-bar toggle / Settings radio / Tweaks panel
        → setPref(key, value)  (PreferencesProvider)
        → setState + writeToStorage('agentic.tweaks')
        → apply-effect: html[data-theme|data-density|lang] + --signal
        → all context consumers (topbar, settings, panel) re-render in sync
        → other tabs: 'storage' event → re-read → same apply path
```
First paint (pre-hydration): the inline `<head>` script sets `data-theme`/`data-density`/`lang` synchronously from localStorage (no theme flash; correct `lang`). Translated **text** resolves from `en` until the provider hydrates (§3.5 caveat).

## 6. Error handling & edge cases
- localStorage unavailable / quota / private mode: read returns defaults, write is swallowed (preserve current `try/catch`). UI still works for the session.
- Corrupt `agentic.tweaks` JSON: `JSON.parse` guarded → defaults (both in the provider and the inline script).
- Missing translation key: `translate()` falls back `zh → en → key`; never blank, never throws; dev `console.warn`.
- `theme:"system"` and the OS preference flips at runtime: `matchMedia` `change` listener re-applies the resolved theme without reload.
- Legacy stored `theme:"dark"|"light"` (pre-`system`): valid values, respected as-is.
- Hydration: `<html suppressHydrationWarning>` suppresses the expected attribute mismatch from the inline script; no other element is mutated pre-hydration.
- SSR: provider effects are client-only (`typeof document` guarded); the inline script + hardcoded `<html>` defaults cover the server pass.

## 7. Testing strategy
Web already ships vitest specs (`draft.test.ts`, `Audit.test.ts`, `wizard-wiring.test.ts` — all verified to exist), so add alongside:
- `lib/i18n/index.test.ts` — `translate()` `{var}` interpolation, dot-path lookup, fallback chain (`zh`-miss → `en`, `en`-miss → key).
- `lib/i18n/parity.test.ts` — **every key in `en.ts` exists in `zh.ts` and vice-versa**, recursively (no missing/extra translations). Guardrail against dictionary drift; also implicitly checks the nav set isn't undersized.
- `preferences-context.test.ts` — persistence round-trip; `system` resolves via a mocked `matchMedia`; `setPref` updates `<html>` attributes; legacy `dark`/`light` accepted; `useTweaks` shim returns the same `[tweaks, setTweak]` shape.
- `settings/page.test.tsx` (or extend an existing settings test) — selecting the `appearance` section renders `AppearanceSection` (guards the §4 wiring gap).
- Manual smoke (`pnpm dev`): toggle theme in top bar → instant, no flash on reload; toggle language → nav/breadcrumb/Settings switch; the same change reflects in Settings and the Tweaks panel within the tab; cross-tab sync still works.

## 8. Risks & mitigations
- **Same-tab desync** (core reason for the provider) — mitigated by one context; covered by manual smoke.
- **`useTweaks` call-site breakage** — mitigated by keeping `[tweaks, setTweak]` identical; `pnpm typecheck` + the 2 known consumers are the net.
- **Translation drift** — parity test fails when a key is added to one dictionary only.
- **Settings section invisible** — explicit `settings/page.tsx` wiring row + the render test.
- **Hydration warning noise** — `suppressHydrationWarning` on `<html>`.
- **"Two Locale-ish controls" confusion** — distinct labels (Language vs Locale) + helper text (§3.3).
- **Scope creep into view bodies / store consolidation** — explicitly deferred; namespaced dictionary makes later expansion additive.

## 9. Definition of done
- Top bar shows working theme + language controls; Settings → Appearance mirrors them and renders; the Tweaks panel is readable in dark mode and includes language + a System theme option.
- No first-paint **theme** flash on reload in either mode for explicit/ resolved-system choices; `<html lang>` matches the chosen language (text-flash caveat per §3.5 documented, not a defect).
- All chrome + Settings strings render in both English and 中文; no missing-key blanks; the existing Workspace "Locale" formatting field is untouched aside from clarified helper text.
- `pnpm --filter @agentic/web typecheck`, `lint`, and the new vitest specs pass.

## 10. Changes from the originally-presented design (Rev 1 → Rev 2)
Driven by spec review against the real code:
1. Added the **required `settings/page.tsx` wiring** (registering in `data.ts` alone renders nothing).
2. Renamed the UI field `locale` → **`language`** to avoid colliding with the existing Workspace **"Locale"** (formatting) field; documented their orthogonality (§3.3).
3. Corrected the "density.ts consumers" claim — `useTweaks` has exactly two call sites; `useDensity` is independent (§2, §3.1).
4. Added **`suppressHydrationWarning`** to `<html>` for the inline-script pattern (§3.5).
5. Enumerated full nav coverage (11 items + 3 group labels) and noted `Agentic Tools`/`Tenants` aren't in `VIEW_TITLE_CASE` (§2, §4).
6. Clarified the Tweaks panel gains a **System** theme option (§4).
7. Reworded the no-flash guarantee: theme + `lang` attribute are flash-free; translated **text** has a one-frame English flash pre-hydration (§3.5).
8. Documented the **existing cookie pref store** (`lib/prefs.ts`/`/api/prefs`/`useWorkspace`) and the explicit decision to leave it untouched (§3.4); noted adding `sun`/language icons (§2, §4).
