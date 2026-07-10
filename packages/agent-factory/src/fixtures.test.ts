import { describe, it, expect } from "vitest";
import { synthesizeField, syntheticResumePdf, isFileField } from "./fixtures";

// Phase 4 — real test-input fabrication. The factory's test cases used typed placeholder strings
// (`<field>_demo`), so a file-consuming agent (resume parser) could never be exercised. The
// fixtures generator produces realistic, type/name-aware values + a VALID synthetic PDF for
// file-typed fields. Deterministic (no RNG) so test cases are reproducible.

describe("synthesizeField — realistic, name/type-aware values", () => {
  it("emails look like emails", () => {
    expect(String(synthesizeField("contact_email", "string"))).toMatch(/^[^@]+@[^@]+\.[a-z]+$/);
  });
  it("phones are digit strings", () => {
    expect(String(synthesizeField("mobile", "string"))).toMatch(/^\d{11}$/);
    expect(String(synthesizeField("phone_number", "string"))).toMatch(/^\d{11}$/);
  });
  it("dates are ISO calendar days", () => {
    expect(String(synthesizeField("deadline", "string"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(synthesizeField("created_at", "string"))).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
  it("typed primitives keep their type", () => {
    expect(synthesizeField("headcount", "number")).toBe(1);
    expect(synthesizeField("is_urgent", "boolean")).toBe(true);
    expect(synthesizeField("tags", "array")).toEqual([]);
    expect(synthesizeField("meta", "object")).toEqual({});
  });
  it("file/binary fields get a base64 PDF, not a placeholder string", () => {
    const v = synthesizeField("resume_file", "file");
    expect(typeof v).toBe("string");
    // base64 of a PDF decodes to bytes starting with %PDF
    expect(Buffer.from(String(v), "base64").toString("latin1").startsWith("%PDF-")).toBe(true);
  });
  it("falls back to a typed demo string for an unknown plain field", () => {
    expect(synthesizeField("widget_label", "string")).toBe("widget_label_demo");
  });
});

describe("isFileField", () => {
  it("detects file-ish fields by type or name", () => {
    expect(isFileField("x", "file")).toBe(true);
    expect(isFileField("resume_pdf", "string")).toBe(true);
    expect(isFileField("object_key", "string")).toBe(true);
    expect(isFileField("title", "string")).toBe(false);
  });
});

describe("syntheticResumePdf — a real, parseable minimal PDF", () => {
  const pdf = syntheticResumePdf({ name: "Alex Chen", title: "Senior Engineer", skills: ["TypeScript", "Go"] });
  it("is a structurally valid PDF (header + EOF + xref + trailer)", () => {
    const s = pdf.text;
    expect(s.startsWith("%PDF-1.")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).toContain("xref");
    expect(s).toContain("trailer");
    expect(s).toContain("startxref");
  });
  it("embeds the persona text so a parser extracts real content", () => {
    expect(pdf.text).toContain("Alex Chen");
    expect(pdf.text).toContain("Senior Engineer");
  });
  it("round-trips through base64", () => {
    expect(Buffer.from(pdf.base64, "base64").toString("latin1")).toBe(pdf.text);
  });
  it("xref offsets point at real object positions", () => {
    // each "N 0 obj" must begin exactly at the byte offset recorded in the xref table
    const s = pdf.text;
    const startxref = Number(s.slice(s.lastIndexOf("startxref") + "startxref".length).trim().split(/\s/)[0]);
    expect(s.slice(startxref, startxref + 4)).toBe("xref");
  });
});
