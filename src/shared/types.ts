export type MediaKind = "image" | "video";

export type ProcessedMediaBase = {
  kind: MediaKind;
  bytes: Buffer;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  size: number;
};
