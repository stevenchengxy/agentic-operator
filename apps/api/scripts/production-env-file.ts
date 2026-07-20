/**
 * Minimal, strict dotenv codec for the generated production contract.
 *
 * `encodeProductionEnvLine` deliberately writes every value as a JSON string.
 * Double-quoted input therefore uses JSON string semantics so embedded JSON
 * values such as `[\"sha256:...\"]` round-trip without leaving backslashes in
 * the decoded value. Single-quoted input remains literal dotenv text.
 */

export class ProductionEnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionEnvFileError";
  }
}

function malformed(name: string, lineNumber: number): ProductionEnvFileError {
  return new ProductionEnvFileError(
    `malformed quoted value for ${name} on production env line ${lineNumber}`,
  );
}

export function decodeProductionEnvValue(
  raw: string,
  name: string,
  lineNumber: number,
): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw malformed(name, lineNumber);
    try {
      const decoded: unknown = JSON.parse(value);
      if (typeof decoded !== "string") throw malformed(name, lineNumber);
      return decoded;
    } catch (error) {
      if (error instanceof ProductionEnvFileError) throw error;
      throw malformed(name, lineNumber);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.slice(1, -1).includes("'")) {
      throw malformed(name, lineNumber);
    }
    return value.slice(1, -1);
  }
  return value;
}

export function parseProductionEnvText(input: string): Record<string, string> {
  const output: Record<string, string> = {};
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    output[name] = decodeProductionEnvValue(
      line.slice(separator + 1),
      name,
      index + 1,
    );
  }
  return output;
}

export function encodeProductionEnvLine(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new ProductionEnvFileError(`invalid production env name: ${name}`);
  }
  return `${name}=${JSON.stringify(value)}`;
}
