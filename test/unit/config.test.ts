import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
  lstat,
  readlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildResolvedPaths,
  defaultConfig,
  readConfigFile,
  resolveConfigPaths,
  resolveScope,
  writeConfigAtomic,
} from '../../src/config/repository.js';
import { parseConfig } from '../../src/config/schema.js';
import {
  assertExistingDirectory,
  assertPathWithinScope,
  assertSeparateTrees,
  isWithin,
  projectedRealpath,
  resolveFrom,
  safeMkdirWithin,
} from '../../src/fs/path-guard.js';
import { CliError } from '../../src/domain/errors.js';

const CONFIG = {
  schemaVersion: 1 as const,
  source: '.agents/skills',
  target: '.claude/skills',
  skills: ['alpha'],
};

describe('path guards', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-guard-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('decides containment lexically', () => {
    expect(isWithin('/a', '/a/b')).toBe(true);
    expect(isWithin('/a', '/a')).toBe(true);
    expect(isWithin('/a', '/a', false)).toBe(false);
    expect(isWithin('/a', '/b')).toBe(false);
    expect(isWithin('/a', '/ab')).toBe(false);
  });

  it('resolves a projected real path for missing segments', async () => {
    const existing = join(dir, 'existing');
    await mkdir(existing);
    expect(await projectedRealpath(join(existing, 'missing', 'deeper'))).toBe(
      join(await projectedRealpath(existing), 'missing', 'deeper'),
    );
  });

  it('rejects a path outside the scope, lexically and through symlinks', async () => {
    const scope = join(dir, 'scope');
    const outside = join(dir, 'outside');
    await mkdir(scope);
    await mkdir(outside);

    await expect(assertPathWithinScope(scope, join(scope, 'ok.json'), 'Config path')).resolves.toBe(
      join(await projectedRealpath(scope), 'ok.json'),
    );
    await expect(assertPathWithinScope(scope, outside, 'Config path')).rejects.toBeInstanceOf(
      CliError,
    );

    await symlink(outside, join(scope, 'escape'));
    await expect(
      assertPathWithinScope(scope, join(scope, 'escape', 'x'), 'Config path'),
    ).rejects.toThrow(/resolves outside/);
  });

  it('rejects nested source and target trees', () => {
    expect(() => assertSeparateTrees('/a/source', '/a/target')).not.toThrow();
    expect(() => assertSeparateTrees('/a/source', '/a/source/nested')).toThrow(CliError);
    expect(() => assertSeparateTrees('/a/target/nested', '/a/target')).toThrow(CliError);
  });

  it('requires an existing directory', async () => {
    const file = join(dir, 'file.txt');
    await writeFile(file, 'x');

    await expect(assertExistingDirectory(dir, 'Project directory')).resolves.toBeTruthy();
    await expect(assertExistingDirectory(file, 'Project directory')).rejects.toThrow(
      /not a directory/,
    );
    await expect(assertExistingDirectory(join(dir, 'absent'), 'Project directory')).rejects.toThrow(
      /not found/,
    );
  });

  it('creates missing directories and detects escapes', async () => {
    const scope = join(dir, 'scope');
    await mkdir(scope);
    await safeMkdirWithin(scope, join(scope, 'a', 'b'));

    expect((await lstat(join(scope, 'a', 'b'))).isDirectory()).toBe(true);

    const file = join(scope, 'file.txt');
    await writeFile(file, 'x');
    await expect(safeMkdirWithin(scope, join(file, 'child'))).rejects.toBeInstanceOf(CliError);
  });

  it('resolves configured paths from the scope root', () => {
    expect(resolveFrom('/root', '.agents/skills')).toBe('/root/.agents/skills');
    expect(resolveFrom('/root', '/abs/skills')).toBe('/abs/skills');
  });
});

describe('config repository', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-repo-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves project and global scopes', async () => {
    const project = await resolveScope({ scope: { kind: 'project', projectPath: dir } });
    expect(project.kind).toBe('project');

    const global = await resolveScope({ scope: { kind: 'global' } });
    expect(global.kind).toBe('global');
    expect(global.root.length).toBeGreaterThan(0);
  });

  it('resolves config paths and builds resolved trees', async () => {
    const paths = await resolveConfigPaths(
      { scope: { kind: 'project', projectPath: dir } },
      CONFIG,
    );
    expect(paths.sourcePath.endsWith(join('.agents', 'skills'))).toBe(true);
    expect(paths.targetPath.endsWith(join('.claude', 'skills'))).toBe(true);
    expect(paths.configPath.endsWith('skills-sync.json')).toBe(true);
  });

  it('accepts an explicit config path and rejects one outside the scope', async () => {
    const scopeRoot = await realpath(dir);
    const custom = join(scopeRoot, 'custom.json');
    const paths = await resolveConfigPaths(
      { scope: { kind: 'project', projectPath: scopeRoot }, configPath: custom },
      CONFIG,
    );
    expect(paths.configPath.endsWith('custom.json')).toBe(true);

    await expect(
      resolveConfigPaths(
        { scope: { kind: 'project', projectPath: scopeRoot }, configPath: '/etc/passwd' },
        CONFIG,
      ),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('reads a config file and explains a missing one', async () => {
    const configPath = join(dir, 'skills-sync.json');
    await writeFile(
      configPath,
      `${JSON.stringify({ schemaVersion: 1, source: '.agents/skills', target: '.claude/skills', skills: ['alpha'] })}\n`,
    );
    expect((await readConfigFile(configPath)).skills).toEqual(['alpha']);

    await expect(readConfigFile(join(dir, 'absent.json'))).rejects.toThrow(/Run init first/);
  });

  it('propagates schema errors unchanged', async () => {
    const configPath = join(dir, 'bad.json');
    await writeFile(configPath, '{"schemaVersion":2}\n');
    await expect(readConfigFile(configPath)).rejects.toBeInstanceOf(CliError);
  });

  it('writes a config atomically and preserves the existing mode', async () => {
    const configPath = join(dir, 'skills-sync.json');
    await writeConfigAtomic(configPath, CONFIG);
    expect(parseConfig(await readFile(configPath, 'utf8'), configPath)).toEqual(CONFIG);

    const updated = { ...CONFIG, skills: ['alpha', 'beta'] };
    await writeConfigAtomic(configPath, updated);
    expect(parseConfig(await readFile(configPath, 'utf8'), configPath)).toEqual(updated);
  });

  it('follows a symlinked config file to its destination', async () => {
    const real = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    await writeFile(
      real,
      '{"schemaVersion":1,"source":".agents/skills","target":".claude/skills","skills":[]}\n',
    );
    await symlink(real, link);

    await writeConfigAtomic(link, CONFIG);
    expect(parseConfig(await readFile(real, 'utf8'), real)).toEqual(CONFIG);
    expect(await readlink(link)).toBe(real);
  });

  it('builds default paths and refuses nested trees', () => {
    const scope = { kind: 'project' as const, root: waitPath() };
    expect(defaultConfig(scope).skills).toEqual([]);
    expect(() =>
      buildResolvedPaths(scope, '/c.json', { ...CONFIG, target: '.agents/skills/nested' }),
    ).toThrow(/separate/);
  });
});

function waitPath(): string {
  return '/tmp/sksync-repo-fixture';
}
