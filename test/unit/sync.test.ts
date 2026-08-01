import { lstat, mkdir, mkdtemp, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigDocument, ResolvedPaths } from '../../src/domain/types.js';
import { discoverSkillNames } from '../../src/skills/discover.js';
import { executePlan } from '../../src/sync/executor.js';
import { planSync } from '../../src/sync/planner.js';

async function fixture(
  skills: readonly string[],
): Promise<{ root: string; paths: ResolvedPaths; config: ConfigDocument }> {
  const root = await mkdtemp(join(tmpdir(), 'skills-sync-'));
  const sourcePath = join(root, '.agents', 'skills');
  const targetPath = join(root, '.claude', 'skills');
  await mkdir(sourcePath, { recursive: true });
  for (const name of skills) {
    await mkdir(join(sourcePath, name));
    await writeFile(join(sourcePath, name, 'SKILL.md'), `# ${name}\n`);
  }
  return {
    root,
    config: { schemaVersion: 1, source: '.agents/skills', target: '.claude/skills', skills },
    paths: {
      scope: { kind: 'project', root },
      configPath: join(root, '.agents', 'skills-sync.json'),
      sourcePath,
      targetPath,
      rawSource: '.agents/skills',
      rawTarget: '.claude/skills',
    },
  };
}

describe('skill discovery', () => {
  it('returns sorted immediate valid skills only', async () => {
    const { paths } = await fixture(['beta', 'alpha']);
    await mkdir(join(paths.sourcePath, 'invalid'));
    await mkdir(join(paths.sourcePath, '.hidden'));
    await writeFile(join(paths.sourcePath, '.hidden', 'SKILL.md'), '# hidden\n');
    expect(await discoverSkillNames(paths.sourcePath)).toEqual(['alpha', 'beta']);
  });
});

describe('sync planning and execution', () => {
  it('is read-only and creates absolute links only when executed', async () => {
    const { root, paths, config } = await fixture(['alpha']);
    const plan = await planSync({ paths, config });
    expect(plan.items.map(({ status }) => status)).toEqual(['create']);
    await expect(lstat(paths.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });

    expect((await executePlan(root, paths.sourcePath, paths.targetPath, plan.items)).failed).toBe(
      false,
    );
    expect(await readlink(join(paths.targetPath, 'alpha'))).toBe(
      await realpath(join(paths.sourcePath, 'alpha')),
    );
  });

  it('accepts a directory symlink as the source root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-sync-'));
    const realSourcePath = join(root, 'shared', 'skills');
    const sourcePath = join(root, '.agents', 'skills');
    const targetPath = join(root, '.claude', 'skills');
    await mkdir(join(realSourcePath, 'alpha'), { recursive: true });
    await writeFile(join(realSourcePath, 'alpha', 'SKILL.md'), '# alpha\n');
    await mkdir(join(root, '.agents'), { recursive: true });
    await symlink(realSourcePath, sourcePath, 'dir');

    const plan = await planSync({
      paths: {
        scope: { kind: 'project', root },
        configPath: join(root, '.agents', 'skills-sync.json'),
        sourcePath,
        targetPath,
        rawSource: '.agents/skills',
        rawTarget: '.claude/skills',
      },
      config: {
        schemaVersion: 1,
        source: '.agents/skills',
        target: '.claude/skills',
        skills: ['alpha'],
      },
    });

    expect(plan.sourceRootExists).toBe(true);
    expect(plan.items.map(({ status }) => status)).toEqual(['create']);
    await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts equivalent relative links and force replaces only symlinks', async () => {
    const { paths, config } = await fixture(['alpha']);
    await mkdir(paths.targetPath, { recursive: true });
    await symlink(join('..', '..', '.agents', 'skills', 'alpha'), join(paths.targetPath, 'alpha'));
    expect((await planSync({ paths, config })).items[0]?.status).toBe('kept');

    await mkdir(join(paths.sourcePath, 'other'));
    await symlink(join(paths.sourcePath, 'other'), join(paths.targetPath, 'wrong'));
    const wrongConfig = { ...config, skills: ['wrong'] };
    expect((await planSync({ paths, config: wrongConfig })).items[0]?.status).toBe('missingSource');

    await writeFile(join(paths.targetPath, 'real'), 'mine');
    await mkdir(join(paths.sourcePath, 'real'));
    await writeFile(join(paths.sourcePath, 'real', 'SKILL.md'), '# real\n');
    const realConfig = { ...config, skills: ['real'] };
    expect(
      (await planSync({ paths, config: realConfig, options: { force: true } })).items[0]?.status,
    ).toBe('blocked');
  });

  it('prunes only exact stale managed links', async () => {
    const { root, paths, config } = await fixture(['kept', 'stale', 'foreign']);
    await mkdir(paths.targetPath, { recursive: true });
    await symlink(join(paths.sourcePath, 'stale'), join(paths.targetPath, 'stale'));
    await symlink(join(paths.sourcePath, 'foreign'), join(paths.targetPath, 'foreign'));
    const configured = { ...config, skills: ['kept'] };
    const plan = await planSync({ paths, config: configured, options: { prune: true } });
    expect(plan.items.map(({ name, status }) => [name, status])).toEqual([
      ['foreign', 'remove'],
      ['kept', 'create'],
      ['stale', 'remove'],
    ]);
    await executePlan(root, paths.sourcePath, paths.targetPath, plan.items);
    await expect(lstat(join(paths.targetPath, 'stale'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not prune foreign, dangling, real, unsafe, or source-less entries', async () => {
    const { paths, config } = await fixture([]);
    await mkdir(paths.targetPath, { recursive: true });
    await mkdir(join(paths.targetPath, 'real'));
    await symlink(join(paths.sourcePath, 'missing'), join(paths.targetPath, 'dangling'));
    await symlink(paths.sourcePath, join(paths.targetPath, 'foreign'));
    const plan = await planSync({ paths, config, options: { prune: true } });
    expect(plan.items).toEqual([]);
  });

  it('does not create a target directory for an empty selection', async () => {
    const { paths, config } = await fixture([]);
    const plan = await planSync({ paths, config });
    expect(plan.hasMutations).toBe(false);
    expect(plan.items).toEqual([]);
    await expect(lstat(paths.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
