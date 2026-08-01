import { isAbsolute, resolve } from 'node:path';
import { CliError, EXIT_CODES } from '../domain/errors.js';
import type { ScopeKind, ScopeSelection } from '../domain/types.js';

export interface ScopeOption {
  readonly kind: ScopeKind;
  readonly projectPath?: string;
}

export interface GlobalOptions {
  readonly json?: boolean;
  readonly quiet?: boolean;
  readonly noColor?: boolean;
  readonly yes?: boolean;
  readonly config?: string;
}

export interface NormalizedArguments {
  readonly argv: string[];
  readonly scope?: ScopeOption;
  readonly globals: GlobalOptions;
}

/** Back-compat shape used by unit tests: scope extraction only. */
export interface NormalizedArgv {
  readonly argv: string[];
  readonly scope?: ScopeOption;
}

const BOOL_FLAGS = new Set(['--json', '--quiet', '--no-color', '--yes']);

export function normalizeScopeArguments(rawArgv: readonly string[]): NormalizedArgv {
  const normalized = normalizeArguments(rawArgv);
  return normalized.scope === undefined
    ? { argv: normalized.argv }
    : { argv: normalized.argv, scope: normalized.scope };
}

export function normalizeArguments(rawArgv: readonly string[]): NormalizedArguments {
  const argv: string[] = [];
  let scope: ScopeOption | undefined;
  const globals: {
    json?: boolean;
    quiet?: boolean;
    noColor?: boolean;
    yes?: boolean;
    config?: string;
  } = {};

  for (let index = 0; index < rawArgv.length; index += 1) {
    const argument = rawArgv[index];
    if (argument === undefined) continue;

    if (argument === '--global') {
      scope = assertSingleScope(scope, '--global');
      scope = { kind: 'global' };
      continue;
    }
    if (argument === '--project') {
      scope = assertSingleScope(scope, '--project');
      scope = { kind: 'project' };
      continue;
    }
    if (argument.startsWith('--project=')) {
      const projectPath = argument.slice('--project='.length);
      if (!projectPath || !isAbsolute(projectPath)) {
        throw new CliError(
          '--project=DIR requires a non-empty absolute directory path.',
          EXIT_CODES.usage,
        );
      }
      scope = assertSingleScope(scope, '--project');
      scope = { kind: 'project', projectPath: resolve(projectPath) };
      continue;
    }
    if (BOOL_FLAGS.has(argument)) {
      if (argument === '--json') globals.json = true;
      else if (argument === '--quiet') globals.quiet = true;
      else if (argument === '--no-color') globals.noColor = true;
      else globals.yes = true;
      continue;
    }
    if (argument === '--config' || argument.startsWith('--config=')) {
      globals.config = readValue(argument, rawArgv, index, '--config');
      continue;
    }
    argv.push(argument);
  }

  if (globals.json === true && globals.quiet === true) {
    throw new CliError('--json and --quiet are mutually exclusive.', EXIT_CODES.usage);
  }

  return {
    argv,
    ...(scope === undefined ? {} : { scope }),
    globals: cleanGlobals(globals),
  };
}

export function toScopeSelection(scope?: ScopeOption): ScopeSelection | undefined {
  if (scope === undefined) return undefined;
  return {
    kind: scope.kind,
    ...(scope.projectPath === undefined ? {} : { root: scope.projectPath }),
  } as ScopeSelection;
}

function assertSingleScope(existing: ScopeOption | undefined, flag: string): undefined {
  if (existing !== undefined) {
    throw new CliError(
      `Choose exactly one of --global or --project (got ${flag} after a scope).`,
      EXIT_CODES.usage,
    );
  }
  return undefined;
}

function readValue(
  argument: string,
  rawArgv: readonly string[],
  index: number,
  flag: string,
): string {
  if (argument === flag) {
    const next = rawArgv[index + 1];
    if (next === undefined) throw new CliError(`${flag} requires a value.`, EXIT_CODES.usage);
    return next;
  }
  return argument.slice(`${flag}=`.length);
}

function cleanGlobals(globals: {
  json?: boolean;
  quiet?: boolean;
  noColor?: boolean;
  yes?: boolean;
  config?: string;
}): GlobalOptions {
  const result: Record<string, boolean | string> = {};
  for (const [key, value] of Object.entries(globals)) {
    if (value !== undefined) result[key] = value;
  }
  return result as unknown as GlobalOptions;
}
