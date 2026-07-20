"use client";

import { useEffect, useRef, useState } from "react";
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
      const payload = parseTestCasePayload(payloadSource);
      await onReplacePayload(testCase.id, payload);
      setNotice("已提交完整 payload。当前批准已失效，等更新后的用例再次出现后再确认。");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "payload 提交失败");
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
      setNotice(`文件已保存为隔离资产（${receipt.bytes} bytes，${receipt.sha256}）。当前批准已失效，请等待新确认。`);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "文件上传失败");
    } finally {
      setBusy(null);
    }
  };

  const unavailable = !testCase.id
    ? "这条用例缺少 canonical id，不能安全绑定测试数据。请让工厂重新生成用例。"
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
        {open ? "收起测试数据" : "补充或替换测试数据"}
      </button>
      {open && (
        <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
            case.id · {testCase.id || "缺失"}
          </div>
          {unavailable && <div role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>{unavailable}</div>}

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, color: "var(--text-2)" }}>
            完整 nested JSON payload
            <textarea
              aria-label={`${testCase.name} 完整 JSON payload`}
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
            {busy === "payload" ? "提交中…" : "保存完整 payload"}
          </button>

          <div style={{ marginTop: 2, border: "1px dashed var(--border-2)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)" }}>二进制 fixture</div>
            <div style={{ fontSize: 10.5, color: "var(--text-3)", lineHeight: 1.45 }}>
              文件内容只上传到本次运行的隔离资产区；界面不会显示文件内容或内部资产标识，工厂只在执行时使用绑定引用。
            </div>
            {binaryDisabledReason && <div role="alert" style={{ color: "var(--amber)", fontSize: 11 }}>{binaryDisabledReason}</div>}
            <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 1fr) minmax(112px, .55fr)", gap: 6 }}>
              <input
                aria-label={`${testCase.name} 二进制写入 JSON Pointer`}
                value={path}
                disabled={disabled || Boolean(unavailable) || Boolean(binaryDisabledReason) || busy !== null}
                onChange={(event) => setPath(event.target.value)}
                placeholder="JSON Pointer，例如 /resume/file"
                style={{ minWidth: 0, fontFamily: "var(--mono)", fontSize: 11, padding: "6px 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }}
              />
              <select
                aria-label={`${testCase.name} 二进制写入方式`}
                value={placement}
                disabled={disabled || Boolean(unavailable) || Boolean(binaryDisabledReason) || busy !== null}
                onChange={(event) => setPlacement(event.target.value as BinaryFixturePlacement | "")}
                style={{ minWidth: 0, fontSize: 11, padding: "6px 7px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }}
              >
                <option value="">选择写入方式…</option>
                <option value="object">对象引用</option>
                <option value="data_url">data URL</option>
                <option value="base64_string">base64 字符串</option>
              </select>
            </div>
            <input
              ref={fileRef}
              aria-label={`${testCase.name} 二进制文件`}
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
              {busy === "binary" ? "上传中…" : "上传并绑定文件"}
            </button>
          </div>

          {notice && <div role="status" style={{ fontSize: 11.5, color: "var(--green)", lineHeight: 1.45 }}>{notice}</div>}
          {error && <div role="alert" style={{ fontSize: 11.5, color: "var(--red)", lineHeight: 1.45 }}>提交失败：{error}</div>}
        </div>
      )}
    </div>
  );
}
