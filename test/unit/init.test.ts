import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { CliError, EXIT_CODES } from '../../src/domain/errors.js';
import { readConfigFile, writeConfigAtomic } from '../../src/config/repository.js';
import { applyProjectGitignore, planProjectGitignore } from '../../src/init/gitignore.js';
import { importLegacySkills, parseLegacySkills } from '../../src/init/legacy.js';
import {
  addConfigSkills,
  discoverSourceSkills,
  initialize,
  removeConfigSkills,
  selectInitSkills,
} from '../../src/init/command.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'skills-sync-init-'));
  roots.push(root);
  const source = join(root, '.agents', 'skills');
  await mkdir(source, { recursive: true });
  return { root, source };
}

async function skill(source: string, name: string): Promise<void> {
  const path = join(source, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `# ${name}\n`);
}

describe('legacy migration', () => {
  it('parses comments, CRLF, a BOM, duplicates, and canonical ordering', () => {
    expect(parseLegacySkills('﻿ zeta # old\r\n# comment\r\nalpha\r\nzeta\r\n')).toEqual([
      'alpha',
      'zeta',
    ]);
  });

  it('fails the import when any listed skill is not valid at the source', async () => {
    const { root, source } = await fixture();
    await skill(source, 'ok');
    const path = join(root, 'claude-skills.txt');
    await writeFile(path, 'ok\nmissing\n');
    await expect(
      importLegacySkills({ legacyPath: path, sourcePath: source }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.missing,
    });
  });
});

describe('selection', () => {
  it('discovers only source children with SKILL.md, including directory symlinks', async () => {
    const { root, source } = await fixture();
    await skill(source, 'zeta');
    await mkdir(join(source, 'invalid'));
    const linked = join(root, 'linked-skill');
    await skill(root, 'linked-skill');
    await symlink(linked, join(source, 'alpha'));
    expect(await discoverSourceSkills(source)).toEqual(['alpha', 'zeta']);
  });

  it('supports all, repeated skill, empty, and injected interactive selections', async () => {
    const { source } = await fixture();
    await skill(source, 'beta');
    await skill(source, 'alpha');
    await expect(selectInitSkills({ mode: 'all', sourcePath: source })).resolves.toEqual([
      'alpha',
      'beta',
    ]);
    await expect(
      selectInitSkills({
        mode: 'skill',
        sourcePath: source,
        skillNames: ['beta', 'alpha', 'beta'],
      }),
    ).resolves.toEqual(['alpha', 'beta']);
    await expect(selectInitSkills({ mode: 'empty', sourcePath: source })).resolves.toEqual([]);
    await expect(
      selectInitSkills({ mode: 'interactive', sourcePath: source, select: async () => ['beta'] }),
    ).resolves.toEqual(['beta']);
  });

  it('rejects selections not present in the source', async () => {
    const { source } = await fixture();
    await expect(
      selectInitSkills({ mode: 'skill', sourcePath: source, skillNames: ['missing'] }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.missing });
  });
});

describe('project gitignore', () => {
  it('skips non-Git projects and plans an exact managed block for Git projects', async () => {
    const { root } = await fixture();
    await expect(planProjectGitignore(root)).resolves.toMatchObject({ status: 'not-project' });
    await mkdir(join(root, '.git'));
    const plan = await planProjectGitignore(root);
    expect(plan).toMatchObject({ status: 'create' });
    await applyProjectGitignore(plan);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(
      '# agent-skills-sync managed links\n/.claude/skills/\n',
    );
    await expect(planProjectGitignore(root)).resolves.toMatchObject({ status: 'kept' });
  });

  it('refuses to overwrite concurrent .gitignore changes', async () => {
    const { root } = await fixture();
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.gitignore'), 'dist/\n');
    const plan = await planProjectGitignore(root);
    await writeFile(join(root, '.gitignore'), 'coverage/\n');
    await expect(applyProjectGitignore(plan)).rejects.toMatchObject({ exitCode: EXIT_CODES.io });
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('coverage/\n');
  });
});

describe('init and config mutation', () => {
  it('creates default source, empty config, and a confirmed project ignore entry', async () => {
    const { root } = await fixture();
    await mkdir(join(root, '.git'));
    const configPath = join(root, '.agents', 'skills-sync.json');
    const result = await initialize({
      scope: { kind: 'project', root },
      configPath,
      selection: { mode: 'empty' },
      confirmGitignore: async () => true,
    });
    expect(result.gitignoreUpdated).toBe(true);
    expect(await readConfigFile(configPath)).toEqual({
      schemaVersion: 1,
      source: '.agents/skills',
      target: '.claude/skills',
      skills: [],
    });
  });

  it('adds validated names canonically and removes names idempotently', async () => {
    const { root, source } = await fixture();
    await skill(source, 'beta');
    await skill(source, 'alpha');
    const configPath = join(root, '.agents', 'skills-sync.json');
    await writeConfigAtomic(configPath, {
      schemaVersion: 1,
      source: '.agents/skills',
      target: '.claude/skills',
      skills: [],
    });
    await addConfigSkills(configPath, source, ['beta', 'alpha', 'beta']);
    expect((await readConfigFile(configPath)).skills).toEqual(['alpha', 'beta']);
    await removeConfigSkills(configPath, ['alpha', 'missing']);
    expect((await readConfigFile(configPath)).skills).toEqual(['beta']);
  });

  it('does not overwrite an existing config without force', async () => {
    const { root } = await fixture();
    const configPath = join(root, '.agents', 'skills-sync.json');
    await writeConfigAtomic(configPath, {
      schemaVersion: 1,
      source: '.agents/skills',
      target: '.claude/skills',
      skills: [],
    });
    const promise = initialize({
      scope: { kind: 'project', root },
      configPath,
      selection: { mode: 'empty' },
    });
    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toMatchObject({ exitCode: EXIT_CODES.blocked });
  });
});
