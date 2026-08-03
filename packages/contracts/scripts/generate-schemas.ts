import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ContractSchemas, serializeSchema } from "../src/registry.js";

const expectedSchemas = Object.entries(ContractSchemas)
  .sort(([left], [right]) => left.localeCompare(right));

export async function findSchemaDrift(outputDirectory: string): Promise<string[]> {
  const entries = await readdir(outputDirectory, { withFileTypes: true }).catch(() => []);
  const schemaEntries = entries
    .filter((entry) => entry.name.endsWith(".schema.json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const expectedNames = new Set(expectedSchemas.map(([key]) => `${key}.schema.json`));
  const actualEntries = new Map(schemaEntries.map((entry) => [entry.name, entry]));
  const failures: string[] = [];

  for (const fileName of expectedNames) {
    const entry = actualEntries.get(fileName);
    if (entry === undefined || !entry.isFile()) failures.push(`${fileName}: missing`);
  }
  for (const entry of schemaEntries) {
    if (!expectedNames.has(entry.name)) failures.push(`${entry.name}: unexpected`);
  }

  for (const [key, schema] of expectedSchemas) {
    const fileName = `${key}.schema.json`;
    if (!actualEntries.get(fileName)?.isFile()) continue;
    const actual = await readFile(resolve(outputDirectory, fileName), "utf8");
    if (actual !== serializeSchema(schema)) failures.push(`${fileName}: content drift`);
  }
  return failures;
}

async function generateSchemas(outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  for (const [key, schema] of expectedSchemas) {
    const outputPath = resolve(outputDirectory, `${key}.schema.json`);
    const temporaryPath = `${outputPath}.tmp`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(temporaryPath, serializeSchema(schema), "utf8");
    await rename(temporaryPath, outputPath);
  }
}

async function main(): Promise<void> {
  const outputDirectory = resolve(import.meta.dirname, "../schemas/v1");
  if (!process.argv.includes("--check")) {
    await generateSchemas(outputDirectory);
    return;
  }

  const failures = await findSchemaDrift(outputDirectory);
  if (failures.length > 0) {
    console.error(`Generated schema drift:\n${failures.join("\n")}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Schema generation failed");
    process.exitCode = 1;
  });
}
