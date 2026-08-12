type RuntimeDependencyOptions = {
  platform: NodeJS.Platform;
  production: boolean;
  which(command: string): string | null;
};

export function assertRuntimeDependencies(
  options: RuntimeDependencyOptions = {
    platform: process.platform,
    production: process.env.NODE_ENV === "production",
    which: (command) => Bun.which(command),
  },
): void {
  if (options.production && options.platform !== "linux") {
    throw new Error("Production media processing requires Linux");
  }

  const commands = [
    "ffmpeg",
    "ffprobe",
    ...(options.platform === "linux" ? ["prlimit"] : []),
  ];
  for (const command of commands) {
    if (options.which(command) === null) {
      throw new Error(`Required runtime dependency is unavailable: ${command}`);
    }
  }
}
