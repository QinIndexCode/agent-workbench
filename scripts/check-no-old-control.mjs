import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const ignored = new Set([".git", "node_modules", "dist", "docs(knowlage)", "coverage"]);
const forbidden = [
  ["quality", "Profile", "Id"],
  ["quality", "Gate", "Id"],
  ["scenario", "Pack"],
  ["scenario", "-", "pack"],
  ["restart", "Task"],
  ["task", "-", "action", "-", "restart"],
  ["tracker", " ", "JSON"]
].map((parts) => parts.join(""));

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}

const hits = [];
for await (const file of walk(root)) {
  const text = await readFile(file, "utf8").catch(() => "");
  for (const term of forbidden) {
    if (text.includes(term)) hits.push(`${file}: ${term}`);
  }
}

if (hits.length > 0) {
  console.error(hits.join("\n"));
  process.exit(1);
}

console.log("No legacy control-chain terms found in new source.");
