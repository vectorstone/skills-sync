import { homedir } from 'node:os';
import type { CommandResult } from '../domain/types.js';

export interface RenderOptions {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly color: boolean;
}

export function renderResult(result: CommandResult, options: RenderOptions): string {
  if (options.json) return `${JSON.stringify(result, null, 2)}\n`;
  if (options.quiet && result.exitCode === 0) return '';
  const lines: string[] = [];
  if (result.paths !== undefined) {
    lines.push(`config: ${displayPath(result.paths.configPath)}`);
    lines.push(`source: ${displayPath(result.paths.sourcePath)}`);
    lines.push(`target: ${displayPath(result.paths.targetPath)}`);
  }
  for (const item of result.items) {
    const label = item.name ?? item.targetPath ?? 'item';
    const suffix = item.reason === undefined ? '' : ` (${item.reason})`;
    lines.push(`${paint(item.status, options.color)}: ${label}${suffix}`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  for (const error of result.errors) lines.push(`error: ${error}`);
  const counts = Object.entries(result.summary)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  lines.push(`${result.command} ${result.status}${counts ? `: ${counts}` : ''}`);
  return `${lines.join('\n')}\n`;
}

export function colorEnabled(noColor: boolean): boolean {
  return !noColor && process.stdout.isTTY === true && !('NO_COLOR' in process.env);
}

function displayPath(path: string): string {
  const home = homedir();
  return path === home
    ? '~'
    : path.startsWith(`${home}/`)
      ? `~/${path.slice(home.length + 1)}`
      : path;
}

function paint(value: string, enabled: boolean): string {
  if (!enabled) return value;
  const color =
    value === 'kept'
      ? 32
      : value === 'create'
        ? 36
        : value === 'update'
          ? 33
          : value === 'remove'
            ? 35
            : 31;
  return `[${color}m${value}[0m`;
}
