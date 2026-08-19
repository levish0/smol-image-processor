import canonicalize from "canonicalize";
import { createHash } from "node:crypto";

export type Sha256Digest = {
  algorithm: "sha-256";
  value: string;
};

export function canonicalJson(value: unknown): string {
  const result = canonicalize(value);
  if (result === undefined) {
    throw new Error("Value cannot be represented as canonical JSON");
  }
  return result;
}

export function sha256Digest(value: Buffer | string): Sha256Digest {
  return {
    algorithm: "sha-256",
    value: createHash("sha256").update(value).digest("hex"),
  };
}

export function contentDigest(value: Buffer | string): string {
  return `sha-256=:${createHash("sha256").update(value).digest("base64")}:`;
}
