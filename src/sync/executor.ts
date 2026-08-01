import { rename, symlink, unlink } from 'node:fs/promises';
import type { ApplyOutcome, PlanItem } from '../domain/types.js';
import { safeMkdirWithin } from '../fs/path-guard.js';
import { isExactManagedLink } from '../skills/validate.js';

export interface ExecuteOptions {
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly onAction?: (item: PlanItem) => Promise<void>;
}

export interface ExecutionItem extends PlanItem {
  readonly outcome: ApplyOutcome;
}

export interface ExecutionResult {
  readonly items: readonly ExecutionItem[];
  readonly failed: boolean;
}

/** Apply only planned mutations. Planning itself never calls this module. */
export async function executePlan(
  scopeRoot: string,
  sourceRoot: string,
  targetRoot: string,
  items: readonly PlanItem[],
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const result: ExecutionItem[] = [];
  const mutations = items.filter(
    (item) => item.status === 'create' || item.status === 'update' || item.status === 'remove',
  );
  if (!options.dryRun && mutations.some((item) => item.status !== 'remove'))
    await safeMkdirWithin(scopeRoot, targetRoot);

  for (const item of items) {
    if (item.status !== 'create' && item.status !== 'update' && item.status !== 'remove') {
      result.push({ ...item, outcome: item.status === 'kept' ? 'succeeded' : 'skipped' });
      continue;
    }
    if (options.dryRun) {
      result.push({ ...item, outcome: 'skipped' });
      continue;
    }
    try {
      if (options.onAction !== undefined) await options.onAction(item);
      const targetPath = item.targetPath;
      if (targetPath === undefined) throw new Error('Planned mutation has no target path');
      if (item.status === 'remove') {
        if (
          item.sourcePath === undefined ||
          !(await isExactManagedLink(targetPath, item.sourcePath))
        ) {
          result.push({ ...item, outcome: 'skipped' });
          continue;
        }
        await unlink(targetPath);
      } else {
        if (item.sourcePath === undefined) throw new Error('Planned link has no source path');
        const sourcePath = item.sourcePath;
        const sourceRealPath = await import('node:fs/promises').then(({ realpath }) =>
          realpath(sourcePath),
        );
        if (item.status === 'create') {
          await symlink(sourceRealPath, targetPath, 'dir');
        } else {
          const current = await import('node:fs/promises').then(({ lstat }) => lstat(targetPath));
          if (!current.isSymbolicLink()) {
            result.push({ ...item, outcome: 'skipped' });
            continue;
          }
          const temporary = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
          await symlink(sourceRealPath, temporary, 'dir');
          try {
            const beforeRename = await import('node:fs/promises').then(({ lstat }) =>
              lstat(targetPath),
            );
            if (!beforeRename.isSymbolicLink()) throw new Error('Target is no longer a symlink');
            await rename(temporary, targetPath);
          } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
          }
        }
      }
      result.push({ ...item, outcome: 'succeeded' });
    } catch {
      result.push({ ...item, outcome: 'failed' });
    }
  }
  return { items: result, failed: result.some((item) => item.outcome === 'failed') };
}

export const executeSync = executePlan;
