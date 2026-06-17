# Theme (light/dark) + i18n (中/EN) — Design Spec

*2026-06-17 · Portal (`apps/web`) · Status: approved design, pre-implementation*

## 1. Goal & scope

Make the Agentic Operator portal support **light/dark color modes** and **Chinese/English UI switching**, with both controls discoverable and their state persisted.

Two halves, very different starting points:

- **Theme is ~80% built already.** [`apps/web/styles/tokens.css`](../../../apps/web/styles/tokens.css) defines a full light palette under `html[data-theme="light"]` (lines 65–81) alongside the dark `:root` default. [`use-tweaks.ts`](../../../apps/web/app/portal/components/tweaks/use-tweaks.ts) persists `theme: "dark"|"light"` to localStorage (`agentic.tweaks`) and applies it to `<html data-theme>` on change, with cross-tab sync. A working toggle exists — but only inside the floating developer **Tweaks panel** (`⌘⇧T` / bottom-right cog), which most users never find. The theme work is therefore **surface + polish**, not a rebuild.
- **i18n does not exist.** `<html lang="en">` is hardcoded ([`app/layout.tsx:21`](../../../apps/web/app/layout.tsx)). There is no translation layer, dictionary, or locale state. The only existing Chinese/English split is at the *data* level (RAAS agent titles ship Chinese; `seed:rich` overlays English) — out of scope here. This half is **net-new**.

### In scope
1. Discoverable theme control (top bar + Settings), `system|light|dark`, no first-paint flash.
2. A lightweight i18n layer (custom, zero new deps) covering **chrome + Settings** strings.
3. Language control (top bar + Settings), English default, manual switch, persisted.
4. Make the Tweaks panel readable in dark mode and add a language row.

### Out of scope (YAGNI)
- Translating all portal views' body text, or dynamic data (agent titles, run statuses, event names).
- Locale-prefixed routing (`/en/...`, `/zh/...`) or server-side translation.
- Changing density/accent behavior (surfaced, not redesigned).
- Backend/API changes — this is frontend-only.

### Decisions locked with the user
- Theme half: **surface + polish** (top-bar toggle + Settings section + FOUC fix + "follow system" default + themed Tweaks panel).
- i18n coverage: **chrome + Settings first** (a foundation other views adopt incrementally later).
- Control location: **top bar + Settings** (mirrored).
- Default language: **English**, manual switch, persisted (mirrors theme pattern).
- Theme default: **`system`** for new visitors (an existing stored `dark`/`light` choice is respected). *(Recommended; confirmed via "继续".)*
- Settings placement: **a new "Appearance" section** (not folded into Workspace). *(Recommended; confirmed via "继续".)*

## 2. Current-state facts (grounding)

- Tokens: `apps/web/styles/tokens.css` — dark in `:root`, light in `html[data-theme="light"]`; density in `html[data-density="…"]`. Components consume `var(--token)` inline; **no Tailwind, no CSS-in-JS lib**.
- Preferences: `apps/web/app/portal/components/tweaks/use-tweaks.ts` — `Tweaks` = `{theme, density, liveStream, showDebug, tenant, accent, dataSource}`, localStorage key `agentic.tweaks`, applies `data-theme`/`data-density`/`--signal` in a `useEffect`, syncs across tabs via the `storage` event. **State is per-hook-instance `useState`** — multiple in-tab consumers would NOT stay in sync (the `storage` event does not fire in the originating tab).
- Tweaks panel: `apps/web/app/portal/components/tweaks/panel.tsx` — floating glass card with **hardcoded light colors**; has a Theme radio (dark/light). Mounted once in `chrome.tsx:131`.
- Top bar: `apps/web/app/portal/components/shell/topbar.tsx` — 44px strip; right cluster = Cmd-K search, LIVE/PAUSED, user chip; already calls `useTweaks`. `VIEW_TITLE_CASE` holds hardcoded English view titles.
- Root layout: `apps/web/app/layout.tsx` — Server Component; `<html lang="en" data-theme="dark" data-density="default">` hardcoded; imports `tokens.css` + `global.css`.
- Client providers: `apps/web/app/portal/components/shell/providers.tsx` — `PortalProviders` wraps `QueryClientProvider` + `DirtyProvider`. Natural mount point for the new context.
- Settings: `apps/web/app/portal/components/settings/data.ts` exports `SETTINGS_SECTIONS` (nav registry) and `LOCALES`; sections live in `settings/sections/*.tsx`.

## 3. Architecture

### 3.1 `PreferencesProvider` — single in-tab source of truth
A new client context (`apps/web/app/portal/lib/preferences-context.tsx`) mounted inside `PortalProviders`. It owns the full preferences object (theme, locale, density, accent, liveStream, showDebug, tenant, dataSource), persists to localStorage, and applies side effects to `<html>` exactly once. Rationale: surfacing theme/locale in three places (top bar, Settings, Tweaks panel) requires same-tab sync that the current per-instance `useState` cannot provide.

Responsibilities:
- Hold state; expose `prefs` + a `setPref(key,val | edits)` setter via context.
- Persist to `agentic.tweaks` (extended with `theme:"system"|"light"|"dark"` and `locale:"en"|"zh"`).
- Apply on change: `html.dataset.theme = resolvedTheme` (system → `matchMedia` result), `html.dataset.density`, `--signal`/`--signal-dim`, and `html.lang = locale`.
- Subscribe to `matchMedia('(prefers-color-scheme: dark)')` so a `system` choice live-updates when the OS flips.
- Cross-tab sync via the `storage` event (preserve existing behavior).

`useTweaks()` is rewritten as a thin consumer of this context returning `[tweaks, setTweak]` — **all existing call sites (topbar, panel, density.ts consumers) keep working unchanged**. This avoids a wide refactor while fixing the sync bug.

### 3.2 i18n layer (Approach A: lightweight custom)
`apps/web/lib/i18n/`:
- `types.ts` — `export type Locale = "en" | "zh"`; the `TranslationKey` union (keys of the `en` dictionary) for compile-time safety.
- `en.ts`, `zh.ts` — plain nested objects, namespaced: `nav.*`, `topbar.*`, `settings.*`, `common.*`, `toast.*`, `empty.*`. `zh` keys must mirror `en` exactly (enforced by test).
- `index.ts` — `translate(locale, key, vars?)`: dot-path lookup, `{var}` interpolation, fallback chain `zh → en → key` (never throws, never blank).

`useI18n()` (exposed from `preferences-context.tsx` or a sibling) returns `{ locale, setLocale, t }` where `t(key, vars?) = translate(locale, key, vars)`. `setLocale` delegates to `setPref("locale", …)` so locale and theme share one persistence + apply path.

Why custom over next-intl/react-i18next: zero new deps (repo norm), no locale-routing refactor (next-intl would collide with `/portal/[tenant]/…` and `next.config.mjs` rewrites), and the chrome-only scope doesn't need ICU/extraction tooling. Namespaced dictionaries keep the door open to full-view translation later.

### 3.3 No-flash (FOUC) inline script
A small synchronous `<script dangerouslySetInnerHTML>` in `app/layout.tsx` `<head>`, running before first paint:
```js
try {
  var t = JSON.parse(localStorage.getItem('agentic.tweaks') || '{}');
  var theme = t.theme || 'system';
  if (theme === 'system')
    theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  var d = document.documentElement;
  d.setAttribute('data-theme', theme);
  if (t.density) d.setAttribute('data-density', t.density);
  if (t.locale) d.setAttribute('lang', t.locale);
} catch (e) {}
```
This eliminates the current dark→light flash and makes the server-rendered `lang` match the user's choice. The provider's apply-effect remains the steady-state owner after hydration; the script only covers first paint. (The hardcoded `data-theme="dark"`/`lang="en"` on `<html>` stay as SSR defaults, immediately corrected by the script.)

## 4. Components & file changes

| File | Change |
|---|---|
| `apps/web/app/portal/lib/preferences-context.tsx` | **New.** `PreferencesProvider`, `usePreferences`, `useI18n`. Owns state, persistence, html side-effects, system-theme listener. |
| `apps/web/app/portal/components/tweaks/use-tweaks.ts` | Rewrite as thin `usePreferences` consumer returning `[tweaks, setTweak]`. Extend `Tweaks.theme` to `"system"|"light"|"dark"`; add `locale`. Keep `DEFAULT_TWEAKS` (default `theme:"system"`, `locale:"en"`). |
| `apps/web/app/portal/components/shell/providers.tsx` | Wrap children in `PreferencesProvider` (outermost, so chrome + Settings + panel share it). |
| `apps/web/app/layout.tsx` | Add the FOUC `<script>` in `<head>`. |
| `apps/web/lib/i18n/{types,en,zh,index}.ts` | **New.** Dictionaries + `translate()`. |
| `apps/web/app/portal/components/shell/topbar.tsx` | Add theme control (sun/moon, popover for System/Light/Dark) + language pill (`EN`/`中`) to the right cluster. Replace hardcoded strings (`VIEW_TITLE_CASE`, search placeholder, LIVE/PAUSED) with `t()`. |
| `apps/web/app/portal/components/shell/sidebar.tsx` + `nav.tsx` | Replace hardcoded nav labels with `t("nav.*")`. |
| `apps/web/app/portal/components/settings/sections/Appearance.tsx` | **New.** Radios: Theme (System/Light/Dark), Language (English/中文); surface Density + Accent. Consumes context. |
| `apps/web/app/portal/components/settings/data.ts` | Register the Appearance section in `SETTINGS_SECTIONS`. |
| `apps/web/app/portal/components/tweaks/panel.tsx` | Restyle to theme tokens (`--panel`/`--text`/`--border`) so it's readable in dark mode; add a Language row. |
| Toasts / shared empty states in chrome + Settings | Swap hardcoded English copy to `t()`. |

Sun/moon/language icons: reuse the existing `Icon` component set (`components/Icon`) if names exist; otherwise add minimal inline SVGs consistent with current icon style.

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
First paint (pre-hydration): inline `<head>` script reads localStorage and sets `data-theme`/`lang` synchronously, so there is no flash and `t()`'s SSR/CSR locale agree.

## 6. Error handling & edge cases
- localStorage unavailable / quota / private mode: read returns defaults, write is swallowed (preserve current `try/catch` behavior). UI still works for the session.
- Corrupt `agentic.tweaks` JSON: `JSON.parse` guarded → defaults.
- Missing translation key: `translate()` falls back `zh → en → key`; never blank, never throws. A dev-only `console.warn` on miss aids authoring.
- `theme:"system"` while OS preference flips at runtime: `matchMedia` `change` listener re-applies the resolved theme without a reload.
- Legacy stored `theme:"dark"|"light"` (pre-`system`): still valid values, respected as-is.
- SSR: provider effects are client-only (`typeof document` guarded); the inline script + hardcoded `<html>` defaults cover the server pass.

## 7. Testing strategy
Web already ships vitest specs (`draft.test.ts`, `Audit.test.ts`, `wizard-wiring.test.ts`), so add alongside:
- `lib/i18n/index.test.ts` — `translate()` interpolation (`{var}`), dot-path lookup, fallback chain (`zh`-miss → `en`, `en`-miss → key).
- `lib/i18n/parity.test.ts` — **every key in `en.ts` exists in `zh.ts` and vice-versa** (no missing/extra translations). This is the guardrail that keeps the two dictionaries honest as they grow.
- `preferences-context.test.ts` — persistence round-trip; `system` resolves via a mocked `matchMedia`; `setPref` updates `<html>` attributes; legacy `dark`/`light` values accepted.
- Manual smoke (per `pnpm dev`): toggle theme in top bar → instant, no flash on reload; toggle language → nav/breadcrumb/Settings switch; the same change reflects in Settings and the Tweaks panel within the tab; cross-tab sync still works.

## 8. Risks & mitigations
- **Same-tab desync** (the core reason for the provider) — mitigated by lifting to one context; covered by the manual smoke step.
- **`useTweaks` call-site breakage** — mitigated by keeping the `[tweaks, setTweak]` signature identical; a typecheck (`pnpm typecheck`) + the existing consumers are the regression net.
- **Translation drift** — mitigated by the parity test failing CI when a key is added to one dictionary only.
- **Scope creep into view bodies** — explicitly deferred; the namespaced dictionary makes later expansion additive, not a rewrite.

## 9. Definition of done
- Top bar shows working theme + language controls; Settings → Appearance mirrors them; the Tweaks panel is readable in dark mode and includes language.
- No first-paint theme flash on reload in either mode; `<html lang>` matches the chosen locale.
- All chrome + Settings strings render in both English and 中文; no missing-key blanks.
- `pnpm --filter @agentic/web typecheck`, `lint`, and the new vitest specs pass.
