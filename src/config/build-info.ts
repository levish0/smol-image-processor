import sharp from "sharp";
import packageJson from "../../package.json" with { type: "json" };
import type { ImageManifestV1 } from "../contracts/schemas";
import { PROCESSOR_POLICY_DIGEST } from "./policy";

export type BuildFingerprint = ImageManifestV1["build_fingerprint"];

export const BUILD_FINGERPRINT: BuildFingerprint = Object.freeze({
  processor_version: packageJson.version,
  sharp_version: sharp.versions.sharp,
  libvips_version: sharp.versions.vips,
  platform: process.platform,
  architecture: process.arch,
  policy_digest: PROCESSOR_POLICY_DIGEST,
});
