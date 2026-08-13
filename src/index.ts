import { createApp } from "./app";
import { loadProcessorConfig } from "./config";
import { assertRuntimeDependencies } from "./runtime";

assertRuntimeDependencies();
const config = loadProcessorConfig();
const app = createApp(config).listen({
  port: config.port,
  idleTimeout: config.serverIdleTimeoutSeconds,
});

console.log(`Media Processor running at http://localhost:${app.server?.port}`);
