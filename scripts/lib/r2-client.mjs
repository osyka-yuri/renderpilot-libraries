// Thin Cloudflare R2 (S3-compatible) client factory. Bucket/endpoint come from
// `catalog.mjs` `r2`; callers import `r2` from catalog when they need config.

import { S3Client } from "@aws-sdk/client-s3";

import { r2 } from "../catalog.mjs";

function assertNonEmptyConfig(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid ${name}: expected a non-empty string.`);
  }
}

/**
 * Build an S3 client pointed at the configured R2 bucket endpoint.
 * Requires `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function createR2Client(env = process.env) {
  assertNonEmptyConfig("r2.bucket", r2.bucket);
  assertNonEmptyConfig("r2.endpoint", r2.endpoint);

  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 credentials missing: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.",
    );
  }

  return new S3Client({
    region: "auto",
    endpoint: r2.endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}
