import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { mapLimit } from '../fs/map-limit.js';
import { compareCodePoint, isValidSkillName } from '../skills/name.js';

export type TargetOwnership = 'missing' | 'managed' | 'foreign' | 'dangling' | 'real' | 'unsafe';

export interface OwnershipInspection {
  readonly name: string;
  readonly path: string;
  readonly ownership: TargetOwnership;
  readonly linkText?: string;
  readonly realPath?: string;
  readonly expectedRealPath?: string;
}

export async function inspectOwnership(
  targetRoot: string,
  name: string,
  expectedRealPath?: string,
): Promise<OwnershipInspection> {
  const path = join(targetRoot, name);
  if (!isValidSkillName(name)) return { name, path, ownership: 'unsafe' };
  try {
    const entry = await lstat(path);
    if (!entry.isSymbolicLink()) return { name, path, ownership: 'real' };
    const linkText = await readlink(path);
    try {
      const resolved = await realpath(path);
      return {
        name,
        path,
        linkText,
        realPath: resolved,
        ...(expectedRealPath === undefined ? {} : { expectedRealPath }),
        ownership:
          expectedRealPath !== undefined && resolved === expectedRealPath ? 'managed' : 'foreign',
      };
    } catch {
      return {
        name,
        path,
        linkText,
        ...(expectedRealPath === undefined ? {} : { expectedRealPath }),
        ownership: 'dangling',
      };
    }
  } catch (error) {
    if (isMissing(error))
      return {
        name,
        path,
        ownership: 'missing',
        ...(expectedRealPath === undefined ? {} : { expectedRealPath }),
      };
    throw error;
  }
}

/**
 * Find links that are safe to call stale. A link is stale only when its name is
 * not configured and it resolves to the current source child of that name.
 */
export async function findStaleManagedLinks(
  sourceRoot: string,
  targetRoot: string,
  configuredNames: ReadonlySet<string>,
  concurrency = 32,
): Promise<OwnershipInspection[]> {
  let entries;
  try {
    entries = await readdir(targetRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const candidates = entries
    .filter(
      (entry) =>
        entry.isSymbolicLink() && isValidSkillName(entry.name) && !configuredNames.has(entry.name),
    )
    .map((entry) => entry.name)
    .sort(compareCodePoint);

  const inspected = await mapLimit(candidates, concurrency, async (name) => {
    try {
      const expected = await realpath(join(sourceRoot, name));
      const source = await lstat(expected);
      if (!source.isDirectory()) return undefined;
      const ownership = await inspectOwnership(targetRoot, name, expected);
      return ownership.ownership === 'managed' ? ownership : undefined;
    } catch (error) {
      if (isMissing(error) || isLoop(error)) return undefined;
      throw error;
    }
  });
  return inspected.filter((entry): entry is OwnershipInspection => entry !== undefined);
}

export function resolvedLinkText(linkPath: string, linkText: string): string {
  return isAbsolute(linkText) ? resolve(linkText) : resolve(linkPath, '..', linkText);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
function isLoop(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ELOOP';
}
