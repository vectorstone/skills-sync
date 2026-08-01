import { createHash } from 'node:crypto';
import { chmod, lstat, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ConfigDocument, ResolvedPaths, ScopeKind, ScopeSelection } from '../domain/types.js';
import { CliError, EXIT_CODES } from '../domain/errors.js';
import { parseConfig, serializeConfig } from './schema.js';
import {
  assertExistingDirectory,
  assertPathWithinScope,
  assertSeparateTrees,
  resolveFrom,
} from '../fs/path-guard.js';

export interface ResolveOptions {
  readonly scope: { readonly kind: ScopeKind; readonly projectPath?: string };
  readonly configPath?: string;
}

export async function resolveScope(options: ResolveOptions): Promise<ScopeSelection> {
  if (options.scope.kind === 'global') {
    return { kind: 'global', root: await assertExistingDirectory(homedir(), 'Home directory') };
  }
  const root = options.scope.projectPath ?? process.cwd();
  return { kind: 'project', root: await assertExistingDirectory(root, 'Project directory') };
}

export async function resolveConfigPaths(
  options: ResolveOptions,
  config?: ConfigDocument,
): Promise<ResolvedPaths> {
  const scope = await resolveScope(options);
  const rawConfigPath = options.configPath
    ? resolve(options.configPath)
    : resolve(scope.root, '.agents', 'skills-sync.json');
  const configPath = await assertPathWithinScope(scope.root, rawConfigPath, 'Config path');
  if (config === undefined) {
    const loaded = await readConfigFile(configPath);
    return buildResolvedPaths(scope, configPath, loaded);
  }
  return buildResolvedPaths(scope, configPath, config);
}

export async function readConfigFile(configPath: string): Promise<ConfigDocument> {
  try {
    const raw = await readFile(configPath, 'utf8');
    return parseConfig(raw, configPath);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (isNotFound(error))
      throw new CliError(
        `Config file not found: ${configPath}. Run init first.`,
        EXIT_CODES.missing,
      );
    throw error;
  }
}

export async function writeConfigAtomic(configPath: string, config: ConfigDocument): Promise<void> {
  const content = serializeConfig(config);
  let mode = 0o644;
  let destination = configPath;
  try {
    const entry = await lstat(configPath);
    if (entry.isSymbolicLink()) destination = await resolveSymlinkFile(configPath);
    const existing = await stat(destination);
    mode = existing.mode & 0o777;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const digest = createHash('sha256').update(content).digest('hex');
  const tempPath = `${destination}.tmp-${process.pid}-${digest.slice(0, 8)}`;
  await writeFile(tempPath, content, { encoding: 'utf8', mode });
  await chmod(tempPath, mode);
  await rename(tempPath, destination);
}

export function buildResolvedPaths(
  scope: ScopeSelection,
  configPath: string,
  config: ConfigDocument,
): ResolvedPaths {
  const sourcePath = resolveFrom(scope.root, config.source);
  const targetPath = resolveFrom(scope.root, config.target);
  assertSeparateTrees(sourcePath, targetPath);
  return {
    scope,
    configPath,
    sourcePath,
    targetPath,
    rawSource: config.source,
    rawTarget: config.target,
  };
}

export function defaultConfig(
  scope: ScopeSelection,
  source = '.agents/skills',
  target = '.claude/skills',
): ConfigDocument {
  return { schemaVersion: 1, source, target, skills: [] };
}

async function resolveSymlinkFile(path: string): Promise<string> {
  const target = await import('node:fs/promises').then(({ readlink }) => readlink(path));
  return isAbsolute(target) ? target : resolve(dirname(path), target);
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
