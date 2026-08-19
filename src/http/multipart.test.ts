import { describe, expect, test } from "bun:test";
import {
  encodeMultipartRelated,
  parseMultipartRequest,
  type MultipartRequestLimits,
} from "./multipart";

const boundary = "smp-test-boundary";

function multipartBody(file: Buffer, recipe = "{}", extra = ""): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="input.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "ascii",
    ),
    file,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="recipe"\r\nContent-Type: application/json\r\n\r\n${recipe}\r\n${extra}--${boundary}--\r\n`,
      "utf8",
    ),
  ]);
}

function request(
  body: NonNullable<ConstructorParameters<typeof Request>[1]>["body"] | Buffer,
  contentLength?: number,
): Request {
  const headers = new Headers({
    "content-type": `multipart/form-data; boundary=${boundary}`,
  });
  if (contentLength !== undefined) {
    headers.set("content-length", String(contentLength));
  }
  return new Request("http://processor.test/v1/images/process", {
    method: "POST",
    headers,
    body: Buffer.isBuffer(body) ? new Uint8Array(body) : body,
  });
}

function limits(
  fileBytes: number,
  envelopeBytes = 64 * 1024,
): MultipartRequestLimits {
  return {
    maxEnvelopeBytes: envelopeBytes,
    maxFileBytes: fileBytes,
    maxRecipeBytes: 1024,
    requireRecipe: true,
    idleTimeoutMilliseconds: 1000,
    signal: new AbortController().signal,
  };
}

describe("parseMultipartRequest", () => {
  test("accepts max-1 and exact file byte boundaries", async () => {
    for (const size of [7, 8]) {
      const body = multipartBody(Buffer.alloc(size, 0x61));
      const parsed = await parseMultipartRequest(
        request(body, body.length),
        limits(8),
      );
      expect(parsed.file.length).toBe(size);
      expect(parsed.recipeText).toBe("{}");
    }
  });

  test("rejects max+1 file bytes", async () => {
    const body = multipartBody(Buffer.alloc(9, 0x61));
    await expect(
      parseMultipartRequest(request(body, body.length), limits(8)),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
  });

  test("rejects an oversized declared Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    await expect(
      parseMultipartRequest(request(stream, 101), limits(8, 100)),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
  });

  test("counts a lengthless chunked body and rejects actual envelope overflow", async () => {
    const body = multipartBody(Buffer.alloc(8, 0x61));
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 7, body.length);
        controller.enqueue(body.subarray(offset, end));
        offset = end;
      },
    });

    await expect(
      parseMultipartRequest(request(stream), limits(8, body.length - 1)),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
  });

  test("coalesces one-byte chunks into bounded file storage", async () => {
    const file = Buffer.alloc(64 * 1024, 0x61);
    const body = multipartBody(file);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === body.length) {
          controller.close();
          return;
        }
        controller.enqueue(body.subarray(offset, offset + 1));
        offset += 1;
      },
    });

    const parsed = await parseMultipartRequest(
      request(stream),
      limits(file.length, body.length),
    );

    expect(parsed.file.equals(file)).toBe(true);
    expect(parsed.recipeText).toBe("{}");
  });

  test("accepts max-1 and exact envelopes and rejects max+1 actual bytes", async () => {
    const under = multipartBody(Buffer.alloc(7, 0x61));
    const exact = multipartBody(Buffer.alloc(8, 0x61));
    const over = multipartBody(Buffer.alloc(9, 0x61));
    const maximum = exact.length;

    await expect(
      parseMultipartRequest(request(under), limits(9, maximum)),
    ).resolves.toMatchObject({ file: Buffer.alloc(7, 0x61) });
    await expect(
      parseMultipartRequest(request(exact), limits(9, maximum)),
    ).resolves.toMatchObject({ file: Buffer.alloc(8, 0x61) });
    await expect(
      parseMultipartRequest(request(over), limits(9, maximum)),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
  });

  test("does not trust a smaller declared Content-Length", async () => {
    const body = multipartBody(Buffer.alloc(8, 0x61));
    await expect(
      parseMultipartRequest(request(body, 1), limits(8, body.length - 1)),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
  });

  test("rejects missing, duplicate, and unknown contract parts", async () => {
    const fileOnly = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\n`,
      ),
      Buffer.from("x"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    await expect(
      parseMultipartRequest(request(fileOnly, fileOnly.length), limits(8)),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });

    const unknown = multipartBody(
      Buffer.from("x"),
      "{}",
      `--${boundary}\r\nContent-Disposition: form-data; name="unknown"\r\n\r\nx\r\n`,
    );
    await expect(
      parseMultipartRequest(request(unknown, unknown.length), limits(8)),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  test("classifies an oversized recipe as a payload limit error", async () => {
    const body = multipartBody(Buffer.from("x"), "0123456789");
    await expect(
      parseMultipartRequest(request(body, body.length), {
        ...limits(8),
        maxRecipeBytes: 9,
      }),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
  });

  test("rejects a trickle body that holds an admission slot idle", async () => {
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\n`,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix);
      },
    });
    await expect(
      parseMultipartRequest(request(stream), {
        ...limits(8),
        idleTimeoutMilliseconds: 20,
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  test("rejects a signal that was already aborted before parsing", async () => {
    const controller = new AbortController();
    controller.abort();
    const body = multipartBody(Buffer.from("x"));
    await expect(
      parseMultipartRequest(request(body), {
        ...limits(8),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  test("requires JSON MIME and rejects duplicate or trailing parts", async () => {
    const wrongMime = multipartBody(Buffer.from("x"))
      .toString()
      .replace("Content-Type: application/json", "Content-Type: text/plain");
    await expect(
      parseMultipartRequest(
        request(Buffer.from(wrongMime), Buffer.byteLength(wrongMime)),
        limits(8),
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });

    const duplicateRecipe = multipartBody(
      Buffer.from("x"),
      "{}",
      `--${boundary}\r\nContent-Disposition: form-data; name="recipe"\r\nContent-Type: application/json\r\n\r\n{}\r\n`,
    );
    await expect(
      parseMultipartRequest(
        request(duplicateRecipe, duplicateRecipe.length),
        limits(8),
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });

    const trailing = Buffer.concat([
      multipartBody(Buffer.from("x")),
      Buffer.from("unexpected trailing bytes"),
    ]);
    await expect(
      parseMultipartRequest(request(trailing, trailing.length), limits(8)),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });
});

describe("encodeMultipartRelated", () => {
  test("emits deterministic manifest-first binary-safe related parts", () => {
    const manifest = '{"schema_version":1}';
    const binary = Buffer.from([0, 1, 2, 255]);
    const first = encodeMultipartRelated(manifest, [
      {
        contentId: "output-a",
        mimeType: "image/webp",
        filename: "a.webp",
        bytes: binary,
      },
    ]);
    const second = encodeMultipartRelated(manifest, [
      {
        contentId: "output-a",
        mimeType: "image/webp",
        filename: "a.webp",
        bytes: binary,
      },
    ]);

    expect(first.contentType).toBe(second.contentType);
    expect(first.body.equals(second.body)).toBe(true);
    expect(first.body.indexOf(Buffer.from("<manifest>"))).toBeLessThan(
      first.body.indexOf(Buffer.from("<output-a>")),
    );
    expect(first.body.includes(binary)).toBe(true);
    expect(first.body.toString("latin1")).toContain(
      "Content-Digest: sha-256=:",
    );
  });
});
