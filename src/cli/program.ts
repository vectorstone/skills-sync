import { resolve } from 'node:path';
import { Command } from 'commander';
import type {
  ApplyOutcome,
  CommandResult,
  ConfigDocument,
  PlanItem,
  ResolvedPaths,
  ScopeSelection,
} from '../domain/types.js';
import { CliError, EXIT_CODES } from '../domain/errors.js';
import { buildResolvedPaths, readConfigFile, resolveScope } from '../config/repository.js';
import { assertPathWithinScope } from '../fs/path-guard.js';
import { planSync } from '../sync/planner.js';
import { executePlan } from '../sync/executor.js';
import { discoverSourceSkills } from '../init/command.js';
import {
  initialize,
  addConfigSkills,
  removeConfigSkills,
  type InitSelection,
} from '../init/command.js';
import { createResult } from '../output/result.js';
import { renderResult } from '../output/render.js';
import { confirmAction, canPrompt } from '../runtime/confirm.js';
import { VERSION } from '../version.js';
import type { NormalizedArguments } from './argv.js';

export interface CommandOptions {
  readonly strict?: boolean;
  readonly available?: boolean;
  readonly force?: boolean;
  readonly prune?: boolean;
  readonly dryRun?: boolean;
  readonly config?: string;
  readonly source?: string;
  readonly target?: string;
  readonly all?: boolean;
  readonly empty?: boolean;
  readonly fromLegacy?: boolean;
  readonly legacyConfig?: string;
  readonly skill?: string[];
  readonly names?: string[];
}

export async function runProgram(normalized: NormalizedArguments): Promise<number> {
  const render = {
    json: normalized.globals.json === true,
    quiet: normalized.globals.quiet === true,
    color:
      !normalized.globals.noColor &&
      !normalized.globals.json &&
      process.stdout.isTTY === true &&
      !('NO_COLOR' in process.env),
  };

  let result: CommandResult | null = null;
  const program = new Command();

  program
    .name('agent-skills-sync')
    .description(
      'Safely expose selected Agent Skills from .agents/skills to Claude Code via managed symlinks.',
    )
    .version(VERSION);

  program
    .command('list')
    .description('Show configured skills and their current link status.')
    .option('--available', 'also list source skills not yet configured')
    .option('--config <path>', 'override the config file path')
    .option('--source <path>', 'override the configured source directory')
    .option('--target <path>', 'override the configured target directory')
    .action(async (opts: CommandOptions) => {
      result = await handleList(normalized, opts);
    });

  program
    .command('check')
    .description('Verify configured links without changing anything.')
    .option('--strict', 'treat stale managed links as drift')
    .option('--config <path>', 'override the config file path')
    .option('--source <path>', 'override the configured source directory')
    .option('--target <path>', 'override the configured target directory')
    .action(async (opts: CommandOptions) => {
      result = await handleCheck(normalized, opts);
    });

  program
    .command('sync')
    .description('Create or repair managed symlinks for configured skills.')
    .option('--force', 'replace links that point to the wrong source')
    .option('--prune', 'remove stale managed links no longer in config')
    .option('--dry-run', 'show the plan without writing anything')
    .option('--config <path>', 'override the config file path')
    .option('--source <path>', 'override the configured source directory')
    .option('--target <path>', 'override the configured target directory')
    .action(async (opts: CommandOptions) => {
      result = await handleSync(normalized, opts);
    });

  program
    .command('add <skills...>')
    .description('Add skill names to the config (does not create links).')
    .option('--config <path>', 'override the config file path')
    .action(async (skills: string[], opts: CommandOptions) => {
      result = await handleAdd(normalized, { ...opts, names: skills });
    });

  program
    .command('remove <skills...>')
    .description('Remove skill names from the config (does not delete links).')
    .option('--config <path>', 'override the config file path')
    .action(async (skills: string[], opts: CommandOptions) => {
      result = await handleRemove(normalized, { ...opts, names: skills });
    });

  program
    .command('init')
    .description('Create or rebuild the skills-sync config for the selected scope.')
    .option('--all', 'select every valid source skill')
    .option(
      '-s, --skill <name>',
      'select a specific skill (repeatable)',
      accumulate,
      [] as string[],
    )
    .option('--empty', 'create an empty skills selection')
    .option('--from-legacy', 'import the legacy .agents/claude-skills.txt selection')
    .option('--legacy-config <path>', 'legacy manifest path (with --from-legacy)')
    .option('--source <path>', 'set the source directory in the new config')
    .option('--target <path>', 'set the target directory in the new config')
    .option('--force', 'replace an existing config')
    .action(async (opts: CommandOptions) => {
      result = await handleInit(normalized, opts);
    });

  try {
    await program.parseAsync(['node', 'agent-skills-sync', ...normalized.argv]);
  } catch (error) {
    const cliError = error instanceof CliError ? error : asCliError(error);
    result = errorResult(normalized, 'error', cliError.message, cliError.exitCode);
  }

  if (result === null) {
    return 0;
  }
  process.stdout.write(renderResult(result, render));
  return result.exitCode;
}

function accumulate(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function handleList(
  normalized: NormalizedArguments,
  opts: CommandOptions,
): Promise<CommandResult> {
  const scope = await requireScope(normalized);
  const { paths, doc } = await loadPaths(scope, opts);
  const plan = await planSync(paths, doc.skills, {});
  const items = [...plan.items] as PlanItem[];

  if (opts.available === true) {
    const discovered = await discoverSourceSkills(paths.sourcePath);
    const configured = new Set(paths ? await configuredNames(paths) : []);
    for (const name of discovered) {
      if (!configured.has(name)) {
        items.push({ name, status: 'ignored', reason: 'available, not configured' });
      }
    }
  }

  return createResult({
    command: 'list',
    mode: 'check',
    exitCode: 0,
    scope,
    paths,
    items,
  });
}

async function handleCheck(
  normalized: NormalizedArguments,
  opts: CommandOptions,
): Promise<CommandResult> {
  const scope = await requireScope(normalized);
  const { paths, doc } = await loadPaths(scope, opts);
  const plan = await planSync(paths, doc.skills, { prune: true });
  const items = plan.items;

  if (!plan.sourceRootExists) {
    return createResult({
      command: 'check',
      mode: 'check',
      exitCode: EXIT_CODES.missing,
      scope,
      paths,
      items,
      errors: [`Source directory is missing: ${paths.sourcePath}`],
    });
  }

  const drift = items.some(
    (item) =>
      item.status === 'invalidLink' ||
      item.status === 'blocked' ||
      item.status === 'missingSource' ||
      item.status === 'create',
  );
  const stale = items.filter((item) => item.status === 'remove');
  const warnings = stale.map((item) => `stale managed link: ${item.name ?? item.targetPath}`);
  const exitCode =
    drift || (opts.strict === true && stale.length > 0) ? EXIT_CODES.drift : EXIT_CODES.ok;

  return createResult({
    command: 'check',
    mode: 'check',
    exitCode,
    scope,
    paths,
    items,
    warnings,
  });
}

async function handleSync(
  normalized: NormalizedArguments,
  opts: CommandOptions,
): Promise<CommandResult> {
  const scope = await requireScope(normalized);
  const { paths, doc } = await loadPaths(scope, opts);
  const force = opts.force === true;
  const prune = opts.prune === true;
  const dryRun = opts.dryRun === true;

  const plan = await planSync(paths, doc.skills, { force, prune });

  if (!plan.sourceRootExists) {
    return createResult({
      command: 'sync',
      mode: dryRun ? 'plan' : 'apply',
      exitCode: EXIT_CODES.missing,
      scope,
      paths,
      items: plan.items,
      errors: [`Source directory is missing: ${paths.sourcePath}`],
    });
  }

  const needsConfirm = plan.items.some(
    (item) => item.status === 'update' || item.status === 'remove',
  );
  if (dryRun) {
    const blocked = plan.items.some(
      (item) => item.status === 'blocked' || item.status === 'invalidLink',
    );
    return createResult({
      command: 'sync',
      mode: 'plan',
      exitCode: blocked ? EXIT_CODES.blocked : EXIT_CODES.ok,
      scope,
      paths,
      items: plan.items,
    });
  }

  if (needsConfirm) {
    const approved =
      normalized.globals.yes === true ||
      (await confirmAction('Apply the planned link updates and removals?'));
    if (!approved) {
      return createResult({
        command: 'sync',
        mode: 'apply',
        exitCode: EXIT_CODES.cancelled,
        status: 'cancelled',
        scope,
        paths,
        items: plan.items.map((item) => ({ ...item, outcome: 'skipped' as ApplyOutcome })),
        warnings: ['no changes applied'],
      });
    }
  }

  const execution = await executePlan(scope.root, paths.sourcePath, paths.targetPath, plan.items, {
    ...(force ? { force: true } : {}),
  });

  const blocked = plan.items.some(
    (item) => item.status === 'blocked' || item.status === 'invalidLink',
  );
  const anyFailed = execution.failed;
  const exitCode = anyFailed ? EXIT_CODES.io : blocked ? EXIT_CODES.blocked : EXIT_CODES.ok;

  return createResult({
    command: 'sync',
    mode: 'apply',
    exitCode,
    scope,
    paths,
    items: execution.items,
  });
}

async function handleAdd(
  normalized: NormalizedArguments,
  opts: CommandOptions,
): Promise<CommandResult> {
  const scope = await requireScope(normalized);
  const { paths, configPath } = await loadPaths(scope, opts);
  const names = opts.names ?? [];
  if (names.length === 0) {
    return createResult({
      command: 'add',
      mode: 'config',
      exitCode: EXIT_CODES.usage,
      scope,
      paths,
      errors: ['add requires at least one skill name.'],
    });
  }
  try {
    const updated = await addConfigSkills(configPath, paths.sourcePath, names);
    return createResult({
      command: 'add',
      mode: 'config',
      exitCode: EXIT_CODES.ok,
      scope,
      paths,
      items: updated.skills.map((name) => ({ name, status: 'kept' as const })),
    });
  } catch (error) {
    return errorResult(normalized, 'add', (error as Error).message, EXIT_CODES.io, scope, paths);
  }
}

async function handleRemove(
  normalized: NormalizedArguments,
  opts: CommandOptions,
): Promise<CommandResult> {
  const scope = await requireScope(normalized);
  const { paths, configPath } = await loadPaths(scope, opts);
  const names = opts.names ?? [];
  if (names.length === 0) {
    return createResult({
      command: 'remove',
      mode: 'config',
      exitCode: EXIT_CODES.usage,
      scope,
      paths,
      errors: ['remove requires at least one skill name.'],
    });
  }
  await removeConfigSkills(configPath, names);
  return createResult({
    command: 'remove',
    mode: 'config',
    exitCode: EXIT_CODES.ok,
    scope,
    paths,
    items: names.map((name) => ({ name, status: 'remove' as const })),
  });
}

async function handleInit(
  normalized: NormalizedArguments,
  opts: CommandOptions,
): Promise<CommandResult> {
  const scope = await requireScope(normalized);
  const configPath = opts.config
    ? await assertPathWithinScope(scope.root, resolve(opts.config), 'Config path')
    : resolve(scope.root, '.agents', 'skills-sync.json');

  const modes = [
    opts.all === true,
    (opts.skill?.length ?? 0) > 0,
    opts.empty === true,
    opts.fromLegacy === true,
  ].filter(Boolean).length;
  if (modes > 1) {
    return createResult({
      command: 'init',
      mode: 'config',
      exitCode: EXIT_CODES.usage,
      scope,
      errors: ['init accepts at most one of --all, --skill, --empty, or --from-legacy.'],
    });
  }

  let selection: InitSelection;
  if (opts.fromLegacy === true) {
    const legacyPath = opts.legacyConfig ?? resolve(scope.root, '.agents', 'claude-skills.txt');
    selection = { mode: 'from-legacy', legacyPath };
  } else if (opts.all === true) {
    selection = { mode: 'all' };
  } else if (opts.empty === true) {
    selection = { mode: 'empty' };
  } else if ((opts.skill?.length ?? 0) > 0) {
    selection = { mode: 'skill', skillNames: opts.skill ?? [] };
  } else {
    if (!canPrompt() && normalized.globals.yes !== true) {
      return createResult({
        command: 'init',
        mode: 'config',
        exitCode: EXIT_CODES.usage,
        scope,
        errors: [
          'Interactive init requires a TTY; pass --all, --skill, --empty, or --from-legacy.',
        ],
      });
    }
    selection = {
      mode: 'interactive',
      select: async (names) => {
        const { checkbox } = await import('@inquirer/prompts');
        const choices = names.map((name) => ({ name, value: name, checked: false }));
        return checkbox({ message: 'Select skills to expose', choices });
      },
      confirmEmpty: async () => confirmAction('No skills selected. Save an empty config?'),
    };
  }

  try {
    const init = await initialize({
      scope,
      configPath,
      ...(opts.source === undefined ? {} : { source: opts.source }),
      ...(opts.target === undefined ? {} : { target: opts.target }),
      selection,
      ...(opts.force === undefined ? {} : { force: opts.force }),
      ...(scope.kind === 'project'
        ? {
            confirmGitignore: async () =>
              normalized.globals.yes === true || confirmAction('Add a managed .gitignore entry?'),
          }
        : {}),
    });
    return createResult({
      command: 'init',
      mode: 'config',
      exitCode: EXIT_CODES.ok,
      scope,
      items: init.selectedSkills.map((name) => ({ name, status: 'kept' as const })),
      warnings: init.gitignoreUpdated ? [`updated .gitignore: ${init.gitignore.path}`] : [],
    });
  } catch (error) {
    if (error instanceof CliError && error.status === 'cancelled') {
      return createResult({
        command: 'init',
        mode: 'config',
        exitCode: error.exitCode,
        status: 'cancelled',
        scope,
        errors: [error.message],
      });
    }
    return errorResult(normalized, 'init', (error as Error).message, EXIT_CODES.io, scope);
  }
}

async function loadPaths(
  scope: ScopeSelection,
  opts: CommandOptions,
): Promise<{ paths: ResolvedPaths; configPath: string; doc: ConfigDocument }> {
  const configPath = opts.config
    ? await assertPathWithinScope(scope.root, resolve(opts.config), 'Config path')
    : resolve(scope.root, '.agents', 'skills-sync.json');
  let doc = await readConfigFile(configPath);
  if (opts.source !== undefined) doc = { ...doc, source: opts.source };
  if (opts.target !== undefined) doc = { ...doc, target: opts.target };
  const paths = buildResolvedPaths(scope, configPath, doc);
  return { paths, configPath, doc };
}

async function configuredNames(paths: ResolvedPaths): Promise<Set<string>> {
  try {
    const doc = await readConfigFile(paths.configPath);
    return new Set(doc.skills);
  } catch {
    return new Set();
  }
}

async function requireScope(normalized: NormalizedArguments): Promise<ScopeSelection> {
  if (normalized.scope === undefined) {
    throw new CliError('Choose a scope with --global or --project.', EXIT_CODES.usage);
  }
  return resolveScope({ scope: normalized.scope });
}

function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError(error instanceof Error ? error.message : String(error), EXIT_CODES.io);
}

function errorResult(
  normalized: NormalizedArguments,
  command: string,
  message: string,
  exitCode: number,
  scope?: ScopeSelection,
  paths?: ResolvedPaths,
): CommandResult {
  return createResult({
    command,
    mode: 'config',
    exitCode,
    ...(scope === undefined ? {} : { scope }),
    ...(paths === undefined ? {} : { paths }),
    errors: [message],
  });
}
