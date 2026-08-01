import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigDocument, PlanItem, ResolvedPaths } from '../domain/types.js';
import { mapLimit } from '../fs/map-limit.js';
import { compareCodePoint } from '../skills/name.js';
import { findStaleManagedLinks } from './ownership.js';
import { validateSourceSkill, validateTargetEntry } from '../skills/validate.js';

export interface SyncPlanOptions {
  readonly force?: boolean;
  readonly prune?: boolean;
  readonly concurrency?: number;
}

export interface PlannerInput {
  readonly paths: ResolvedPaths;
  readonly config?: Pick<ConfigDocument, 'skills'>;
  readonly options?: SyncPlanOptions;
}

export interface SyncPlan {
  readonly items: readonly PlanItem[];
  readonly sourceRootExists: boolean;
  readonly targetRootExists: boolean;
  readonly hasMutations: boolean;
}

export async function planSync(input: PlannerInput): Promise<SyncPlan>;
export async function planSync(
  paths: ResolvedPaths,
  skills: readonly string[],
  options?: SyncPlanOptions,
): Promise<SyncPlan>;
export async function planSync(
  inputOrPaths: PlannerInput | ResolvedPaths,
  skills: readonly string[] = [],
  explicitOptions: SyncPlanOptions = {},
): Promise<SyncPlan> {
  const input: PlannerInput =
    'paths' in inputOrPaths
      ? inputOrPaths
      : { paths: inputOrPaths, config: { skills }, options: explicitOptions };
  const paths = input.paths;
  const options = input.options ?? {};
  const names = [...(input.config?.skills ?? [])].sort(compareCodePoint);
  const sourceRootExists = await isDirectory(paths.sourcePath);
  const targetRootExists = await isDirectoryEntry(paths.targetPath);
  if (!sourceRootExists) {
    return {
      sourceRootExists: false,
      targetRootExists,
      hasMutations: false,
      items: names.map((name) => ({
        name,
        status: 'missingSource',
        sourcePath: join(paths.sourcePath, name),
        targetPath: join(paths.targetPath, name),
        reason: 'source root is missing',
      })),
    };
  }

  const items = await mapLimit(
    names,
    options.concurrency ?? 32,
    async (name): Promise<PlanItem> => {
      const source = await validateSourceSkill(paths.sourcePath, name);
      const sourcePath = source.sourcePath;
      const targetPath = join(paths.targetPath, name);
      if (source.status !== 'kept' || source.realPath === undefined) {
        return {
          name,
          sourcePath,
          targetPath,
          status: source.status,
          ...(source.reason === undefined ? {} : { reason: source.reason }),
        };
      }
      const target = targetRootExists
        ? await validateTargetEntry(paths.targetPath, name, source.realPath)
        : { name, targetPath, status: 'create' as const };
      if (target.status === 'kept') return { name, sourcePath, targetPath, status: 'kept' };
      if (target.status === 'create') return { name, sourcePath, targetPath, status: 'create' };
      if (target.status === 'invalidLink' && options.force === true) {
        return {
          name,
          sourcePath,
          targetPath,
          status: 'update',
          ...(target.reason === undefined ? {} : { reason: target.reason }),
        };
      }
      return {
        name,
        sourcePath,
        targetPath,
        status: target.status,
        ...(target.reason === undefined ? {} : { reason: target.reason }),
      };
    },
  );

  if (options.prune === true && targetRootExists) {
    const stale = await findStaleManagedLinks(
      paths.sourcePath,
      paths.targetPath,
      new Set(names),
      options.concurrency ?? 32,
    );
    for (const entry of stale) {
      if (entry.realPath !== undefined) {
        items.push({
          name: entry.name,
          sourcePath: entry.realPath,
          targetPath: entry.path,
          status: 'remove',
          reason: 'stale managed link',
        });
      }
    }
  }
  items.sort((left, right) => compareCodePoint(left.name ?? '', right.name ?? ''));
  return {
    sourceRootExists: true,
    targetRootExists,
    hasMutations: items.some(
      (item) => item.status === 'create' || item.status === 'update' || item.status === 'remove',
    ),
    items,
  };
}

export const planSyncActions = planSync;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function isDirectoryEntry(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
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
