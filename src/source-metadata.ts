import { Worker } from "node:worker_threads";
import { MediaProcessingError } from "./errors";
import type { ImageSourceMetadataV1 } from "./contracts";

const MAX_METADATA_FIELDS = 32;
const MAX_METADATA_STRING_BYTES = 512;
const MAX_METADATA_ARRAY_VALUES = 16;

const PICKED_TAGS = [
  "Make",
  "Model",
  "Software",
  "Artist",
  "Copyright",
  "ImageDescription",
  "UserComment",
  "OwnerName",
  "BodySerialNumber",
  "LensMake",
  "LensModel",
  "LensSerialNumber",
  "DateTimeOriginal",
  "OffsetTimeOriginal",
  "GPSLatitude",
  "GPSLongitude",
  "GPSAltitude",
] as const;

const METADATA_WORKER_SOURCE = String.raw`
  const { parentPort } = require("node:worker_threads");
  const { parse } = require("exifr");
  const options = {
    pick: ${JSON.stringify(PICKED_TAGS)},
    mergeOutput: true,
    sanitize: true,
    reviveValues: false,
    makerNote: false,
    userComment: true,
    xmp: false,
    icc: false,
    iptc: false,
    ifd1: false,
  };
  parentPort.once("message", async (input) => {
    try {
      const value = await parse(Buffer.from(input), options);
      parentPort.postMessage({ ok: true, value });
    } catch {
      parentPort.postMessage({ ok: false });
    }
  });
`;

const OUTPUT_TAGS = [
  "Make",
  "Model",
  "Software",
  "Artist",
  "Copyright",
  "ImageDescription",
  "OwnerName",
  "BodySerialNumber",
  "LensMake",
  "LensModel",
  "LensSerialNumber",
  "DateTimeOriginal",
  "OffsetTimeOriginal",
  "latitude",
  "longitude",
  "GPSAltitude",
  "userComment",
] as const;

export type SourceMetadataValue =
  ImageSourceMetadataV1["fields"][number]["value"];

type MetadataWorkerResponse = { ok: true; value: unknown } | { ok: false };

export type SourceMetadataWorker = {
  once(
    event: "message",
    listener: (message: MetadataWorkerResponse) => void,
  ): unknown;
  once(event: "error", listener: () => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  off(
    event: "message",
    listener: (message: MetadataWorkerResponse) => void,
  ): unknown;
  off(event: "error", listener: () => void): unknown;
  off(event: "exit", listener: (code: number) => void): unknown;
  postMessage(value: Uint8Array): void;
  terminate(): Promise<number>;
};

export type SourceMetadataWorkerFactory = () => SourceMetadataWorker;

const createSourceMetadataWorker: SourceMetadataWorkerFactory = () =>
  new Worker(METADATA_WORKER_SOURCE, { eval: true });

export async function extractSourceMetadata(
  input: Buffer,
  signal: AbortSignal,
  workerFactory: SourceMetadataWorkerFactory = createSourceMetadataWorker,
): Promise<ImageSourceMetadataV1> {
  const parsed = await parseExifInWorker(input, signal, workerFactory);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { extraction_version: 1, fields: [] };
  }

  const record = parsed as Record<string, unknown>;
  const fields: ImageSourceMetadataV1["fields"] = [];
  for (const name of [...OUTPUT_TAGS].sort()) {
    const value = normalizeValue(record[name], name);
    if (value === undefined) {
      continue;
    }
    fields.push({ name, value, sensitivity: "restricted" });
    if (fields.length === MAX_METADATA_FIELDS) {
      break;
    }
  }

  return { extraction_version: 1, fields };
}

async function parseExifInWorker(
  input: Buffer,
  signal: AbortSignal,
  workerFactory: SourceMetadataWorkerFactory,
): Promise<unknown> {
  if (signal.aborted) {
    throw abortReason(signal);
  }

  const worker = workerFactory();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        operation();
      };
      const onAbort = () => finish(() => reject(abortReason(signal)));
      const onMessage = (message: MetadataWorkerResponse) =>
        finish(() => {
          if (message.ok) {
            resolve(message.value);
          } else {
            reject(metadataError());
          }
        });
      const onError = () => finish(() => reject(metadataError()));
      const onExit = (code: number) => {
        if (code !== 0) {
          finish(() => reject(metadataError()));
        }
      };

      signal.addEventListener("abort", onAbort, { once: true });
      worker.once("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      worker.postMessage(new Uint8Array(input));
    });
  } finally {
    await worker.terminate();
  }
}

function abortReason(signal: AbortSignal): MediaProcessingError {
  return signal.reason instanceof MediaProcessingError
    ? signal.reason
    : new MediaProcessingError("invalid_request", "Request was cancelled");
}

function metadataError(): MediaProcessingError {
  return new MediaProcessingError(
    "invalid_image",
    "Cannot safely extract source metadata",
  );
}

function normalizeValue(
  value: unknown,
  name: (typeof OUTPUT_TAGS)[number],
): SourceMetadataValue | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return truncateUtf8(value, MAX_METADATA_STRING_BYTES);
  }
  if (Array.isArray(value)) {
    const numbers = value
      .filter(
        (item): item is number =>
          typeof item === "number" && Number.isFinite(item),
      )
      .slice(0, MAX_METADATA_ARRAY_VALUES);
    return numbers.length === 0 ? undefined : numbers;
  }
  if (name === "userComment" && value instanceof Uint8Array) {
    return decodeExifUserComment(value);
  }
  return undefined;
}

function decodeExifUserComment(value: Uint8Array): string | undefined {
  if (value.byteLength <= 8) {
    return undefined;
  }
  const prefix = Buffer.from(value.subarray(0, 8)).toString("ascii");
  const payload = value.subarray(8);
  if (prefix.startsWith("ASCII")) {
    return truncateUtf8(
      Buffer.from(payload).toString("latin1").replace(/\0+$/g, ""),
      MAX_METADATA_STRING_BYTES,
    );
  }
  if (prefix.startsWith("UNICODE")) {
    const evenLength = payload.byteLength - (payload.byteLength % 2);
    const bytes = payload.subarray(0, evenLength);
    const bigEndian =
      bytes.length < 2 || !(bytes[0] === 0xff && bytes[1] === 0xfe);
    const normalized = Buffer.alloc(bytes.length);
    if (bigEndian) {
      for (let index = 0; index < bytes.length; index += 2) {
        normalized[index] = bytes[index + 1] ?? 0;
        normalized[index + 1] = bytes[index] ?? 0;
      }
    } else {
      normalized.set(bytes);
    }
    return truncateUtf8(
      normalized.toString("utf16le").replace(/^\uFEFF|\0+$/g, ""),
      MAX_METADATA_STRING_BYTES,
    );
  }
  return undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) {
    return value;
  }

  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return encoded.subarray(0, end).toString("utf8");
}
