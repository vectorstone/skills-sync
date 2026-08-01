import { CliError, EXIT_CODES } from '../domain/errors.js';
import type { ConfigDocument } from '../domain/types.js';
import { assertSortedUnique } from '../skills/name.js';

const CONFIG_KEYS = new Set(['schemaVersion', 'source', 'target', 'skills']);

export function parseConfig(raw: string, path: string): ConfigDocument {
  if (raw.includes('\0'))
    throw new CliError(`Config contains a NUL byte: ${path}`, EXIT_CODES.usage);
  if (raw.charCodeAt(0) === 0xfeff)
    throw new CliError(`Config must be UTF-8 without a BOM: ${path}`, EXIT_CODES.usage);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Invalid JSON in ${path}: ${message}`, EXIT_CODES.usage);
  }

  if (!isRecord(parsed))
    throw new CliError(`Config must be a JSON object: ${path}`, EXIT_CODES.usage);
  for (const key of Object.keys(parsed)) {
    if (!CONFIG_KEYS.has(key))
      throw new CliError(`Unknown config field "${key}": ${path}`, EXIT_CODES.usage);
  }
  if (parsed.schemaVersion !== 1) {
    throw new CliError(`Config schemaVersion must be the integer 1: ${path}`, EXIT_CODES.usage);
  }
  if (!isNonEmptyString(parsed.source) || parsed.source.includes('\0')) {
    throw new CliError(`Config source must be a non-empty path: ${path}`, EXIT_CODES.usage);
  }
  if (!isNonEmptyString(parsed.target) || parsed.target.includes('\0')) {
    throw new CliError(`Config target must be a non-empty path: ${path}`, EXIT_CODES.usage);
  }
  if (!Array.isArray(parsed.skills) || !parsed.skills.every((skill) => typeof skill === 'string')) {
    throw new CliError(`Config skills must be an array of strings: ${path}`, EXIT_CODES.usage);
  }
  const skills = parsed.skills as string[];
  assertSortedUnique(skills);

  return { schemaVersion: 1, source: parsed.source, target: parsed.target, skills: [...skills] };
}

export function serializeConfig(config: ConfigDocument): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
