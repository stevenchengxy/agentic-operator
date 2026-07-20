/** Resolve the server-side API origin without allowing localhost in production. */
export function serverApiUrl(): string {
  const configured = process.env.AGENTIC_API_URL?.trim();
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error(
      "AGENTIC_API_URL is required in production; refusing a localhost API fallback",
    );
  }
  const value = configured || "http://localhost:3540";
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AGENTIC_API_URL must be an absolute http(s) URL");
  }
  return url.toString().replace(/\/$/, "");
}
