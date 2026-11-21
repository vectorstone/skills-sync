import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addConfigSkills,
  discoverSourceSkills,
  initialize,
  removeConfigSkills,
  selectInitSkills,
} from '../../src/init/command.js';
import { readConfigFile } from '../../src/config/repository.js';
import { CliError } from '../../src/domain/errors.js';

describe('init selection', () => {
  let dir: string;
  let source: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-init-'));
    source = join(dir, 'skills');
    await mkdir(join(source, 'beta'), { recursive: true });
    await writeFile(join(source, 'beta', 'SKILL.md'), '# beta\n');
    await mkdir(join(source, 'alpha'), { recursive: true });
    await writeFile(join(source, 'alpha', 'SKILL.md'), '# alpha\n');
    await mkdir(join(source, 'no-manifest'), { recursive: true });
    await writeFile(join(source, 'stray'), 'x');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('discovers manifest-bearing directories only, sorted by code point', async () => {
    expect(await discoverSourceSkills(source)).toEqual(['alpha', 'beta']);
  });

  it('returns no skills when the source directory is absent', async () => {
    expect(await discoverSourceSkills(join(dir, 'absent'))).toEqual([]);
  });

  it('selects all, empty, and explicit skills', async () => {
    expect(await selectInitSkills({ mode: 'all', sourcePath: source })).toEqual(['alpha', 'beta']);
    expect(await selectInitSkills({ mode: 'empty', sourcePath: source })).toEqual([]);
    expect(
      await selectInitSkills({ mode: 'skill', skillNames: ['beta'], sourcePath: source }),
    ).toEqual(['beta']);
  });

  it('rejects an unavailable explicit skill', async () => {
    await expect(
      selectInitSkills({ mode: 'skill', skillNames: ['gamma'], sourcePath: source }),
    ).rejects.toThrow(/not found/);
  });

  it('uses an interactive selection', async () => {
    const selected = await selectInitSkills({
      mode: 'interactive',
      sourcePath: source,
      select: async (names) => names.slice(0, 1),
    });
    expect(selected).toEqual(['alpha']);
  });

  it('cancels an empty interactive selection when not confirmed', async () => {
    await expect(
      selectInitSkills({
        mode: 'interactive',
        sourcePath: source,
        select: async () => [],
        confirmEmpty: async () => false,
      }),
    ).rejects.toBeInstanceOf(CliError);

    expect(
      await selectInitSkills({
        mode: 'interactive',
        sourcePath: source,
        select: async () => [],
        confirmEmpty: async () => true,
      }),
    ).toEqual([]);
  });

  it('accepts an empty interactive selection without a confirmation hook', async () => {
    expect(
      await selectInitSkills({
        mode: 'interactive',
        sourcePath: source,
        select: async () => [],
      }),
    ).toEqual([]);
  });
});

describe('initialize', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-init-run-'));
    await mkdir(join(dir, '.git'));
    await mkdir(join(dir, '.agents', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(dir, '.agents', 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function init(overrides: Record<string, unknown> = {}) {
    const root = await realpath(dir);
    return initialize({
      scope: { kind: 'project', root },
      configPath: join(root, '.agents', 'skills-sync.json'),
      selection: { mode: 'all' },
      confirmGitignore: async () => true,
      ...overrides,
    });
  }

  it('writes the config and updates .gitignore', async () => {
    const result = await init();
    expect(result.selectedSkills).toEqual(['alpha']);
    expect(result.gitignoreUpdated).toBe(true);
    expect((await readConfigFile(result.configPath)).skills).toEqual(['alpha']);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('/.claude/skills/');
  });

  it('keeps an existing config unless --force is given', async () => {
    await init();
    await expect(init()).rejects.toThrow(/already exists/);

    const replaced = await init({ force: true });
    expect(replaced.selectedSkills).toEqual(['alpha']);
  });

  it('honours a confirmation hook when overwriting', async () => {
    await init();
    await expect(init({ force: true, confirmOverwrite: async () => false })).rejects.toThrow(
      /cancelled/,
    );

    await expect(init({ force: true, confirmOverwrite: async () => true })).resolves.toBeDefined();
  });

  it('accepts custom source and target paths', async () => {
    const result = await init({
      source: '.agents/skills',
      target: 'custom/skills',
    });
    expect(result.config.target).toBe('custom/skills');
  });

  it('creates the default source directory when it is absent', async () => {
    await rm(join(dir, '.agents'), { recursive: true, force: true });
    const result = await init({ selection: { mode: 'empty' } });
    expect(result.selectedSkills).toEqual([]);
    expect((await readFile(result.configPath, 'utf8')).length).toBeGreaterThan(0);
  });

  it('accepts an absolute source directory', async () => {
    const external = await mkdtemp(join(tmpdir(), 'sksync-external-'));
    try {
      await mkdir(join(external, 'alpha'), { recursive: true });
      await writeFile(join(external, 'alpha', 'SKILL.md'), '# alpha\n');
      const result = await init({ source: external, selection: { mode: 'all' } });
      expect(result.config.source).toBe(external);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it('rejects an unsafe target outside the scope', async () => {
    await expect(init({ target: '../escape/skills' })).rejects.toBeInstanceOf(CliError);
  });

  it('skips the .gitignore prompt when the caller declines', async () => {
    const result = await init({ confirmGitignore: async () => false });
    expect(result.gitignoreUpdated).toBe(false);
  });

  it('skips .gitignore updates entirely when disabled', async () => {
    const result = await init({ updateGitignore: false });
    expect(result.gitignoreUpdated).toBe(false);
  });

  it('reports the gitignore plan for a global scope as not-project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sksync-home-'));
    try {
      await mkdir(join(home, '.agents', 'skills', 'alpha'), { recursive: true });
      await writeFile(join(home, '.agents', 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
      const result = await initialize({
        scope: { kind: 'global', root: await realpath(home) },
        configPath: join(await realpath(home), '.agents', 'skills-sync.json'),
        selection: { mode: 'all' },
      });
      expect(result.gitignore.status).toBe('not-project');
      expect(result.gitignoreUpdated).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('imports a legacy manifest through initialize', async () => {
    await writeFile(join(dir, '.agents', 'claude-skills.txt'), 'alpha\n');
    const root = await realpath(dir);
    const result = await init({
      selection: {
        mode: 'from-legacy',
        legacyPath: join(root, '.agents', 'claude-skills.txt'),
      },
    });
    expect(result.selectedSkills).toEqual(['alpha']);
  });
});

describe('config mutations', () => {
  let dir: string;
  let root: string;
  let configPath: string;
  let source: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-mutate-'));
    root = await realpath(dir);
    source = join(dir, 'skills');
    await mkdir(join(source, 'alpha'), { recursive: true });
    await writeFile(join(source, 'alpha', 'SKILL.md'), '# alpha\n');
    await mkdir(join(source, 'beta'), { recursive: true });
    await writeFile(join(source, 'beta', 'SKILL.md'), '# beta\n');
    configPath = join(root, 'skills-sync.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adds skills canonically and without duplicates', async () => {
    await mkdir(join(dir, '.git'));
    await initialize({
      scope: { kind: 'project', root },
      configPath,
      selection: { mode: 'empty' },
      updateGitignore: false,
    });

    const added = await addConfigSkills(configPath, source, ['beta', 'alpha']);
    expect(added.skills).toEqual(['alpha', 'beta']);

    const again = await addConfigSkills(configPath, source, ['alpha']);
    expect(again.skills).toEqual(['alpha', 'beta']);
  });

  it('rejects adding an unavailable skill', async () => {
    await initialize({
      scope: { kind: 'project', root },
      configPath,
      selection: { mode: 'empty' },
      updateGitignore: false,
    });

    await expect(addConfigSkills(configPath, source, ['gamma'])).rejects.toBeInstanceOf(CliError);
  });

  it('removes skills and tolerates unknown names', async () => {
    await mkdir(join(dir, '.git'));
    await initialize({
      scope: { kind: 'project', root },
      configPath,
      selection: { mode: 'all' },
      source: 'skills',
      updateGitignore: false,
    });

    expect((await removeConfigSkills(configPath, ['alpha'])).skills).toEqual(['beta']);
    expect((await removeConfigSkills(configPath, ['absent'])).skills).toEqual(['beta']);
  });
});
