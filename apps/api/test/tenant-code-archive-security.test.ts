import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import {
  decodeTenantCodeArchive,
  parseTenantCodeTarball,
  TENANT_CODE_ARCHIVE_LIMITS,
} from "../src/routes/v1/tenant-code";

interface TestEntry {
  name: string;
  type?: string;
  content?: Buffer | string;
  declaredSize?: number;
  corruptChecksum?: boolean;
  paddingByte?: number;
}

function tarHeader(entry: TestEntry): Buffer {
  const content = Buffer.isBuffer(entry.content)
    ? entry.content
    : Buffer.from(entry.content ?? "", "utf8");
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  const size = entry.declaredSize ?? content.length;
  header.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "ascii");
  header.write("00000000000 ", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(entry.type ?? "0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  if (entry.corruptChecksum) checksum += 1;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function buildTar(
  entries: TestEntry[],
  options: { terminate?: boolean } = {},
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content ?? "", "utf8");
    blocks.push(tarHeader(entry));
    const declaredSize = entry.declaredSize ?? content.length;
    const padded = Buffer.alloc(Math.ceil(declaredSize / 512) * 512);
    content.copy(padded, 0, 0, Math.min(content.length, padded.length));
    if (entry.paddingByte !== undefined && declaredSize < padded.length) {
      padded[declaredSize] = entry.paddingByte;
    }
    blocks.push(padded);
  }
  if (options.terminate !== false) blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function gzipBase64(tar: Buffer): string {
  return zlib.gzipSync(tar).toString("base64");
}

describe("tenant-code archive security", () => {
  it("accepts a canonical gzip ustar containing regular files and directories", async () => {
    const tar = buildTar([
      { name: "src/", type: "5" },
      { name: "agentic.json", content: '{"slug":"raas"}\n' },
      { name: "src/index.ts", content: "export default {};\n" },
    ]);
    const raw = await decodeTenantCodeArchive(gzipBase64(tar));
    const parsed = parseTenantCodeTarball(raw);
    expect(parsed.map((entry) => [entry.kind, entry.path])).toEqual([
      ["directory", "src"],
      ["file", "agentic.json"],
      ["file", "src/index.ts"],
    ]);
  });

  it.each(["%%%%", "YQ", "YQ==\n", "YQ__"])(
    "rejects non-canonical base64 %j",
    async (encoded) => {
      await expect(decodeTenantCodeArchive(encoded)).rejects.toThrow(/base64/i);
    },
  );

  it("rejects raw tar input and compressed/decompressed size bombs", async () => {
    const tar = buildTar([{ name: "agentic.json", content: "{}" }]);
    await expect(
      decodeTenantCodeArchive(tar.toString("base64")),
    ).rejects.toThrow(/gzip-compressed/);

    const oversizedBase64 = "A".repeat(
      Math.ceil(TENANT_CODE_ARCHIVE_LIMITS.compressedBytes / 3) * 4 + 4,
    );
    await expect(decodeTenantCodeArchive(oversizedBase64)).rejects.toThrow(
      /base64/i,
    );

    const bomb = zlib
      .gzipSync(
        Buffer.alloc(TENANT_CODE_ARCHIVE_LIMITS.uncompressedBytes + 512),
      )
      .toString("base64");
    await expect(decodeTenantCodeArchive(bomb)).rejects.toThrow(/exceeded/i);
  });

  it("rejects checksum corruption, truncated bounds and non-zero padding", () => {
    expect(() =>
      parseTenantCodeTarball(
        buildTar([
          { name: "agentic.json", content: "{}", corruptChecksum: true },
        ]),
      ),
    ).toThrow(/checksum/);

    const truncated = Buffer.concat([
      tarHeader({ name: "agentic.json", declaredSize: 1024 }),
      Buffer.alloc(1024),
    ]);
    expect(() => parseTenantCodeTarball(truncated)).toThrow(
      /bounds|end marker/,
    );

    expect(() =>
      parseTenantCodeTarball(
        buildTar([{ name: "agentic.json", content: "{}", paddingByte: 1 }]),
      ),
    ).toThrow(/padding/);
  });

  it.each([
    "../agentic.json",
    "/agentic.json",
    "src/../../agentic.json",
    "C:/evil",
  ])("rejects unsafe path %j", (name) => {
    expect(() =>
      parseTenantCodeTarball(buildTar([{ name, content: "{}" }])),
    ).toThrow(/unsafe|canonical/);
  });

  it.each(["1", "2", "3", "4", "6", "x", "g", "S", "Z"])(
    "rejects redirecting or unsupported tar type %s",
    (type) => {
      expect(() =>
        parseTenantCodeTarball(buildTar([{ name: "agentic.json", type }])),
      ).toThrow(/unsupported tar entry type/);
    },
  );

  it("rejects duplicate paths and file/directory conflicts", () => {
    expect(() =>
      parseTenantCodeTarball(
        buildTar([
          { name: "agentic.json", content: "{}" },
          { name: "agentic.json", content: "{}" },
        ]),
      ),
    ).toThrow(/duplicate/);

    expect(() =>
      parseTenantCodeTarball(
        buildTar([
          { name: "src/index.ts", content: "x" },
          { name: "src", content: "x" },
        ]),
      ),
    ).toThrow(/conflicts with directory/);
  });

  it("enforces per-file and file-count limits before extraction", () => {
    const large = Buffer.alloc(TENANT_CODE_ARCHIVE_LIMITS.singleFileBytes + 1);
    expect(() =>
      parseTenantCodeTarball(
        buildTar([{ name: "agentic.json", content: large }]),
      ),
    ).toThrow(/exceeds/);

    const files: TestEntry[] = Array.from(
      { length: TENANT_CODE_ARCHIVE_LIMITS.files + 1 },
      (_, index) => ({ name: `f${index}`, content: "" }),
    );
    expect(() => parseTenantCodeTarball(buildTar(files))).toThrow(
      /more than .* files/,
    );
  });

  it("requires a two-block terminator and rejects trailing records", () => {
    expect(() =>
      parseTenantCodeTarball(
        buildTar([{ name: "agentic.json", content: "{}" }], {
          terminate: false,
        }),
      ),
    ).toThrow(/end marker/);

    const valid = buildTar([{ name: "agentic.json", content: "{}" }]);
    const withTrailingHeader = Buffer.concat([
      valid,
      buildTar([{ name: "later", content: "x" }]),
    ]);
    expect(() => parseTenantCodeTarball(withTrailingHeader)).toThrow(
      /after its end/,
    );
  });
});
