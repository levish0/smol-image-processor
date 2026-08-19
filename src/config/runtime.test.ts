import { describe, expect, test } from "bun:test";
import { assertRuntimeDependencies } from "./runtime";

describe("assertRuntimeDependencies", () => {
  test("requires the complete Linux production toolchain", () => {
    const seen: string[] = [];
    assertRuntimeDependencies({
      platform: "linux",
      production: true,
      which(command) {
        seen.push(command);
        return `/usr/bin/${command}`;
      },
    });
    expect(seen).toEqual(["ffmpeg", "ffprobe", "prlimit"]);
  });

  test("fails closed when a production runtime cannot enforce the sandbox", () => {
    expect(() =>
      assertRuntimeDependencies({
        platform: "win32",
        production: true,
        which: () => "available",
      }),
    ).toThrow("Production media processing requires Linux");
    expect(() =>
      assertRuntimeDependencies({
        platform: "linux",
        production: true,
        which: (command) => (command === "prlimit" ? null : command),
      }),
    ).toThrow("Required runtime dependency is unavailable: prlimit");
  });

  test("allows non-Linux development while still requiring media tools", () => {
    expect(() =>
      assertRuntimeDependencies({
        platform: "win32",
        production: false,
        which: (command) => (command === "ffprobe" ? null : command),
      }),
    ).toThrow("Required runtime dependency is unavailable: ffprobe");
  });
});
