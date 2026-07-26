import { readFile } from "node:fs/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

import { sha256Hex } from "./hash.mjs";
import { assertLibraryIndex, assertVendorSnapshot } from "./library-catalog.mjs";
import { activeCatalogTransportObjectKeys } from "./library-generation.mjs";

export const LIBRARY_INDEX_OBJECT_KEY = "libraries/v1/index.json";

export async function assertPublishedWithdrawalCommitted(
  s3,
  {
    bucket,
    localIndexFile,
    packageId,
    packageVersion,
    indexObjectKey = LIBRARY_INDEX_OBJECT_KEY,
  },
) {
  const [localIndexBytes, remoteIndexBytes] = await Promise.all([
    readFile(localIndexFile),
    getObjectBytes(s3, bucket, indexObjectKey),
  ]);
  if (!localIndexBytes.equals(remoteIndexBytes)) {
    throw new Error(
      `published ${indexObjectKey} does not match the local withdrawal commit point`,
    );
  }

  const index = parseJsonBytes(remoteIndexBytes, indexObjectKey);
  try {
    assertLibraryIndex(index);
  } catch (error) {
    throw new Error(
      `published ${indexObjectKey} is not a valid library index: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const vendorIds = index.vendors.map((vendor) => vendor?.vendor_id);
  if (
    vendorIds.some((vendorId) => typeof vendorId !== "string") ||
    new Set(vendorIds).size !== vendorIds.length
  ) {
    throw new Error(`published ${indexObjectKey} has duplicate or invalid vendors`);
  }
  const snapshots = await Promise.all(
    index.vendors.map((vendor) => readIndexedSnapshot(s3, bucket, vendor)),
  );
  const microsoft = snapshots.find(({ vendorId }) => vendorId === "microsoft")?.value;
  if (!microsoft) throw new Error("published index has no Microsoft snapshot");
  if (
    microsoft.packages.some(
      (packageValue) =>
        packageValue.provenance?.kind === "nuget" &&
        packageValue.provenance.package_id.toLowerCase() === packageId.toLowerCase() &&
        packageValue.provenance.version === packageVersion,
    )
  ) {
    throw new Error(
      `${packageId}@${packageVersion}: published snapshot still references the withdrawn release`,
    );
  }
  return activeCatalogTransportObjectKeys(snapshots);
}

export async function deleteObjectAndVerifyAbsent(s3, { bucket, key }) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isObjectNotFound(error)) return;
    throw error;
  }
  throw new Error(`${key}: R2 object still exists after delete`);
}

export function isObjectNotFound(error) {
  const status = error?.$metadata?.httpStatusCode;
  const code = error?.name ?? error?.Code ?? error?.code;
  return status === 404 || code === "NotFound" || code === "NoSuchKey";
}

export async function getObjectBytes(s3, bucket, key) {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body?.transformToByteArray) {
    throw new Error(`${key}: R2 response body cannot be read`);
  }
  return Buffer.from(await result.Body.transformToByteArray());
}

async function readIndexedSnapshot(s3, bucket, vendor) {
  if (
    typeof vendor?.vendor_id !== "string" ||
    typeof vendor.snapshot_key !== "string" ||
    !Number.isSafeInteger(vendor.snapshot_size_bytes) ||
    typeof vendor.snapshot_sha256 !== "string"
  ) {
    throw new Error("published index contains an invalid vendor descriptor");
  }
  const snapshotBytes = await getObjectBytes(s3, bucket, vendor.snapshot_key);
  if (
    snapshotBytes.length !== vendor.snapshot_size_bytes ||
    sha256Hex(snapshotBytes) !== vendor.snapshot_sha256
  ) {
    throw new Error(
      `published ${vendor.vendor_id} snapshot does not match its index identity`,
    );
  }
  const value = parseJsonBytes(snapshotBytes, vendor.snapshot_key);
  try {
    assertVendorSnapshot(value);
  } catch (error) {
    throw new Error(
      `published ${vendor.vendor_id} snapshot is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (value.vendor.id !== vendor.vendor_id) {
    throw new Error(
      `published ${vendor.vendor_id} snapshot identifies itself as ${value.vendor.id}`,
    );
  }
  return {
    vendorId: vendor.vendor_id,
    value,
  };
}

function parseJsonBytes(bytes, context) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${context}: published object is not valid JSON`, { cause: error });
  }
}
