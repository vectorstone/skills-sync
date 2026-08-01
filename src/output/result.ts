import type { CommandResult, PlanItem, ResolvedPaths, ScopeSelection } from '../domain/types.js';

export interface ResultInput {
  readonly command: string;
  readonly mode: CommandResult['mode'];
  readonly exitCode?: number;
  readonly status?: CommandResult['status'];
  readonly scope?: ScopeSelection;
  readonly paths?: ResolvedPaths;
  readonly items?: readonly PlanItem[];
  readonly warnings?: readonly string[];
  readonly errors?: readonly string[];
}

export function createResult(input: ResultInput): CommandResult {
  const items = [...(input.items ?? [])].sort(compareItems);
  const summary: Record<string, number> = {};
  for (const item of items) summary[item.status] = (summary[item.status] ?? 0) + 1;
  return {
    outputVersion: 1,
    command: input.command,
    mode: input.mode,
    status: input.status ?? ((input.exitCode ?? 0) === 0 ? 'ok' : 'error'),
    exitCode: input.exitCode ?? 0,
    summary,
    items,
    warnings: [...(input.warnings ?? [])].sort(),
    errors: [...(input.errors ?? [])].sort(),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.paths === undefined ? {} : { paths: input.paths }),
  };
}

function compareItems(left: PlanItem, right: PlanItem): number {
  const leftName = left.name ?? '';
  const rightName = right.name ?? '';
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  if (left.status !== right.status) return left.status < right.status ? -1 : 1;
  return (left.targetPath ?? '').localeCompare(right.targetPath ?? '');
}
