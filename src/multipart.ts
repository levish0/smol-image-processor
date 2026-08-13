import Busboy, { type BusboyFileStream } from "@fastify/busboy";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MediaProcessingError, throwIfProcessingAborted } from "./errors";
import { contentDigest } from "./canonical-json";

const MULTIPART_HEADER_BYTES = 8 * 1024;

export type MultipartRequestLimits = {
  maxEnvelopeBytes: number;
  maxFileBytes: number;
  maxRecipeBytes?: number;
  requireRecipe: boolean;
  idleTimeoutMilliseconds: number;
  signal: AbortSignal;
};

export type ParsedMultipartRequest = {
  file: Buffer;
  filename: string;
  mimeType: string;
  recipeText?: string;
};

export async function parseMultipartRequest(
  request: Request,
  limits: MultipartRequestLimits,
): Promise<ParsedMultipartRequest> {
  throwIfProcessingAborted(limits.signal);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new MediaProcessingError(
      "unsupported_media_type",
      "Content-Type must be multipart/form-data",
    );
  }
  const terminalBoundary = multipartTerminalBoundary(contentType);

  assertDeclaredLength(request.headers.get("content-length"), limits);
  if (request.body === null) {
    throw new MediaProcessingError(
      "invalid_request",
      "Request body is required",
    );
  }

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: { "content-type": contentType },
      limits: {
        fieldNameSize: 64,
        fieldSize: limits.maxRecipeBytes ?? 1,
        fields: limits.requireRecipe ? 1 : 0,
        fileSize: limits.maxFileBytes,
        files: 1,
        parts: limits.requireRecipe ? 2 : 1,
        headerPairs: 16,
        headerSize: MULTIPART_HEADER_BYTES,
      },
    });
  } catch {
    throw new MediaProcessingError(
      "invalid_request",
      "Malformed multipart request",
    );
  }

  let file: Buffer | undefined;
  let filename = "upload.bin";
  let mimeType = "application/octet-stream";
  let recipeText: string | undefined;
  let parseError: MediaProcessingError | undefined;
  const pendingFiles: Promise<void>[] = [];

  parser.on(
    "file",
    (fieldName, stream, receivedFilename, _encoding, receivedMimeType) => {
      if (
        fieldName !== "file" ||
        file !== undefined ||
        pendingFiles.length > 0
      ) {
        parseError ??= invalidMultipart("Exactly one file field is required");
        stream.resume();
        return;
      }

      filename = receivedFilename || filename;
      mimeType = receivedMimeType || mimeType;
      pendingFiles.push(
        readFilePart(stream, limits.maxFileBytes)
          .then((value) => {
            file = value;
          })
          .catch((error: unknown) => {
            parseError ??=
              error instanceof MediaProcessingError
                ? error
                : invalidMultipart("Malformed multipart file part");
          }),
      );
    },
  );

  parser.on(
    "field",
    (
      fieldName,
      value,
      fieldNameTruncated,
      valueTruncated,
      _transferEncoding,
      receivedMimeType,
    ) => {
      if (fieldName === "recipe" && valueTruncated) {
        parseError ??= new MediaProcessingError(
          "limit_exceeded",
          "Recipe is too large",
        );
        return;
      }
      if (
        !limits.requireRecipe ||
        fieldName !== "recipe" ||
        recipeText !== undefined ||
        fieldNameTruncated ||
        valueTruncated
      ) {
        parseError ??= invalidMultipart("Exactly one recipe field is required");
        return;
      }
      if (receivedMimeType.toLowerCase() !== "application/json") {
        parseError ??= invalidMultipart(
          "Recipe part Content-Type must be application/json",
        );
        return;
      }
      recipeText = value;
    },
  );

  parser.on("filesLimit", () => {
    parseError ??= invalidMultipart("Too many file fields");
  });
  parser.on("fieldsLimit", () => {
    parseError ??= invalidMultipart("Too many form fields");
  });
  parser.on("partsLimit", () => {
    parseError ??= invalidMultipart("Too many multipart parts");
  });

  const parserFinished = new Promise<void>((resolve, reject) => {
    parser.once("finish", resolve);
    parser.once("error", () =>
      reject(invalidMultipart("Malformed multipart request")),
    );
  });

  let observedBytes = 0;
  const observedTail = Buffer.allocUnsafe(terminalBoundary.length);
  let observedTailLength = 0;
  let envelopeError: MediaProcessingError | undefined;
  let idleError: MediaProcessingError | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      idleError = new MediaProcessingError(
        "invalid_request",
        "Multipart request body became idle",
      );
      counter.destroy(idleError);
      parser.destroy(idleError);
    }, limits.idleTimeoutMilliseconds);
  };
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      resetIdleTimer();
      observedBytes += chunk.length;
      observedTailLength = appendBoundedTail(
        observedTail,
        observedTailLength,
        chunk,
      );
      if (observedBytes > limits.maxEnvelopeBytes) {
        envelopeError = new MediaProcessingError(
          "limit_exceeded",
          "Multipart request is too large",
        );
        callback(envelopeError);
        return;
      }
      callback(null, chunk);
    },
  });

  const source = Readable.fromWeb(request.body as never);
  const abort = () => {
    const error =
      limits.signal.reason instanceof MediaProcessingError
        ? limits.signal.reason
        : new MediaProcessingError("invalid_request", "Request was cancelled");
    source.destroy(error);
    counter.destroy(error);
    parser.destroy(error);
  };
  limits.signal.addEventListener("abort", abort, { once: true });
  resetIdleTimer();
  try {
    await Promise.all([pipeline(source, counter, parser), parserFinished]);
    await Promise.all(pendingFiles);
    if (
      observedTailLength !== terminalBoundary.length ||
      !observedTail.equals(terminalBoundary)
    ) {
      throw invalidMultipart(
        "Multipart request has trailing or incomplete data",
      );
    }
  } catch (error) {
    if (idleError) {
      throw idleError;
    }
    if (envelopeError) {
      throw envelopeError;
    }
    if (error instanceof MediaProcessingError) {
      throw error;
    }
    throw invalidMultipart("Malformed multipart request");
  } finally {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    limits.signal.removeEventListener("abort", abort);
  }

  if (parseError) {
    throw parseError;
  }
  if (file === undefined) {
    throw new MediaProcessingError("invalid_request", "File field is required");
  }
  if (file.length === 0) {
    throw new MediaProcessingError("invalid_request", "Empty file");
  }
  if (limits.requireRecipe && recipeText === undefined) {
    throw new MediaProcessingError(
      "invalid_request",
      "Recipe field is required",
    );
  }

  return {
    file,
    filename,
    mimeType,
    ...(recipeText === undefined ? {} : { recipeText }),
  };
}

function multipartTerminalBoundary(contentType: string): Buffer {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 70) {
    throw invalidMultipart("Multipart boundary is invalid");
  }
  return Buffer.from(`--${boundary}--\r\n`, "ascii");
}

async function readFilePart(
  stream: BusboyFileStream,
  maximumBytes: number,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(maximumBytes);
  let length = 0;
  let hitLimit = false;
  stream.once("limit", () => {
    hitLimit = true;
  });
  for await (const chunk of stream) {
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (source.length > maximumBytes - length) {
      hitLimit = true;
      continue;
    }
    source.copy(bytes, length);
    length += source.length;
  }
  if (hitLimit || stream.truncated) {
    throw new MediaProcessingError("limit_exceeded", "Input file is too large");
  }
  return bytes.subarray(0, length);
}

function appendBoundedTail(
  tail: Buffer,
  tailLength: number,
  chunk: Buffer,
): number {
  if (chunk.length >= tail.length) {
    chunk.copy(tail, 0, chunk.length - tail.length);
    return tail.length;
  }

  const retainedBytes = Math.min(tailLength, tail.length - chunk.length);
  if (retainedBytes > 0) {
    tail.copy(tail, 0, tailLength - retainedBytes, tailLength);
  }
  chunk.copy(tail, retainedBytes);
  return retainedBytes + chunk.length;
}

function assertDeclaredLength(
  header: string | null,
  limits: MultipartRequestLimits,
): void {
  if (header === null) {
    return;
  }
  if (!/^\d+$/.test(header)) {
    throw invalidMultipart("Invalid Content-Length header");
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length)) {
    throw invalidMultipart("Invalid Content-Length header");
  }
  if (length > limits.maxEnvelopeBytes) {
    throw new MediaProcessingError(
      "limit_exceeded",
      "Multipart request is too large",
    );
  }
}

function invalidMultipart(message: string): MediaProcessingError {
  return new MediaProcessingError("invalid_request", message);
}

export type MultipartRelatedPart = {
  contentId: string;
  mimeType: string;
  filename: string;
  bytes: Buffer;
};

export type MultipartRelatedResponse = {
  body: Buffer;
  contentType: string;
};

export function encodeMultipartRelated(
  manifestJson: string,
  parts: MultipartRelatedPart[],
): MultipartRelatedResponse {
  const manifest = Buffer.from(manifestJson, "utf8");
  const ordered = [...parts].sort((left, right) =>
    left.contentId < right.contentId
      ? -1
      : left.contentId > right.contentId
        ? 1
        : 0,
  );
  let suffix = 0;
  let boundary: string;
  do {
    const seed = `${manifestJson}\0${suffix}`;
    boundary = `smp-v1-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
    suffix += 1;
  } while (containsBoundary(manifest, ordered, boundary));

  const chunks: Buffer[] = [];
  pushPart(
    chunks,
    boundary,
    {
      "Content-Type": "application/json; charset=utf-8",
      "Content-ID": "<manifest>",
      "Content-Length": String(manifest.length),
      "Content-Digest": contentDigest(manifest),
    },
    manifest,
  );
  for (const part of ordered) {
    pushPart(
      chunks,
      boundary,
      {
        "Content-Type": part.mimeType,
        "Content-ID": `<${part.contentId}>`,
        "Content-Disposition": `inline; filename="${part.filename}"`,
        "Content-Length": String(part.bytes.length),
        "Content-Digest": contentDigest(part.bytes),
      },
      part.bytes,
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "ascii"));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/related; boundary="${boundary}"; type="application/json"`,
  };
}

function containsBoundary(
  manifest: Buffer,
  parts: MultipartRelatedPart[],
  boundary: string,
): boolean {
  const needle = Buffer.from(boundary, "ascii");
  return (
    manifest.includes(needle) ||
    parts.some((part) => part.bytes.includes(needle))
  );
}

function pushPart(
  chunks: Buffer[],
  boundary: string,
  headers: Record<string, string>,
  body: Buffer,
): void {
  const lines = [`--${boundary}`];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  lines.push("", "");
  chunks.push(
    Buffer.from(lines.join("\r\n"), "ascii"),
    body,
    Buffer.from("\r\n", "ascii"),
  );
}
