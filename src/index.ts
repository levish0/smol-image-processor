import { createApp } from "./app";
import { loadProcessorConfig } from "./config";
import { logger } from "./logger";
import { assertRuntimeDependencies } from "./runtime";

assertRuntimeDependencies();
const config = loadProcessorConfig();
const app = createApp(config).listen({
  port: config.port,
  idleTimeout: config.serverIdleTimeoutSeconds,
});

logger.info(
  { port: app.server?.port, log_level: logger.level },
  "Media Processor listening",
);
