import { lstat, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlanStatus } from '../domain/types.js';
import { isValidSkillName } from './name.js';

export interface SourceValidation {
  readonly name: string;
  readonly sourcePath: string;
  readonly realPath?: string;
  readonly status: Extract<PlanStatus, 'kept' | 'missingSource' | 'blocked'>;
  readonly reason?: string;
}

export interface TargetValidation {
  readonly name: string;
  readonly targetPath: string;
  readonly status: Extract<PlanStatus, 'kept' | 'create' | 'invalidLink' | 'blocked'>;
  readonly targetRealPath?: string;
  readonly reason?: string;
}

export async function validateSourceSkill(
  sourceRoot: string,
  name: string,
): Promise<SourceValidation> {
  const sourcePath = join(sourceRoot, name);
  if (!isValidSkillName(name))
    return { name, sourcePath, status: 'blocked', reason: 'unsafe skill name' };
  try {
    const entry = await stat(sourcePath);
    if (!entry.isDirectory())
      return {
        name,
        sourcePath,
        status: 'missingSource',
        reason: 'source skill is not a directory',
      };
    const manifest = await stat(join(sourcePath, 'SKILL.md'));
    if (!manifest.isFile())
      return { name, sourcePath, status: 'missingSource', reason: 'SKILL.md is missing' };
    return { name, sourcePath, realPath: await realpath(sourcePath), status: 'kept' };
  } catch (error) {
    if (isMissing(error) || isLoop(error))
      return {
        name,
        sourcePath,
        status: 'missingSource',
        reason: 'source skill or SKILL.md is missing',
      };
    throw error;
  }
}

export async function validateTargetEntry(
  targetRoot: string,
  name: string,
  desiredRealPath: string,
): Promise<TargetValidation> {
  const targetPath = join(targetRoot, name);
  if (!isValidSkillName(name))
    return { name, targetPath, status: 'blocked', reason: 'unsafe skill name' };
  try {
    const entry = await lstat(targetPath);
    if (!entry.isSymbolicLink())
      return { name, targetPath, status: 'blocked', reason: 'target is a real file or directory' };
    try {
      const targetRealPath = await realpath(targetPath);
      return targetRealPath === desiredRealPath
        ? { name, targetPath, targetRealPath, status: 'kept' }
        : {
            name,
            targetPath,
            targetRealPath,
            status: 'invalidLink',
            reason: 'target points to another source',
          };
    } catch {
      return { name, targetPath, status: 'invalidLink', reason: 'target symlink is dangling' };
    }
  } catch (error) {
    if (isMissing(error)) return { name, targetPath, status: 'create' };
    throw error;
  }
}

export async function isExactManagedLink(path: string, desiredRealPath: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return entry.isSymbolicLink() && (await realpath(path)) === desiredRealPath;
  } catch {
    return false;
  }
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
