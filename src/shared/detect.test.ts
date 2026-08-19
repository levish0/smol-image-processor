import { describe, expect, test } from "bun:test";
import { detectMediaKind } from "./detect";

function ascii(text: string): Buffer {
  return Buffer.from(text, "ascii");
}

describe("detectMediaKind", () => {
  test("detects JPEG", () => {
    expect(detectMediaKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image",
    );
  });

  test("detects PNG", () => {
    expect(
      detectMediaKind(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image");
  });

  test("detects GIF", () => {
    expect(detectMediaKind(ascii("GIF89a..."))).toBe("image");
  });

  test("detects WebP (RIFF/WEBP)", () => {
    const buf = Buffer.concat([ascii("RIFF"), Buffer.alloc(4), ascii("WEBP")]);
    expect(detectMediaKind(buf)).toBe("image");
  });

  test("detects MP4 (ftyp box)", () => {
    const buf = Buffer.concat([Buffer.alloc(4), ascii("ftypisom")]);
    expect(detectMediaKind(buf)).toBe("video");
  });

  test("detects Matroska/WebM (EBML header)", () => {
    expect(detectMediaKind(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe(
      "video",
    );
  });

  test("detects AVI (RIFF/AVI )", () => {
    const buf = Buffer.concat([ascii("RIFF"), Buffer.alloc(4), ascii("AVI ")]);
    expect(detectMediaKind(buf)).toBe("video");
  });

  test("does not confuse WebP with AVI", () => {
    const webp = Buffer.concat([ascii("RIFF"), Buffer.alloc(4), ascii("WEBP")]);
    expect(detectMediaKind(webp)).toBe("image");
  });

  test("returns null for unknown bytes", () => {
    expect(detectMediaKind(ascii("not-a-media-file"))).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(detectMediaKind(Buffer.alloc(0))).toBeNull();
  });
});
