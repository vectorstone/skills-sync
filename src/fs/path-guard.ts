import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CliError, EXIT_CODES } from '../domain/errors.js';

export function isWithin(root: string, candidate: string, allowEqual = true): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return allowEqual;
  return (
    rel !== '..' &&
    !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(rel)
  );
}

export async function projectedRealpath(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      const ancestor = await realpath(current);
      return resolve(ancestor, ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(current.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
      current = parent;
    }
  }
}

export async function assertPathWithinScope(
  scopeRoot: string,
  candidate: string,
  label: string,
  allowEqual = true,
): Promise<string> {
  const lexicalRoot = resolve(scopeRoot);
  const lexicalCandidate = resolve(candidate);
  if (!isWithin(lexicalRoot, lexicalCandidate, allowEqual)) {
    throw new CliError(
      `${label} must remain inside the selected scope: ${candidate}`,
      EXIT_CODES.usage,
    );
  }
  const [realRoot, projected] = await Promise.all([
    realpath(lexicalRoot),
    projectedRealpath(lexicalCandidate),
  ]);
  if (!isWithin(realRoot, projected, allowEqual)) {
    throw new CliError(
      `${label} resolves outside the selected scope: ${candidate}`,
      EXIT_CODES.usage,
    );
  }
  return projected;
}

export function assertSeparateTrees(source: string, target: string): void {
  if (isWithin(source, target) || isWithin(target, source)) {
    throw new CliError(
      'Source and target must be separate, non-nested directories.',
      EXIT_CODES.usage,
    );
  }
}

export async function assertExistingDirectory(path: string, label: string): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isDirectory())
      throw new CliError(`${label} is not a directory: ${path}`, EXIT_CODES.usage);
    return await realpath(path);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (isMissing(error)) throw new CliError(`${label} not found: ${path}`, EXIT_CODES.missing);
    throw error;
  }
}

export async function safeMkdirWithin(scopeRoot: string, target: string): Promise<void> {
  const root = await realpath(scopeRoot);
  const absolute = resolve(target);
  const rel = relative(resolve(scopeRoot), absolute);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  let current = resolve(scopeRoot);
  for (const part of parts) {
    current = join(current, part);
    try {
      await lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const { mkdir } = await import('node:fs/promises');
      await mkdir(current);
    }
    const info = await stat(current);
    if (!info.isDirectory())
      throw new CliError(`Target path is not a directory: ${current}`, EXIT_CODES.blocked);
    const currentReal = await realpath(current);
    if (!isWithin(root, currentReal)) {
      throw new CliError(`Target directory escaped the selected scope: ${current}`, EXIT_CODES.io);
    }
  }
}

export function resolveFrom(root: string, configured: string): string {
  return isAbsolute(configured) ? resolve(configured) : resolve(root, configured);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
