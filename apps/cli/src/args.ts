export type OptionValue = boolean | string | string[];

export interface ParsedArgs {
  command: string[];
  options: Record<string, OptionValue>;
  rest: string[];
}

const booleanOptionNames = new Set([
  "help",
  "json",
  "quiet",
  "yes",
  "include-children",
  "diagnostics",
  "target",
  "watch",
  "enabled",
  "disabled",
  "make-active",
  "delete-learning-data",
  "delete-derived-skills",
  "clear-api-key",
  "clear-bot-token",
  "clear-app-secret",
  "clear-verification-token",
  "clear-encrypt-key",
  "clear-signing-secret",
  "clear-secret-token",
  "clear-wecom-token",
  "clear-wecom-encoding-aes-key"
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const rest: string[] = [];
  const options: Record<string, OptionValue> = {};
  let parsingOptions = true;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (parsingOptions && token === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && token.startsWith("--")) {
      const raw = token.slice(2);
      const equalsIndex = raw.indexOf("=");
      const name = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;
      const inlineValue = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : undefined;
      if (!name) throw new CliUsageError("Empty option name.");
      if (inlineValue !== undefined) {
        addOption(options, name, inlineValue);
        continue;
      }
      const next = argv[index + 1];
      if (booleanOptionNames.has(name) || next === undefined || next.startsWith("--")) {
        addOption(options, name, true);
        continue;
      }
      addOption(options, name, next);
      index += 1;
      continue;
    }
    if (parsingOptions) command.push(token);
    else rest.push(token);
  }

  return { command, options, rest };
}

export class CliUsageError extends Error {
  readonly kind = "usage";
}

export function hasOption(args: ParsedArgs, name: string): boolean {
  return args.options[name] !== undefined;
}

export function optionString(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  if (value === undefined || value === false) return undefined;
  if (Array.isArray(value)) return value.at(-1);
  if (value === true) return "true";
  return value;
}

export function optionStringRequired(args: ParsedArgs, name: string): string {
  const value = optionString(args, name);
  if (!value) throw new CliUsageError(`Missing required option --${name}.`);
  return value;
}

export function optionNumber(args: ParsedArgs, name: string, fallback?: number): number | undefined {
  const value = optionString(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new CliUsageError(`--${name} must be a number.`);
  return parsed;
}

export function optionBoolean(args: ParsedArgs, name: string, fallback = false): boolean {
  const value = args.options[name];
  if (value === undefined) return fallback;
  if (Array.isArray(value)) return parseBoolean(value.at(-1) ?? "", name);
  if (typeof value === "boolean") return value;
  return parseBoolean(value, name);
}

export function optionList(args: ParsedArgs, name: string): string[] {
  const value = args.options[name];
  if (value === undefined || value === false) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value === true) return ["true"];
  return [value].filter(Boolean);
}

export function parseJsonOption(args: ParsedArgs, name = "data"): Record<string, unknown> {
  const raw = optionString(args, name);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new CliUsageError(`--${name} must be a JSON object.`);
  return parsed;
}

export function parseSetOptions(args: ParsedArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of optionList(args, "set")) {
    const separator = item.indexOf("=");
    if (separator <= 0) throw new CliUsageError("--set must use key=value.");
    out[item.slice(0, separator)] = parseScalar(item.slice(separator + 1));
  }
  return out;
}

export function parseKeyValueList(values: string[], optionName: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of values) {
    const separator = item.indexOf("=");
    if (separator <= 0) throw new CliUsageError(`--${optionName} must use key=value.`);
    out[item.slice(0, separator)] = item.slice(separator + 1);
  }
  return out;
}

export function requirePosition(args: ParsedArgs, index: number, label: string): string {
  const value = args.command[index];
  if (!value) throw new CliUsageError(`Missing ${label}.`);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addOption(options: Record<string, OptionValue>, name: string, value: boolean | string): void {
  const current = options[name];
  if (current === undefined) {
    options[name] = value;
    return;
  }
  if (Array.isArray(current)) {
    current.push(String(value));
    return;
  }
  options[name] = [String(current), String(value)];
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new CliUsageError(`--${name} must be true or false.`);
}

function parseScalar(value: string): unknown {
  const normalized = value.toLowerCase();
  if (["true", "false"].includes(normalized)) return normalized === "true";
  if (normalized === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
