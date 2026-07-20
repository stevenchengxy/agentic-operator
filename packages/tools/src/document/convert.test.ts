import { describe, expect, it, vi } from "vitest";
import {
  convertDocumentToPdf,
  detectDocumentFormat,
  documentConvert,
  DocumentConversionError,
} from "./convert";

const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF", "utf8");

describe("document.convert", () => {
  it("detects real format from bytes instead of extension/mime", () => {
    expect(detectDocumentFormat(pdf, "resume.docx")).toBe("pdf");
    expect(detectDocumentFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]), "resume.pdf")).toBe("docx");
    expect(detectDocumentFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("doc");
    expect(detectDocumentFormat(Buffer.from("# Candidate\nTypeScript", "utf8"), "resume.md")).toBe("markdown");
    expect(detectDocumentFormat(Buffer.from([0, 1, 2, 3]), "resume.txt")).toBe("unknown");
  });

  it("passes a verified PDF through and consumes object-store lastResult", async () => {
    const result = await convertDocumentToPdf(
      {},
      { base64: pdf.toString("base64"), filename: "../candidate.docx", mime: "application/msword" },
    );
    expect(result).toMatchObject({
      filename: "candidate.pdf",
      mime: "application/pdf",
      source_format: "pdf",
      converted: false,
      bytes: pdf.length,
      input_bytes: pdf.length,
    });
    expect(Buffer.from(result.base64, "base64")).toEqual(pdf);

    const descriptorResult = await documentConvert.handler({
      agentName: "ProcessResumeAgent",
      actionName: "document.convert",
      correlationId: "corr-1",
      tenantSlug: "zhaopin",
      event: { name: "tool:document.convert", data: {} },
      lastResult: { base64: pdf.toString("base64"), filename: "resume.pdf", mime: "application/pdf" },
    });
    expect(descriptorResult.data).toMatchObject({ source_format: "pdf", converted: false });
  });

  it("converts validated UTF-8 and DOCX-container bytes through isolated seams", async () => {
    const render = vi.fn(async (text: string) => {
      expect(text).toContain("Candidate");
      return pdf;
    });
    const textResult = await convertDocumentToPdf(
      { base64: Buffer.from("Candidate\nTypeScript", "utf8").toString("base64"), filename: "resume.txt" },
      null,
      {},
      { renderTextToPdf: render },
    );
    expect(textResult).toMatchObject({ source_format: "text", converted: true, mime: "application/pdf" });

    const extractor = vi.fn(async () => "Candidate from DOCX");
    const docxResult = await convertDocumentToPdf(
      { base64: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]).toString("base64"), filename: "resume.docx" },
      null,
      {},
      { extractDocxText: extractor, renderTextToPdf: render },
    );
    expect(extractor).toHaveBeenCalledOnce();
    expect(docxResult).toMatchObject({ source_format: "docx", converted: true });
  });

  it("returns typed terminal errors for legacy DOC/unknown bytes and fails on missing renderer", async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(convertDocumentToPdf(
      { base64: ole.toString("base64"), filename: "resume.doc" },
      null,
    )).rejects.toMatchObject({
      name: "DocumentConversionError",
      code: "legacy_doc_unsupported",
      terminal: true,
      retryable: false,
    });
    await expect(convertDocumentToPdf(
      { base64: Buffer.from([0, 1, 2]).toString("base64"), filename: "fake.pdf" },
      null,
    )).rejects.toMatchObject({ code: "unsupported_document_format", terminal: true });
    await expect(convertDocumentToPdf(
      { base64: Buffer.from("Candidate", "utf8").toString("base64"), filename: "resume.txt" },
      null,
      {},
      { resolveChromium: () => null },
    )).rejects.toMatchObject({ code: "document_dependency_missing", terminal: true });
    await expect(convertDocumentToPdf(
      { base64: Buffer.from("Candidate", "utf8").toString("base64"), filename: "resume.txt" },
      null,
      { chromium_path_env: "MISSING_CHROMIUM" },
      { env: {} },
    )).rejects.toMatchObject({ code: "document_dependency_missing", terminal: true });
  });

  it("rejects non-canonical base64 and enforces configured byte limits", async () => {
    await expect(convertDocumentToPdf({ base64: "not-base64", filename: "x.pdf" }, null))
      .rejects.toBeInstanceOf(DocumentConversionError);
    await expect(convertDocumentToPdf(
      { base64: pdf.toString("base64"), filename: "x.pdf" },
      null,
      { max_input_bytes: 4 },
    )).rejects.toMatchObject({ code: "document_input_too_large" });
  });
});
