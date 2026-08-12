import { contractFiles, renderContract } from "./contract-files";

let failed = false;
for (const [path, schema] of contractFiles) {
  const expected = await renderContract(schema);
  const actual = await Bun.file(path).text();
  if (actual !== expected) {
    console.error(`${path} is stale; run bun run contracts:generate`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
