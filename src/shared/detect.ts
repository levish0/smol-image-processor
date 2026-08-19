import type { MediaKind } from "./types";

// Sniff the media kind from the file's leading bytes instead of trusting the
// client-supplied content type. Returns null for anything we do not route to a
// processor; the specific processor performs full validation afterwards.
export function detectMediaKind(input: Buffer): MediaKind | null {
  if (isImageSignature(input)) {
    return "image";
  }

  if (isVideoSignature(input)) {
    return "video";
  }

  return null;
}

function isImageSignature(buf: Buffer): boolean {
  // JPEG
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    return true;
  }

  // PNG
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return true;
  }

  // GIF87a / GIF89a
  if (hasAscii(buf, 0, "GIF87a") || hasAscii(buf, 0, "GIF89a")) {
    return true;
  }

  // WebP: RIFF....WEBP
  if (hasAscii(buf, 0, "RIFF") && hasAscii(buf, 8, "WEBP")) {
    return true;
  }

  return false;
}

function isVideoSignature(buf: Buffer): boolean {
  // ISO Base Media File Format (MP4, MOV, M4V, 3GP): "ftyp" box at offset 4.
  if (hasAscii(buf, 4, "ftyp")) {
    return true;
  }

  // Matroska / WebM (EBML header)
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) {
    return true;
  }

  // AVI: RIFF....AVI<space>
  if (hasAscii(buf, 0, "RIFF") && hasAscii(buf, 8, "AVI ")) {
    return true;
  }

  // FLV
  if (hasAscii(buf, 0, "FLV")) {
    return true;
  }

  // MPEG program stream
  if (startsWith(buf, [0x00, 0x00, 0x01, 0xba])) {
    return true;
  }

  return false;
}

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) {
    return false;
  }

  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) {
      return false;
    }
  }

  return true;
}

function hasAscii(buf: Buffer, offset: number, ascii: string): boolean {
  if (buf.length < offset + ascii.length) {
    return false;
  }

  for (let i = 0; i < ascii.length; i++) {
    if (buf[offset + i] !== ascii.charCodeAt(i)) {
      return false;
    }
  }

  return true;
}
