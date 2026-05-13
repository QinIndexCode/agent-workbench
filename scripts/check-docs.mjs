import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

const root = resolve(process.cwd());
const docsIndexPath = resolve(root, "apps", "web", "src", "docs", "index.ts");
const appRouterPath = resolve(root, "apps", "web", "src", "app-router.ts");
const appPath = resolve(root, "apps", "web", "src", "App.tsx");
const docsRoot = resolve(root, "apps", "web", "src", "docs");

const docsIndexSource = readFileSync(docsIndexPath, "utf8");
const appRouterSource = readFileSync(appRouterPath, "utf8");
const appSource = readFileSync(appPath, "utf8");

const docSections = parseDocSections(docsIndexSource);
const docMetaIds = parseMetaIds(docsIndexSource);
const routerSections = parseSetLiteral(appRouterSource, "docsSections");
const settingsDocMap = parseSettingsDocsMap(appSource);
const zhFiles = listMarkdownBasenames(resolve(docsRoot, "zh"));
const enFiles = listMarkdownBasenames(resolve(docsRoot, "en"));

assertSameSet("DocsSection type", docSections, docMetaIds);
assertSameSet("Docs router sections", docSections, routerSections);
assertSameSet("Chinese docs files", docSections, zhFiles);
assertSameSet("English docs files", docSections, enFiles);

const expectedSettingsSections = ["providers", "permissions", "mcp", "integrations", "scheduled", "search", "preferences"];
assertSameSet("Settings guide map keys", expectedSettingsSections, Object.keys(settingsDocMap));

for (const [section, doc] of Object.entries(settingsDocMap)) {
  if (!docSections.includes(doc)) {
    throw new Error(`Settings section "${section}" points to missing docs section "${doc}".`);
  }
}

console.log(`Docs validation passed for ${docSections.length} sections.`);

function parseDocSections(source) {
  const block = source.match(/export type DocsSection\s*=\s*([\s\S]*?);/);
  if (!block) throw new Error("Failed to find DocsSection union.");
  return uniqueQuotedValues(block[1]);
}

function parseMetaIds(source) {
  const metaBlock = source.match(/export const docMetas:[\s\S]*?=\s*\[([\s\S]*?)\];/);
  if (!metaBlock) throw new Error("Failed to find docMetas.");
  return uniqueQuotedValues(metaBlock[1].match(/id:\s*"([^"]+)"/g)?.join("\n") ?? "");
}

function parseSetLiteral(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*new Set<[^>]+>\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!match) throw new Error(`Failed to find ${name} set literal.`);
  return uniqueQuotedValues(match[1]);
}

function parseSettingsDocsMap(source) {
  const match = source.match(/const settingsDocsSections:[\s\S]*?=\s*\{([\s\S]*?)\};/);
  if (!match) throw new Error("Failed to find settingsDocsSections.");
  const entries = [...match[1].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*"([^"]+)"/g)];
  return Object.fromEntries(entries.map((item) => [item[1], item[2]]));
}

function listMarkdownBasenames(dir) {
  return readdirSync(dir)
    .filter((name) => extname(name) === ".md" && statSync(resolve(dir, name)).isFile())
    .map((name) => basename(name, ".md"))
    .sort();
}

function uniqueQuotedValues(source) {
  return [...new Set([...source.matchAll(/"([^"]+)"/g)].map((item) => item[1]).filter(Boolean))].sort();
}

function assertSameSet(label, expected, actual) {
  const left = [...expected].sort();
  const right = [...actual].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${label} mismatch.\nExpected: ${left.join(", ")}\nActual: ${right.join(", ")}`);
  }
}
