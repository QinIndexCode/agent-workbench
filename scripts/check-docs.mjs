import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

const root = resolve(process.cwd());
const docsIndexPath = resolve(root, "apps", "web", "src", "docs", "index.ts");
const appRouterPath = resolve(root, "apps", "web", "src", "app-router.ts");
const appPath = resolve(root, "apps", "web", "src", "App.tsx");
const docsRoot = resolve(root, "apps", "web", "src", "docs");
const rootReadmePath = resolve(root, "README.md");
const docsReadmePath = resolve(root, "docs", "README.md");
const architecturePath = resolve(root, "docs", "architecture.md");
const digDeeperPath = resolve(root, "docs", "DigDeeper.md");

const docsIndexSource = readFileSync(docsIndexPath, "utf8");
const appRouterSource = readFileSync(appRouterPath, "utf8");
const appSource = readFileSync(appPath, "utf8");
const rootReadmeSource = readFileSync(rootReadmePath, "utf8");
const docsReadmeSource = readFileSync(docsReadmePath, "utf8");
const architectureSource = readFileSync(architecturePath, "utf8");
const digDeeperSource = readFileSync(digDeeperPath, "utf8");

const docSections = parseDocSections(docsIndexSource);
const docMetaIds = parseMetaIds(docsIndexSource);
const routerSections = parseSetLiteral(appRouterSource, "docsSections");
const settingsDocMap = parseSettingsDocsMap(appSource);
const zhFiles = listMarkdownBasenames(resolve(docsRoot, "zh"));
const enFiles = listMarkdownBasenames(resolve(docsRoot, "en"));
const zhProtocols = readDoc("zh", "protocols");
const enProtocols = readDoc("en", "protocols");
const zhInput = readDoc("zh", "input");
const zhTaskManagement = readDoc("zh", "task-management");
const enTaskManagement = readDoc("en", "task-management");
const zhTroubleshooting = readDoc("zh", "troubleshooting");

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

assertNotIncludes("Chinese Agent Protocols doc", zhProtocols, ["Loop Engineering", "Observe、Plan、Act", "Loop evidence"]);
assertNotIncludes("English Agent Protocols doc", enProtocols, ["Loop Engineering", "Observe, Plan, Act", "Loop evidence"]);
assertIncludes("Chinese Agent Protocols doc", zhProtocols, ["MCP 与 A2A 的区别", "当前 Agent Card discovery", "不表示 `/api` 已经是标准 A2A"]);
assertIncludes("English Agent Protocols doc", enProtocols, ["MCP vs A2A", "Current Agent Card Discovery", "does not mean `/api` is a standard A2A"]);
assertIncludes("Chinese task command docs", zhTaskManagement, ["## 输入指令", "`/goal <需求>`", "`/plan <需求>`", "`/review <范围>`", "`/verify <目标>`", "`/knowledge [问题]`", "`/cache [范围]`", "`/model` 打开模型配置", "`/help`", "`//`"]);
assertIncludes("English task command docs", enTaskManagement, ["## Input Commands", "`/goal <request>`", "`/plan <request>`", "`/review <scope>`", "`/verify <target>`", "`/knowledge [question]`", "`/cache [scope]`", "`/model` opens Model Providers", "`/help`", "`//`"]);
assertIncludes("Chinese localized doc headings", `${zhInput}\n${zhTaskManagement}\n${zhTroubleshooting}`, ["# 输入方式", "# 任务管理", "# 故障排除"]);
assertNotIncludes("Chinese localized doc headings", `${zhInput}\n${zhTaskManagement}\n${zhTroubleshooting}`, ["# Input Methods", "# Task Management", "# Troubleshooting"]);
assertNotIncludes("Docs index protocol summary", docsIndexSource, ["Understand Loop Engineering", "only aligned", "只是协议对齐"]);
assertIncludes("Root README protocol boundary", rootReadmeSource, ["public Agent Card discovery", "without claiming a full shipped A2A adapter"]);
assertIncludes("Docs README protocol boundary", docsReadmeSource, ["当前项目已提供 Agent Card discovery", "不声称已完整实现 adapter"]);
assertIncludes("Architecture protocol boundary", architectureSource, ["A2A 当前只提供公开 Agent Card discovery", "docs should say \"Agent Card discovery is available\""]);
assertIncludes("DigDeeper MCP boundary", digDeeperSource, ["配置式 stdio / streamable HTTP MCP 工具发现和调用", "MCP 资源模板、远程 auth、marketplace/lifecycle 管理"]);
assertNotIncludes("DigDeeper MCP boundary", digDeeperSource, ["MCP connector、多消息平台网关"]);

for (const [label, source] of [
  ["Root README", rootReadmeSource],
  ["Docs README", docsReadmeSource],
  ["Architecture", architectureSource],
  ["Chinese Agent Protocols doc", zhProtocols],
  ["English Agent Protocols doc", enProtocols]
]) {
  assertNotIncludes(label, source, [
    "Agent Workbench fully supports A2A today",
    "Agent Workbench 已完整支持 A2A",
    "已完整实现 A2A",
    "supports full A2A"
  ]);
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

function readDoc(lang, id) {
  return readFileSync(resolve(docsRoot, lang, `${id}.md`), "utf8");
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

function assertIncludes(label, source, needles) {
  const missing = needles.filter((needle) => !source.includes(needle));
  if (missing.length > 0) {
    throw new Error(`${label} is missing required content: ${missing.join(", ")}`);
  }
}

function assertNotIncludes(label, source, needles) {
  const present = needles.filter((needle) => source.includes(needle));
  if (present.length > 0) {
    throw new Error(`${label} contains content outside its documentation boundary: ${present.join(", ")}`);
  }
}
