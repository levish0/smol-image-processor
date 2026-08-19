import { createApp } from "./http/app";
import { loadProcessorConfig } from "./config/config";
import { logger } from "./shared/logger";
import { assertRuntimeDependencies } from "./config/runtime";

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
