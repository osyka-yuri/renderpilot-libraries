// Shared content hashing for publication and remote verification.

import { createHash } from "node:crypto";

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function md5Hex(buf) {
  return createHash("md5").update(buf).digest("hex");
}
