import { mkdir, mkdtemp, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectOwnership,
  findStaleManagedLinks,
  resolvedLinkText,
} from '../../src/sync/ownership.js';
import {
  isExactManagedLink,
  validateSourceSkill,
  validateTargetEntry,
} from '../../src/skills/validate.js';
import { discoverSkillNames, discoverSkills } from '../../src/skills/discover.js';
import { mapLimit } from '../../src/fs/map-limit.js';
import { CliError } from '../../src/domain/errors.js';

describe('skill validation', () => {
  let dir: string;
  let source: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-validate-'));
    source = join(dir, 'source');
    target = join(dir, 'target');
    await mkdir(join(source, 'alpha'), { recursive: true });
    await writeFile(join(source, 'alpha', 'SKILL.md'), '# alpha\n');
    await mkdir(target, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts a well-formed source skill', async () => {
    const validation = await validateSourceSkill(source, 'alpha');
    expect(validation.status).toBe('kept');
    expect(validation.realPath).toBeDefined();
  });

  it('blocks unsafe names', async () => {
    expect((await validateSourceSkill(source, '../escape')).status).toBe('blocked');
    expect((await validateTargetEntry(target, '../escape', source)).status).toBe('blocked');
  });

  it('reports a source without SKILL.md as missing', async () => {
    await mkdir(join(source, 'beta'), { recursive: true });
    const validation = await validateSourceSkill(source, 'beta');
    expect(validation.status).toBe('missingSource');
    expect(validation.reason).toBe('source skill or SKILL.md is missing');
  });

  it('reports a non-directory source child as missing', async () => {
    await writeFile(join(source, 'gamma'), 'not a directory');
    expect((await validateSourceSkill(source, 'gamma')).status).toBe('missingSource');
  });

  it('reports an absent source as missing', async () => {
    expect((await validateSourceSkill(source, 'nope')).status).toBe('missingSource');
  });

  it('classifies target entries', async () => {
    const desired = await validateSourceSkill(source, 'alpha');
    expect((await validateTargetEntry(target, 'alpha', desired.realPath ?? '')).status).toBe(
      'create',
    );

    await symlink(desired.realPath ?? source, join(target, 'alpha'));
    expect((await validateTargetEntry(target, 'alpha', desired.realPath ?? '')).status).toBe(
      'kept',
    );
    expect(await isExactManagedLink(join(target, 'alpha'), desired.realPath ?? '')).toBe(true);

    await rm(join(target, 'alpha'));
    await symlink('/nonexistent/other', join(target, 'alpha'));
    expect((await validateTargetEntry(target, 'alpha', desired.realPath ?? '')).status).toBe(
      'invalidLink',
    );
    expect(await isExactManagedLink(join(target, 'alpha'), desired.realPath ?? '')).toBe(false);

    await rm(join(target, 'alpha'));
    await mkdir(join(target, 'alpha'));
    const real = await validateTargetEntry(target, 'alpha', desired.realPath ?? '');
    expect(real.status).toBe('blocked');
    expect(real.reason).toBe('target is a real file or directory');
  });
});

describe('ownership inspection', () => {
  let dir: string;
  let source: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-own-'));
    source = join(dir, 'source');
    target = join(dir, 'target');
    await mkdir(join(source, 'alpha'), { recursive: true });
    await mkdir(target, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('classifies missing, real, managed, foreign and dangling entries', async () => {
    expect((await inspectOwnership(target, 'missing')).ownership).toBe('missing');
    expect((await inspectOwnership(target, '../x')).ownership).toBe('unsafe');

    await mkdir(join(target, 'real'));
    expect((await inspectOwnership(target, 'real')).ownership).toBe('real');

    const expected = join(dir, 'expected');
    await mkdir(expected, { recursive: true });
    const expectedReal = await realpath(expected);
    await symlink(expected, join(target, 'managed'));
    const managed = await inspectOwnership(target, 'managed', expectedReal);
    expect(managed.ownership).toBe('managed');
    expect(managed.linkText).toBeDefined();

    expect((await inspectOwnership(target, 'managed', join(dir, 'other'))).ownership).toBe(
      'foreign',
    );
    expect((await inspectOwnership(target, 'managed')).ownership).toBe('foreign');

    await symlink(join(dir, 'gone'), join(target, 'dangling'));
    expect((await inspectOwnership(target, 'dangling', expectedReal)).ownership).toBe('dangling');
  });

  it('finds only stale links that still resolve to the current source child', async () => {
    await mkdir(join(source, 'alpha'), { recursive: true });
    await mkdir(join(source, 'beta'), { recursive: true });
    await symlink(join(source, 'alpha'), join(target, 'alpha'));
    await symlink(join(source, 'beta'), join(target, 'beta'));
    await symlink('/elsewhere/foreign', join(target, 'foreign'));
    await writeFile(join(source, 'notdir'), 'x');
    await symlink(join(source, 'notdir'), join(target, 'notdir'));

    const stale = await findStaleManagedLinks(source, target, new Set<string>());
    expect(stale.map((entry) => entry.name)).toEqual(['alpha', 'beta']);

    const noneStale = await findStaleManagedLinks(source, target, new Set(['alpha', 'beta']));
    expect(noneStale).toEqual([]);
  });

  it('returns no stale links when the target directory is absent', async () => {
    expect(await findStaleManagedLinks(source, join(dir, 'no-target'), new Set())).toEqual([]);
  });

  it('resolves relative link text against the link parent', () => {
    expect(resolvedLinkText('/a/b/link', '../c')).toBe('/a/c');
    expect(resolvedLinkText('/a/b/link', '/abs/c')).toBe('/abs/c');
  });
});

describe('skill discovery', () => {
  let dir: string;
  let source: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-discover-'));
    source = join(dir, 'skills');
    await mkdir(join(source, 'alpha'), { recursive: true });
    await writeFile(join(source, 'alpha', 'SKILL.md'), '# alpha\n');
    await mkdir(join(source, 'beta'), { recursive: true });
    await writeFile(join(source, 'beta', 'SKILL.md'), '# beta\n');
    await mkdir(join(source, 'no-manifest'), { recursive: true });
    await writeFile(join(source, 'stray-file'), 'x');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('discovers only directories with a manifest by default', async () => {
    expect(await discoverSkillNames(source)).toEqual(['alpha', 'beta']);
  });

  it('includes manifest-less directories when the manifest is not required', async () => {
    expect(await discoverSkillNames(source, { requireManifest: false })).toEqual([
      'alpha',
      'beta',
      'no-manifest',
    ]);
  });

  it('returns metadata for each discovered skill', async () => {
    const [first] = await discoverSkills(source);
    expect(first?.name).toBe('alpha');
    expect(first?.realPath).toBeDefined();
    expect(first?.sourcePath.endsWith(join('skills', 'alpha'))).toBe(true);
  });

  it('fails clearly when the source directory is missing', async () => {
    await expect(discoverSkillNames(join(dir, 'absent'))).rejects.toBeInstanceOf(CliError);
  });

  it('fails clearly when the source path is not a directory', async () => {
    const file = join(dir, 'plain.txt');
    await writeFile(file, 'x');
    await expect(discoverSkillNames(file)).rejects.toThrow(/Source directory not found/);
  });
});

describe('bounded concurrency', () => {
  it('processes every item without exceeding the limit', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('returns an empty array for no items', async () => {
    expect(await mapLimit([], 4, async (value: number) => value)).toEqual([]);
  });
});
