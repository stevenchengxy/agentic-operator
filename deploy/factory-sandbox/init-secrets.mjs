#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

function usage() {
  throw new Error(
    "usage: node deploy/factory-sandbox/init-secrets.mjs --secret-root /absolute/secure/path --secret-gid <dedicated-gid>",
  );
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return undefined;
  return process.argv[index + 1];
}

function assertSecureDirectory(directory, secretGid) {
  const info = statSync(directory);
  if (!info.isDirectory()) throw new Error(`${directory} is not a directory`);
  if (
    info.gid !== secretGid
    || (info.mode & 0o050) !== 0o050
    || (info.mode & 0o027) !== 0
  ) {
    throw new Error(`${directory} must be group-owned by ${secretGid}, mode 0750 or stricter`);
  }
}

const rootArg = argument("--secret-root");
if (!rootArg || !path.isAbsolute(rootArg)) usage();
const secretGid = Number(argument("--secret-gid"));
if (!Number.isSafeInteger(secretGid) || secretGid <= 0 || secretGid > 2_147_483_647) usage();
const root = path.resolve(rootArg);
const shared = path.join(root, "shared-with-primary");
const remote = path.join(root, "remote-only");

mkdirSync(shared, { recursive: true, mode: 0o750 });
mkdirSync(remote, { recursive: true, mode: 0o750 });
for (const directory of [root, shared, remote]) {
  chownSync(directory, -1, secretGid);
  chmodSync(directory, 0o750);
  assertSecureDirectory(directory, secretGid);
}

function createOnce(file, value) {
  try {
    writeFileSync(file, `${value}\n`, { encoding: "utf8", flag: "wx", mode: 0o640 });
    chownSync(file, -1, secretGid);
    chmodSync(file, 0o640);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const info = statSync(file);
    if (
      !info.isFile()
      || info.gid !== secretGid
      || (info.mode & 0o040) !== 0o040
      || (info.mode & 0o027) !== 0
    ) {
      throw new Error(`${file} exists but is not a private ${secretGid}-group readable file`);
    }
    return false;
  }
}

const generated = [];
const preserved = [];
function secret(relative, bytes = 32) {
  const file = path.join(root, relative);
  (createOnce(file, randomBytes(bytes).toString("hex")) ? generated : preserved).push(relative);
}

for (const name of [
  "request-hmac",
  "result-hmac",
  "receipt-hmac",
  "model-proxy-token",
]) secret(`shared-with-primary/${name}`);

for (const name of [
  "workload-token",
  "control-bearer",
  "cancel-fence-hmac",
  "gateway-tombstone-hmac",
  "event-key",
  "signing-key",
  "postgres-password",
  "redis-password",
]) secret(`remote-only/${name}`);

const redisPasswordFile = path.join(remote, "redis-password");
const redisPassword = readFileSync(redisPasswordFile, "utf8").trim();
const aclRelative = "remote-only/redis-acl";
(createOnce(
  path.join(root, aclRelative),
  `user default on >${redisPassword} ~* &* +@all`,
) ? generated : preserved).push(aclRelative);

// Never print secret contents. These paths are safe operational metadata.
process.stdout.write(
  `external sandbox secret store initialized; generated=${generated.length}, preserved=${preserved.length}\n`,
);
if (preserved.length > 0) {
  process.stdout.write(
    "existing persistent keys were left unchanged; coordinated rotation is required\n",
  );
}
