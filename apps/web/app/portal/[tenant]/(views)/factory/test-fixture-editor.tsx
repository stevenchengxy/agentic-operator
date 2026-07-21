"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/app/portal/lib/preferences-context";
import type {
  BinaryFixtureFile,
  BinaryFixturePlacement,
  FixtureAssetReceipt,
} from "./test-fixtures";
import { parseTestCasePayload } from "./test-fixtures";

export interface TestFixtureEditorProps {
  testCase: {
    id: string;
    name: string;
    payload?: Record<string, unknown>;
  };
  disabled?: boolean;
  binaryDisabledReason?: string;
  onReplacePayload: (caseId: string, payload: Record<string, unknown>) => Promise<void>;
  onUploadBinary: (input: {
    caseId: string;
    path: string;
    placement: BinaryFixturePlacement;
    file: BinaryFixtureFile;
  }) => Promise<FixtureAssetReceipt>;
}

export function TestFixtureEditor({
  testCase,
  disabled = false,
  binaryDisabledReason,
  onReplacePayload,
  onUploadBinary,
}: TestFixtureEditorProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [payloadSource, setPayloadSource] = useState(() => JSON.stringify(testCase.payload ?? {}, null, 2));
  const [path, setPath] = useState("");
  const [placement, setPlacement] = useState<BinaryFixturePlacement | "">("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"payload" | "binary" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPayloadSource(JSON.stringify(testCase.payload ?? {}, null, 2));
    setPath("");
    setPlacement("");
    setFile(null);
    setBusy(null);
    setError("");
    setNotice("");
    if (fileRef.current) fileRef.current.value = "";
  }, [testCase.id, testCase.payload]);

  const replacePayload = async () => {
    if (disabled || busy || !testCase.id) return;
    setBusy("payload");
    setError("");
    setNotice("");
    try {
      const payload = parseTestCasePayload(payloadSource, t);
      await onReplacePayload(testCase.id, payload);
      setNotice(t("factory.testFixture.notice.payloadSubmitted"));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("factory.testFixture.error.payloadSubmitFailed"));
    } finally {
      setBusy(null);
    }
  };

  const uploadBinary = async () => {
    if (disabled || busy || binaryDisabledReason || !testCase.id || !file || !placement) return;
    setBusy("binary");
    setError("");
    setNotice("");
    try {
      const receipt = await onUploadBinary({
        caseId: testCase.id,
        path,
        placement,
        file,
      });
      setNotice(t("factory.testFixture.notice.binarySaved", { bytes: receipt.bytes, sha256: receipt.sha256 }));
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("factory.testFixture.error.binaryUploadFailed"));
    } finally {
      setBusy(null);
    }
  };

  const unavailable = !testCase.id
    ? t("factory.testFixture.unavailable")
    : "";

  return (
    <div data-test-case-id={testCase.id} style={{ marginTop: 6, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{ padding: 0, border: "none", background: "none", color: "var(--signal)", cursor: disabled ? "default" : "pointer", fontSize: 11.5 }}
      >
        {open ? t("factory.testFixture.toggle.collapse") : t("factory.testFixture.toggle.expand")}
      </button>
      {open && (
        <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
            case.id · {testCase.id || t("factory.testFixture.missing")}
          </div>
          {unavailable && <div role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>{unavailable}</div>}

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, color: "var(--text-2)" }}>
            {t("factory.testFixture.payload.label")}
            <textarea
              aria-label={t("factory.testFixture.payload.ariaLabel", { name: testCase.name })}
              value={payloadSource}
              disabled={disabled || Boolean(unavailable) || busy !== null}
              rows={7}
              spellCheck={false}
              onChange={(event) => setPayloadSource(event.target.value)}
              style={{ resize: "vertical", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.45, padding: "7px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }}
            />
          </label>
          <button
            type="button"
            disabled={disabled || Boolean(unavailable) || busy !== null}
            onClick={() => void replacePayload()}
            style={{ alignSelf: "flex-start", fontSize: 11.5, padding: "5px 10px", borderRadius: 7, border: "1px solid var(--blue)", background: "transparent", color: "var(--blue)", cursor: busy ? "wait" : "pointer", opacity: disabled || unavailable ? 0.5 : 1 }}
          >
            {busy === "payload" ? t("factory.testFixture.payload.submitting") : t("factory.testFixture.payload.save")}
          </button>

          <div style={{ marginTop: 2, border: "1px dashed var(--border-2)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)" }}>{t("factory.testFixture.binary.title")}</div>
            <div style={{ fontSize: 10.5, color: "var(--text-3)", lineHeight: 1.45 }}>
              {t("factory.testFixture.binary.help")}
            </div>
            {binaryDisabledReason && <div role="alert" style={{ color: "var(--amber)", fontSize: 11 }}>{binaryDisabledReason}</div>}
            <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 1fr) minmax(112px, .55fr)", gap: 6 }}>
              <input
                aria-label={t("factory.testFixture.binary.pathAriaLabel", { name: testCase.name })}
                value={path}
                disabled={disabled || Boolean(unavailable) || Boolean(binaryDisabledReason) || busy !== null}
                onChange={(event) => setPath(event.target.value)}
                placeholder={t("factory.testFixture.binary.pathPlaceholder")}
                style={{ minWidth: 0, fontFamily: "var(--mono)", fontSize: 11, padding: "6px 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }}
              />
              <select
                aria-label={t("factory.testFixture.binary.placementAriaLabel", { name: testCase.name })}
                value={placement}
                disabled={disabled || Boolean(unavailable) || Boolean(binaryDisabledReason) || busy !== null}
                onChange={(event) => setPlacement(event.target.value as BinaryFixturePlacement | "")}
                style={{ minWidth: 0, fontSize: 11, padding: "6px 7px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }}
              >
                <option value="">{t("factory.testFixture.binary.placementSelect")}</option>
                <option value="object">{t("factory.testFixture.binary.placementObject")}</option>
                <option value="data_url">{t("factory.testFixture.binary.placementDataUrl")}</option>
                <option value="base64_string">{t("factory.testFixture.binary.placementBase64")}</option>
              </select>
            </div>
            <input
              ref={fileRef}
              aria-label={t("factory.testFixture.binary.fileAriaLabel", { name: testCase.name })}
              type="file"
              disabled={disabled || Boolean(unavailable) || Boolean(binaryDisabledReason) || busy !== null}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              style={{ fontSize: 11, color: "var(--text-2)" }}
            />
            <button
              type="button"
              disabled={disabled || Boolean(unavailable) || Boolean(binaryDisabledReason) || busy !== null || !file || !path.trim() || !placement}
              onClick={() => void uploadBinary()}
              style={{ alignSelf: "flex-start", fontSize: 11.5, padding: "5px 10px", borderRadius: 7, border: "1px solid var(--violet)", background: "transparent", color: "var(--violet)", cursor: busy ? "wait" : "pointer", opacity: disabled || unavailable || binaryDisabledReason || !file || !path.trim() || !placement ? 0.5 : 1 }}
            >
              {busy === "binary" ? t("factory.testFixture.binary.uploading") : t("factory.testFixture.binary.upload")}
            </button>
          </div>

          {notice && <div role="status" style={{ fontSize: 11.5, color: "var(--green)", lineHeight: 1.45 }}>{notice}</div>}
          {error && <div role="alert" style={{ fontSize: 11.5, color: "var(--red)", lineHeight: 1.45 }}>{t("factory.testFixture.error.submissionFailed", { message: error })}</div>}
        </div>
      )}
    </div>
  );
}
