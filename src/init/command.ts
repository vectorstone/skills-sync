import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ConfigDocument, ScopeSelection } from '../domain/types.js';
import { CliError, EXIT_CODES } from '../domain/errors.js';
import { canonicalNames } from '../skills/name.js';
import { defaultConfig, readConfigFile, writeConfigAtomic } from '../config/repository.js';
import {
  assertExistingDirectory,
  assertPathWithinScope,
  assertSeparateTrees,
  safeMkdirWithin,
} from '../fs/path-guard.js';
import { assertImportableSkill, importLegacySkills } from './legacy.js';
import { applyProjectGitignore, planProjectGitignore, type GitignorePlan } from './gitignore.js';

export type InitSelection =
  | {
      readonly mode: 'interactive';
      readonly select: (names: readonly string[]) => Promise<readonly string[]>;
      readonly confirmEmpty?: () => Promise<boolean>;
    }
  | { readonly mode: 'all' }
  | { readonly mode: 'skill'; readonly skillNames: readonly string[] }
  | { readonly mode: 'empty' }
  | { readonly mode: 'from-legacy'; readonly legacyPath: string };

export type InitSelectionOptions = InitSelection & { readonly sourcePath: string };

export interface InitOptions {
  readonly scope: ScopeSelection;
  readonly configPath: string;
  readonly source?: string;
  readonly target?: string;
  readonly selection: InitSelection;
  readonly force?: boolean;
  readonly confirmOverwrite?: () => Promise<boolean>;
  readonly confirmGitignore?: (plan: GitignorePlan) => Promise<boolean>;
  readonly updateGitignore?: boolean;
}

export interface InitResult {
  readonly config: ConfigDocument;
  readonly configPath: string;
  readonly selectedSkills: readonly string[];
  readonly gitignore: GitignorePlan;
  readonly gitignoreUpdated: boolean;
}

export async function selectInitSkills(options: InitSelectionOptions): Promise<string[]> {
  if (options.mode === 'from-legacy') {
    return importLegacySkills({ legacyPath: options.legacyPath, sourcePath: options.sourcePath });
  }

  const names = await discoverSourceSkills(options.sourcePath);
  switch (options.mode) {
    case 'all':
      return names;
    case 'empty':
      return [];
    case 'skill':
      return assertAvailable(options.skillNames, names);
    case 'interactive': {
      const selected = assertAvailable(await options.select(names), names);
      if (
        selected.length === 0 &&
        options.confirmEmpty !== undefined &&
        !(await options.confirmEmpty())
      ) {
        throw new CliError('Initialization cancelled.', EXIT_CODES.cancelled, 'cancelled');
      }
      return selected;
    }
  }
}

export async function discoverSourceSkills(sourcePath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(sourcePath, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = join(sourcePath, entry.name);
    try {
      if (!(await stat(skillPath)).isDirectory()) continue;
      if ((await stat(join(skillPath, 'SKILL.md'))).isFile()) names.push(entry.name);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return canonicalNames(names);
}

export async function initialize(options: InitOptions): Promise<InitResult> {
  await assertConfigReplacementAllowed(options);

  const source = options.source ?? '.agents/skills';
  const target = options.target ?? '.claude/skills';
  const sourcePath = resolve(options.scope.root, source);
  const targetPath = resolve(options.scope.root, target);
  const configPath = await assertPathWithinScope(
    options.scope.root,
    options.configPath,
    'Config path',
  );

  if (isAbsolute(source)) {
    await assertExistingDirectory(sourcePath, 'Source directory');
  } else {
    await assertPathWithinScope(options.scope.root, sourcePath, 'Source path');
    if (source === '.agents/skills') await safeMkdirWithin(options.scope.root, sourcePath);
    else await assertExistingDirectory(sourcePath, 'Source directory');
  }
  await assertPathWithinScope(options.scope.root, targetPath, 'Target path', false);
  assertSeparateTrees(sourcePath, targetPath);

  const selectedSkills = await selectInitSkills({ ...options.selection, sourcePath });
  const config: ConfigDocument = {
    ...defaultConfig(options.scope, source, target),
    skills: selectedSkills,
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeConfigAtomic(configPath, config);

  const gitignore: GitignorePlan =
    options.scope.kind === 'project'
      ? await planProjectGitignore(options.scope.root)
      : { status: 'not-project', path: join(options.scope.root, '.gitignore') };
  let gitignoreUpdated = false;
  if (
    options.updateGitignore !== false &&
    gitignore.status !== 'kept' &&
    gitignore.status !== 'not-project' &&
    options.confirmGitignore !== undefined &&
    (await options.confirmGitignore(gitignore))
  ) {
    gitignoreUpdated = await applyProjectGitignore(gitignore);
  }
  return { config, configPath, selectedSkills, gitignore, gitignoreUpdated };
}

export async function addConfigSkills(
  configPath: string,
  sourcePath: string,
  names: readonly string[],
): Promise<ConfigDocument> {
  const config = await readConfigFile(configPath);
  const additions = canonicalNames(names);
  await Promise.all(additions.map((name) => assertImportableSkill(sourcePath, name)));
  const updated: ConfigDocument = {
    ...config,
    skills: canonicalNames([...config.skills, ...additions]),
  };
  await writeConfigAtomic(configPath, updated);
  return updated;
}

export async function removeConfigSkills(
  configPath: string,
  names: readonly string[],
): Promise<ConfigDocument> {
  const config = await readConfigFile(configPath);
  const removals = new Set(canonicalNames(names));
  const updated: ConfigDocument = {
    ...config,
    skills: config.skills.filter((name) => !removals.has(name)),
  };
  await writeConfigAtomic(configPath, updated);
  return updated;
}

function assertAvailable(
  requestedNames: readonly string[],
  availableNames: readonly string[],
): string[] {
  const requested = canonicalNames(requestedNames);
  const available = new Set(availableNames);
  const missing = requested.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new CliError(
      `Selected skill not found in source: ${missing.join(', ')}`,
      EXIT_CODES.missing,
    );
  }
  return requested;
}

async function assertConfigReplacementAllowed(options: InitOptions): Promise<void> {
  try {
    await lstat(options.configPath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!options.force) {
    throw new CliError(
      `Config file already exists: ${options.configPath}. Use --force to replace it.`,
      EXIT_CODES.blocked,
    );
  }
  if (options.confirmOverwrite !== undefined && !(await options.confirmOverwrite())) {
    throw new CliError('Initialization cancelled.', EXIT_CODES.cancelled, 'cancelled');
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
