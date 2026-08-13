import { canonicalJson, sha256Digest } from "./canonical-json";

export const PROCESSOR_POLICY_V1 = {
  schema_version: 1,
  deployment: {
    minimum_container_memory_bytes: 2 * 1024 * 1024 * 1024,
  },
  request: {
    max_concurrency: 2,
    max_encoder_concurrency: 4,
    max_idle_seconds: 30,
    max_envelope_bytes: 128 * 1024 * 1024,
  },
  recipe: {
    max_bytes: 64 * 1024,
    max_outputs: 8,
    max_dimension: 8192,
    allow_upscale: false,
  },
  image: {
    max_input_bytes: 10 * 1024 * 1024,
    max_input_pixels: 32_000_000,
    max_decoded_bytes: 128_000_000,
    max_pages: 300,
    max_animation_duration_ms: 300_000,
    max_output_bytes: 10 * 1024 * 1024,
    max_aggregate_output_bytes: 32 * 1024 * 1024,
    max_output_pixels: 32_000_000,
    max_aggregate_output_pixels: 128_000_000,
    max_deadline_ms: 60_000,
  },
  video: {
    max_input_bytes: 100 * 1024 * 1024,
    max_output_bytes: 100 * 1024 * 1024,
    max_duration_seconds: 300,
    max_input_dimension: 8192,
    max_frame_rate: 60,
    max_decode_pixels: 20_000_000_000,
    max_decoder_working_set_bytes: 192 * 1024 * 1024,
    default_child_address_space_bytes: 768 * 1024 * 1024,
    max_output_dimension: 1920,
    max_deadline_ms: 180_000,
    allowed_presets: ["ultrafast", "superfast", "veryfast"],
    default_preset: "veryfast",
    min_crf: 0,
    max_crf: 51,
    max_audio_bitrate_kbps: 320,
  },
} as const;

export const PROCESSOR_POLICY_DIGEST = sha256Digest(
  canonicalJson(PROCESSOR_POLICY_V1),
);
