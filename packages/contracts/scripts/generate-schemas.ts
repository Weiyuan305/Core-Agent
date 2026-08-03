import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ContractSchemas, serializeSchema } from "../src/registry.js";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(root, "schemas/v1");
const checkOnly = process.argv.includes("--check");
const failures: string[] = [];

await mkdir(outputDirectory, { recursive: true });
for (const [key, schema] of Object.entries(ContractSchemas).sort(([left], [right]) => left.localeCompare(right))) {
  const outputPath = resolve(outputDirectory, `${key}.schema.json`);
  const expected = serializeSchema(schema);
  if (checkOnly) {
    const actual = await readFile(outputPath, "utf8").catch(() => "");
    if (actual !== expected) failures.push(outputPath);
    continue;
  }
  const temporaryPath = `${outputPath}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(temporaryPath, expected, "utf8");
  await rename(temporaryPath, outputPath);
}

if (failures.length > 0) {
  console.error(`Generated schema drift:\n${failures.join("\n")}`);
  process.exitCode = 1;
}
