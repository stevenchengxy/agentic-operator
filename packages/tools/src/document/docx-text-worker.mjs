// Isolated DOCX text extractor.  The parent process supplies only private
// temporary paths and enforces a wall-clock timeout + memory ceiling when it
// launches this worker.  Keeping ZIP/XML parsing outside the API process means
// a malformed/hostile office document cannot take the server down with it.

import { readFile, writeFile } from "node:fs/promises";
import mammoth from "mammoth";

const [inputPath, outputPath, rawLimit] = process.argv.slice(2);
const maxBytes = Number(rawLimit);
if (!inputPath || !outputPath || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
  throw new Error("docx worker requires inputPath, outputPath and a positive byte limit");
}

const input = await readFile(inputPath);
const result = await mammoth.extractRawText({ buffer: input });
const text = result.value?.replace(/\r\n?/g, "\n").trim();
if (!text) throw new Error("DOCX contains no extractable text");
if (Buffer.byteLength(text, "utf8") > maxBytes) {
  throw new Error(`DOCX extracted text exceeds ${maxBytes} bytes`);
}
await writeFile(outputPath, text, { encoding: "utf8", mode: 0o600 });
