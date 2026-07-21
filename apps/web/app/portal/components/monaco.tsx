"use client";

/**
 * MonacoEditor — TSX wrapper around `monaco-editor` (P2-FE-04).
 *
 * Loads Monaco from the npm package (not the v1_1 unpkg CDN). The
 * `agentic-dark` theme is defined verbatim from v1_1 components.jsx:382-426.
 *
 * Why a one-shot dynamic import?
 *   - Monaco ships ~3 MB of JS and registers global workers. Importing
 *     statically into a server-rendered page would balloon the dev bundle
 *     and crash SSR (`self`/`Worker` are not defined).
 *   - We gate `import("monaco-editor")` behind `useEffect` so it only
 *     evaluates in the browser, after first paint.
 *
 * Workers: we don't wire `MonacoEnvironment.getWorker` because the basic
 * editor + the TypeScript language service work fine off the main thread
 * once Monaco's web-worker auto-fallback fires. If syntax-highlighting in
 * deeper languages stutters, switch to `monaco-editor-webpack-plugin` and
 * register language workers explicitly.
 *
 * Contract (matches v1_1 components.jsx:453-525):
 *   props: { value, onChange?, language?, height?, readOnly?, minHeight? }
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useI18n } from "@/app/portal/lib/preferences-context";

export interface MonacoEditorProps {
  value: string;
  onChange?: (v: string) => void;
  language?: string;
  height?: number | string;
  readOnly?: boolean;
  minHeight?: number;
}

// Module-scoped cache so the theme + diagnostic options register exactly once
// even if a tab unmounts and remounts.
let __themeRegistered = false;
let __monacoLoadPromise: Promise<typeof import("monaco-editor")> | null = null;

async function loadMonaco(): Promise<typeof import("monaco-editor")> {
  if (__monacoLoadPromise) return __monacoLoadPromise;
  __monacoLoadPromise = (async () => {
    const monaco = await import("monaco-editor");
    if (!__themeRegistered) {
      // Theme rules ported from v1_1 components.jsx:382-426.
      monaco.editor.defineTheme("agentic-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
          { token: "", foreground: "ebebef" },
          { token: "comment", foreground: "6f7178", fontStyle: "italic" },
          { token: "keyword", foreground: "b594ff" },
          { token: "keyword.flow", foreground: "b594ff" },
          { token: "storage", foreground: "b594ff" },
          { token: "storage.type", foreground: "b594ff" },
          { token: "string", foreground: "65e0a3" },
          { token: "string.escape", foreground: "65e0a3" },
          { token: "number", foreground: "ffb547" },
          { token: "type", foreground: "84a9ff" },
          { token: "type.identifier", foreground: "84a9ff" },
          { token: "identifier", foreground: "ebebef" },
          { token: "delimiter", foreground: "a8aab1" },
          { token: "tag", foreground: "d0ff00" },
          { token: "key", foreground: "84a9ff" },
          { token: "constant", foreground: "d0ff00" },
        ],
        colors: {
          "editor.background": "#0f0f11",
          "editor.foreground": "#ebebef",
          "editor.lineHighlightBackground": "#18181d",
          "editor.lineHighlightBorder": "#18181d",
          "editorLineNumber.foreground": "#46474d",
          "editorLineNumber.activeForeground": "#a8aab1",
          "editor.selectionBackground": "#393942",
          "editor.inactiveSelectionBackground": "#2c2c34",
          "editorCursor.foreground": "#d0ff00",
          "editorWhitespace.foreground": "#232329",
          "editorIndentGuide.background": "#1d1d23",
          "editorIndentGuide.activeBackground": "#2c2c34",
          "editorBracketMatch.background": "#2c2c34",
          "editorBracketMatch.border": "#5a6e00",
          "scrollbarSlider.background": "#2c2c3460",
          "scrollbarSlider.hoverBackground": "#393942",
          "scrollbarSlider.activeBackground": "#46474d",
          "editorGutter.background": "#0f0f11",
          "editorWidget.background": "#131317",
          "editorWidget.border": "#2c2c34",
          "editorSuggestWidget.background": "#131317",
          "editorSuggestWidget.border": "#2c2c34",
          "editorSuggestWidget.selectedBackground": "#1d1d23",
          "list.hoverBackground": "#18181d",
          focusBorder: "#5a6e00",
        },
      });
      // Light counterpart — maps onto the light token palette (tokens.css
      // `html[data-theme="light"]`) so the editor isn't a dark slab on a
      // white page. Syntax hues are darkened variants of the dark theme's so
      // they clear contrast on white while keeping the same colour language.
      monaco.editor.defineTheme("agentic-light", {
        base: "vs",
        inherit: true,
        rules: [
          { token: "", foreground: "1a1a1d" },
          { token: "comment", foreground: "8c8d94", fontStyle: "italic" },
          { token: "keyword", foreground: "6b3fd4" },
          { token: "keyword.flow", foreground: "6b3fd4" },
          { token: "storage", foreground: "6b3fd4" },
          { token: "storage.type", foreground: "6b3fd4" },
          { token: "string", foreground: "1a7f4b" },
          { token: "string.escape", foreground: "1a7f4b" },
          { token: "number", foreground: "9a6500" },
          { token: "type", foreground: "2b5fd9" },
          { token: "type.identifier", foreground: "2b5fd9" },
          { token: "identifier", foreground: "1a1a1d" },
          { token: "delimiter", foreground: "5a5b62" },
          { token: "tag", foreground: "4d5e00" },
          { token: "key", foreground: "2b5fd9" },
          { token: "constant", foreground: "4d5e00" },
        ],
        colors: {
          "editor.background": "#ffffff",
          "editor.foreground": "#1a1a1d",
          "editor.lineHighlightBackground": "#f5f5f2",
          "editor.lineHighlightBorder": "#f5f5f2",
          "editorLineNumber.foreground": "#b8b9be",
          "editorLineNumber.activeForeground": "#5a5b62",
          "editor.selectionBackground": "#dfe6c2",
          "editor.inactiveSelectionBackground": "#eceee0",
          "editorCursor.foreground": "#4d5e00",
          "editorWhitespace.foreground": "#e3e3df",
          "editorIndentGuide.background": "#ececea",
          "editorIndentGuide.activeBackground": "#d4d4cf",
          "editorBracketMatch.background": "#e8efc9",
          "editorBracketMatch.border": "#c8d985",
          "scrollbarSlider.background": "#d4d4cf80",
          "scrollbarSlider.hoverBackground": "#b8b8b2",
          "scrollbarSlider.activeBackground": "#8c8d94",
          "editorGutter.background": "#ffffff",
          "editorWidget.background": "#ffffff",
          "editorWidget.border": "#d4d4cf",
          "editorSuggestWidget.background": "#ffffff",
          "editorSuggestWidget.border": "#d4d4cf",
          "editorSuggestWidget.selectedBackground": "#f1f1ee",
          "list.hoverBackground": "#f5f5f2",
          focusBorder: "#c8d985",
        },
      });
      // Relax TS diagnostics so imports from "@agentic/runtime" don't error.
      // Monaco 0.51+ moved the typescript helpers from
      // `monaco.languages.typescript` to a top-level `monaco.typescript`
      // namespace; we keep a guarded access path so this works across
      // upgrades.
      const tsNs =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (monaco as any).typescript ?? (monaco as any).languages?.typescript;
      if (tsNs?.typescriptDefaults) {
        tsNs.typescriptDefaults.setDiagnosticsOptions({
          noSemanticValidation: true,
          noSyntaxValidation: false,
        });
        tsNs.typescriptDefaults.setCompilerOptions({
          target: tsNs.ScriptTarget.ES2020,
          allowNonTsExtensions: true,
          moduleResolution: tsNs.ModuleResolutionKind.NodeJs,
          module: tsNs.ModuleKind.ESNext,
          jsx: tsNs.JsxEmit.None,
          allowJs: true,
          esModuleInterop: true,
        });
      }
      __themeRegistered = true;
    }
    return monaco;
  })();
  return __monacoLoadPromise;
}

/** Pick the editor theme from the app's `<html data-theme>` so the code
 *  surface follows light/dark like the rest of the portal. */
function editorThemeName(): "agentic-dark" | "agentic-light" {
  if (typeof document === "undefined") return "agentic-dark";
  return document.documentElement.dataset.theme === "light"
    ? "agentic-light"
    : "agentic-dark";
}

export function MonacoEditor({
  value,
  onChange,
  language = "typescript",
  height = 320,
  readOnly = false,
  minHeight,
}: MonacoEditorProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Use a loose `any` here — Monaco's own `IStandaloneCodeEditor` type would
  // require a top-level static import which defeats the dynamic-import
  // bundle-splitting we rely on.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    loadMonaco()
      .then((monaco) => {
        if (cancelled || !containerRef.current) return;
        editorRef.current = monaco.editor.create(containerRef.current, {
          value: value || "",
          language,
          theme: editorThemeName(),
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 12,
          fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
          fontLigatures: false,
          lineHeight: 18,
          readOnly,
          scrollBeyondLastLine: false,
          renderLineHighlight: "line",
          padding: { top: 12, bottom: 12 },
          tabSize: 2,
          wordWrap: language === "markdown" ? "on" : "off",
          smoothScrolling: true,
          cursorBlinking: "smooth",
          bracketPairColorization: { enabled: true },
          guides: { indentation: true },
        });
        editorRef.current.onDidChangeModelContent(() => {
          onChangeRef.current?.(editorRef.current.getValue());
        });
        setReady(true);
      })
      .catch((err) => {
        // Don't crash the app if Monaco fails to load — leave the loader
        // spinner up and log so devs notice.
        console.error("[MonacoEditor] failed to load", err);
      });

    return () => {
      cancelled = true;
      try {
        editorRef.current?.dispose();
      } catch {
        // ignore
      }
      editorRef.current = null;
    };
    // language and readOnly remount the editor (matches v1_1 deps array).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly]);

  // External value updates — only push when divergent so we don't fight the user.
  useEffect(() => {
    const ed = editorRef.current;
    if (ed && value != null && ed.getValue() !== value) {
      ed.setValue(value);
    }
  }, [value]);

  // Follow the app theme: setTheme is global to Monaco, so flip it whenever
  // `<html data-theme>` changes (top-bar toggle, Settings, or OS in system mode).
  useEffect(() => {
    if (typeof document === "undefined") return;
    let monacoNs: typeof import("monaco-editor") | null = null;
    loadMonaco().then((m) => {
      monacoNs = m;
      m.editor.setTheme(editorThemeName());
    });
    const obs = new MutationObserver(() => {
      monacoNs?.editor.setTheme(editorThemeName());
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  const wrap: CSSProperties = {
    position: "relative",
    height,
    minHeight,
    border: "1px solid var(--border-2)",
    borderRadius: 4,
    overflow: "hidden",
    background: "var(--bg-2)",
  };

  return (
    <div style={wrap}>
      <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
      {!ready && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--bg-2)",
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: "var(--text-3)",
            gap: 8,
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 12,
              height: 12,
              border: "2px solid var(--text-4)",
              borderTopColor: "var(--signal)",
              borderRadius: "50%",
              animation: "spin 0.9s linear infinite",
            }}
          />
          {t("common.loadingEditor")}
        </div>
      )}
    </div>
  );
}
