"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/app/portal/lib/preferences-context";

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      element.getClientRects().length > 0,
  );
}

/**
 * Modal — fixed full-screen backdrop with click-to-close.
 *
 * Ported from `workflows.jsx:983-998`, `agents.jsx:1116-1128`, etc. — these
 * were all duplicated in each view in v1_1. Backdrop is `rgba(0,0,0,0.5)`
 * with `backdrop-filter: blur(2px)` and `fadein 0.14s ease`.
 *
 * P2-FE-24 — accessibility:
 *   - The content wrapper carries `role="dialog"` + `aria-modal="true"`.
 *   - `ariaLabel` (or `ariaLabelledBy`) names the dialog so screen
 *     readers announce the modal correctly on open. Most callers pass
 *     a static title — see the per-modal wizards.
 *   - Escape closes the dialog (in addition to the click-outside path).
 *   - Focus moves into the dialog, is contained while Tab-cycling, and is
 *     restored to the opener after close.
 */
export function ModalOverlay({
  onClose,
  children,
  ariaLabel,
  ariaLabelledBy,
}: {
  onClose: () => void;
  children: ReactNode;
  ariaLabel?: string;
  ariaLabelledBy?: string;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;

      const items = focusableElements(dialogRef.current);
      if (items.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (
        e.shiftKey &&
        (active === first || !dialogRef.current.contains(active))
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(document.activeElement)) return;
      const explicit = dialog.querySelector<HTMLElement>(
        "[autofocus], [data-autofocus='true']",
      );
      (explicit ?? focusableElements(dialog)[0] ?? dialog).focus();
    });

    document.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      const opener = returnFocusRef.current;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "var(--z-modal)" as unknown as number,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        backdropFilter: "blur(2px)",
        animation: "fadein 0.14s ease",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={
          ariaLabel ?? (ariaLabelledBy ? undefined : t("common.dialog"))
        }
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
