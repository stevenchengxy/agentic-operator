// One-off: fire RESUME_INTAKE_REQUESTED for every resume in the Northwind inbox.
// Reuses the JD context (jr_id/jd_title/jd_text) from the most recent prior
// RESUME_INTAKE_REQUESTED event in the ledger so downstream agents get the same
// JD they were scored against before. Node 26 global fetch.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const API = "http://localhost:3501";
const TENANT = "northwind";
const INBOX = "data/resumes/northwind/inbox";
const EVENTS_DIR = "data/logs/northwind/events";

// 1. Recover JD context from the latest RESUME_INTAKE_REQUESTED in the ledger.
function latestJdContext() {
  const files = readdirSync(EVENTS_DIR)
    .filter((f) => f.endsWith(".ndjson"))
    .sort(); // date-named → lexical sort == chronological
  let best = null;
  for (const f of files) {
    const lines = readFileSync(join(EVENTS_DIR, f), "utf8").split("\n");
    for (const ln of lines) {
      if (!ln.includes("RESUME_INTAKE_REQUESTED")) continue;
      try {
        const o = JSON.parse(ln);
        if (o.name === "RESUME_INTAKE_REQUESTED" && o.data?.jd_text) {
          if (!best || (o.ts ?? 0) >= (best.ts ?? 0)) best = o;
        }
      } catch {}
    }
  }
  if (!best) throw new Error("no prior RESUME_INTAKE_REQUESTED with jd_text found");
  return { jr_id: best.data.jr_id, jd_title: best.data.jd_title, jd_text: best.data.jd_text };
}

const jd = latestJdContext();
console.log(`JD context: jr_id=${jd.jr_id} title=${jd.jd_title} jd_text=${jd.jd_text.length} chars`);

const files = readdirSync(INBOX).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
console.log(`Inbox resumes (${files.length}): ${files.join(", ")}\n`);

const stamp = Date.now().toString().slice(-6);
const results = [];
for (const filename of files) {
  const base = filename.replace(/\.pdf$/i, "");
  const subject = `INTAKE-${base}-${stamp}`;
  const body = {
    name: "RESUME_INTAKE_REQUESTED",
    subject,
    source: "operator",
    payload: { filename, jr_id: jd.jr_id, jd_title: jd.jd_title, jd_text: jd.jd_text },
  };
  const res = await fetch(`${API}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentic-tenant": TENANT },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  const ev = json?.data ?? json;
  console.log(`${res.ok ? "OK " : "ERR"} ${res.status}  ${filename.padEnd(18)} subject=${subject}  event_id=${ev?.event_id ?? "?"}  name=${ev?.name ?? "?"}`);
  results.push({ filename, subject, status: res.status, ...ev });
}

console.log(`\nFired ${results.filter((r) => r.status === 200).length}/${results.length} events.`);
