import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../docs/", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".md": "text/plain; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

http
  .createServer(async (req, res) => {
    let u = decodeURIComponent((req.url || "/").split("?")[0]);
    if (u === "/") u = "/agent-factory-architecture-diagrams.html";
    const file = normalize(join(root, u));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  })
  .listen(4599, () => console.log("docs static server on http://localhost:4599"));
