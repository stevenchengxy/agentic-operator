// Phase 4 — real test-input fabrication. The factory's test cases used typed placeholder strings
// (`<field>_demo`), so a file-consuming agent (resume parser, whose first step needs an actual
// PDF) could never be exercised meaningfully. This generates realistic, name/type-aware values
// and a VALID synthetic PDF (byte-offset-correct xref) for file-typed fields. Deterministic (no
// RNG) so the cases are reproducible; pure (returns base64 — no fs needed).

export interface ResumePersona {
  name?: string;
  title?: string;
  skills?: string[];
  email?: string;
  years?: number;
}

const DEFAULT_PERSONA: Required<ResumePersona> = {
  name: "Alex Chen",
  title: "Senior Engineer",
  skills: ["TypeScript", "Go", "PostgreSQL"],
  email: "candidate@example.com",
  years: 5,
};

/** Keep the synthetic PDF ASCII so byte offsets == string indices (the xref table is exact). */
function toAscii(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[^\x20-\x7e]/g, "?");
}

function escPdf(t: string): string {
  return toAscii(t).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Build a minimal, structurally-valid single-page PDF with the persona text drawn on it. The
 *  xref byte offsets are computed from the actual assembled bytes, so a strict parser accepts it. */
export function syntheticResumePdf(persona: ResumePersona = {}): { base64: string; bytes: Uint8Array; text: string } {
  const p = { ...DEFAULT_PERSONA, ...persona };
  const textLines = [
    p.name,
    p.title,
    p.skills?.length ? `Skills: ${p.skills.join(", ")}` : "Skills: —",
    `Experience: ${p.years} years`,
    `Email: ${p.email}`,
  ];
  let content = "BT /F1 14 Tf 72 760 Td 16 TL\n";
  for (const tl of textLines) content += `(${escPdf(String(tl))}) Tj T*\n`;
  content += "ET";

  const objs: Record<number, string> = {
    1: "<</Type/Catalog/Pages 2 0 R>>",
    2: "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    3: "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    4: "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    5: `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
  };

  let body = "%PDF-1.4\n";
  const offsets: Record<number, number> = {};
  for (let i = 1; i <= 5; i++) {
    offsets[i] = body.length; // ASCII ⇒ char index == byte offset
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = body.length;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  const text = body + xref + trailer;
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
  const base64 = Buffer.from(bytes).toString("base64");
  return { base64, bytes, text };
}

/** A field is "file-like" if its type names a file/binary, or its name reads like an attachment /
 *  object key / resume — the cases where a placeholder string would never parse. */
export function isFileField(field: string, type: string): boolean {
  const t = (type || "").toLowerCase();
  if (t.includes("file") || t.includes("binary") || t.includes("pdf") || t.includes("blob") || t.includes("buffer")) return true;
  const f = (field || "").toLowerCase();
  return /resume|cv\b|attachment|document|object_key|objectkey|\bfile\b|file_?key|pdf|upload/.test(f);
}

/** Produce a realistic value for a (field, type), name- and type-aware. File-typed fields get a
 *  base64 synthetic PDF; emails/phones/dates/names get plausible values; primitives keep their
 *  type; everything else falls back to the legacy `<field>_demo` (back-compat). */
export function synthesizeField(field: string, type: string, opts?: { persona?: ResumePersona }): unknown {
  const f = (field || "").toLowerCase();
  const t = (type || "").toLowerCase();

  if (isFileField(field, type)) return syntheticResumePdf(opts?.persona).base64;

  if (t.startsWith("num") || t === "int" || t === "integer" || t === "float" || t === "double") return 1;
  if (t.startsWith("bool")) return true;
  if (t.startsWith("arr") || t.endsWith("[]")) return [];
  if (t.startsWith("obj") || t.startsWith("map") || t.startsWith("json")) return {};

  if (/email/.test(f)) return "candidate@example.com";
  if (/phone|mobile|tel\b/.test(f)) return "13800138000";
  if (/(_at$|_on$|date|deadline|time)/.test(f)) return "2026-06-30";
  if (/(^name$|_name$|full_?name)/.test(f)) return "Alex Chen";
  if (/salary|compensation|pay/.test(f)) return "20k-30k";
  if (/city|location/.test(f)) return "Shanghai";
  if (/title|position|role/.test(f)) return "Senior Engineer";

  return `${field}_demo`;
}
