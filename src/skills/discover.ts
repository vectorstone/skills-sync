import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError, EXIT_CODES } from '../domain/errors.js';
import { mapLimit } from '../fs/map-limit.js';
import { canonicalNames, isValidSkillName } from './name.js';

export interface DiscoveredSkill {
  readonly name: string;
  readonly sourcePath: string;
  readonly realPath: string;
}

export interface DiscoverOptions {
  readonly requireManifest?: boolean;
  readonly concurrency?: number;
}

/** Discover importable skills among the source directory's immediate children. */
export async function discoverSkills(
  sourcePath: string,
  options: DiscoverOptions = {},
): Promise<DiscoveredSkill[]> {
  let entries;
  try {
    entries = await readdir(sourcePath, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      throw new CliError(`Source directory not found: ${sourcePath}`, EXIT_CODES.missing);
    }
    throw error;
  }

  const root = await stat(sourcePath);
  if (!root.isDirectory())
    throw new CliError(`Source path is not a directory: ${sourcePath}`, EXIT_CODES.missing);

  const names = canonicalNames(entries.map((entry) => entry.name).filter(isValidSkillName));
  const inspected = await mapLimit(names, options.concurrency ?? 32, async (name) => {
    const skillPath = join(sourcePath, name);
    try {
      const skill = await stat(skillPath);
      if (!skill.isDirectory()) return undefined;
      if (options.requireManifest !== false) {
        const manifest = await stat(join(skillPath, 'SKILL.md'));
        if (!manifest.isFile()) return undefined;
      }
      return {
        name,
        sourcePath: skillPath,
        realPath: await realpath(skillPath),
      } satisfies DiscoveredSkill;
    } catch (error) {
      if (isMissing(error) || isSymlinkLoop(error)) return undefined;
      throw error;
    }
  });
  return inspected.filter((skill): skill is DiscoveredSkill => skill !== undefined);
}

export async function discoverSkillNames(
  sourcePath: string,
  options?: DiscoverOptions,
): Promise<string[]> {
  return (await discoverSkills(sourcePath, options)).map(({ name }) => name);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function isSymlinkLoop(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ELOOP';
}
