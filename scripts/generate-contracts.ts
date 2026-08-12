import { contractFiles, renderContract } from "./contract-files";

for (const [path, schema] of contractFiles) {
  await Bun.write(path, await renderContract(schema));
  console.log(`generated ${path}`);
}
