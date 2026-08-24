#!/usr/bin/env node
import { readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    name: { type: "string", short: "n" },
    directory: { type: "string", default: "src/migrations" },
  },
  strict: true,
});

const name = values.name?.trim();
if (!name) throw new Error("--name must contain letters or digits");
const slug = name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 80)
  .replace(/-$/g, "");
if (!slug) throw new Error("--name must contain letters or digits");

const directory = resolve(values.directory);
const versions = (await readdir(directory))
  .map((entry) => /^(\d{3})-[a-z0-9-]+\.ts$/.exec(entry)?.[1])
  .filter((version) => version !== undefined)
  .map(Number)
  .sort((left, right) => left - right);
for (const [index, version] of versions.entries())
  if (version !== index + 1)
    throw new Error("migration source versions are not a contiguous prefix");

const version = versions.length + 1;
if (version > 999) throw new Error("migration version exceeds three digits");
const padded = String(version).padStart(3, "0");
const variable = `migration${padded}`;
const destination = resolve(directory, `${padded}-${slug}.ts`);
const source = `import { defineControlMigration, sqlStep } from "./framework.js";\n\nexport const ${variable} = defineControlMigration({\n  version: ${version},\n  name: ${JSON.stringify(name)},\n  steps: [\n    sqlStep("MIGRATION ${padded} MUST BE IMPLEMENTED WITH A KYSELY OR SQL STEP"),\n  ],\n});\n`;

await writeFile(destination, source, { encoding: "utf8", flag: "wx" });
process.stdout.write(
  `${JSON.stringify(
    {
      created: destination,
      next: "replace the fail-closed step with typed Kysely steps, then add it to migrations/index.ts",
    },
    null,
    2,
  )}\n`,
);
