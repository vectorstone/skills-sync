import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Stats } from 'node:fs';
import { CliError, EXIT_CODES } from '../domain/errors.js';
import { canonicalNames } from '../skills/name.js';

export interface LegacyImportOptions {
  readonly legacyPath: string;
  readonly sourcePath: string;
}

/** Parse the legacy one-skill-per-line allowlist. Blank lines and comments are ignored. */
export function parseLegacySkills(raw: string, path = 'claude-skills.txt'): string[] {
  if (raw.includes('\0')) {
    throw new CliError(`Legacy skill list contains a NUL byte: ${path}`, EXIT_CODES.usage);
  }

  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const names: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const name = line.split('#', 1)[0]?.trim() ?? '';
    if (name) names.push(name);
  }
  return canonicalNames(names);
}

export async function readLegacySkills(path: string): Promise<string[]> {
  try {
    return parseLegacySkills(await readFile(path, 'utf8'), path);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (isMissing(error)) {
      throw new CliError(`Legacy skill list not found: ${path}`, EXIT_CODES.missing);
    }
    throw error;
  }
}

/** Import and validate the complete legacy selection before returning any names. */
export async function importLegacySkills(options: LegacyImportOptions): Promise<string[]> {
  const names = await readLegacySkills(options.legacyPath);
  await Promise.all(names.map((name) => assertImportableSkill(options.sourcePath, name)));
  return names;
}

export async function assertImportableSkill(sourcePath: string, name: string): Promise<void> {
  const skillPath = join(sourcePath, name);
  const skill = await safeStat(skillPath);
  if (skill === undefined || !skill.isDirectory()) {
    throw new CliError(
      `Legacy skill source is missing or not a directory: ${skillPath}`,
      EXIT_CODES.missing,
    );
  }

  const manifestPath = join(skillPath, 'SKILL.md');
  const manifest = await safeStat(manifestPath);
  if (manifest === undefined || !manifest.isFile()) {
    throw new CliError(
      `Legacy skill manifest is missing or not a file: ${manifestPath}`,
      EXIT_CODES.missing,
    );
  }
}

async function safeStat(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
