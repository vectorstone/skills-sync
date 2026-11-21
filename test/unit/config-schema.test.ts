import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, serializeConfig } from '../../src/config/schema.js';
import {
  applyProjectGitignore,
  planProjectGitignore,
  MANAGED_GITIGNORE_COMMENT,
  MANAGED_GITIGNORE_PATTERN,
} from '../../src/init/gitignore.js';
import {
  assertImportableSkill,
  importLegacySkills,
  parseLegacySkills,
  readLegacySkills,
} from '../../src/init/legacy.js';
import { CliError } from '../../src/domain/errors.js';

const VALID = {
  schemaVersion: 1,
  source: '.agents/skills',
  target: '.claude/skills',
  skills: ['alpha', 'beta'],
};

describe('config schema', () => {
  it('round-trips a valid document', () => {
    expect(parseConfig(serializeConfig(VALID), 'c.json')).toEqual(VALID);
  });

  it('rejects malformed documents with specific reasons', () => {
    const cases: Array<[string, RegExp]> = [
      ['{"a":\u0000}', /NUL byte/],
      ['﻿{"schemaVersion":1}', /BOM/],
      ['{not json', /Invalid JSON/],
      ['[]', /JSON object/],
      [
        '{"schemaVersion":1,"source":"a","target":"b","skills":[],"extra":1}',
        /Unknown config field/,
      ],
      ['{"schemaVersion":2,"source":"a","target":"b","skills":[]}', /schemaVersion/],
      ['{"schemaVersion":1,"source":"","target":"b","skills":[]}', /source must be/],
      ['{"schemaVersion":1,"source":"a","target":"","skills":[]}', /target must be/],
      ['{"schemaVersion":1,"source":"a","target":"b","skills":"x"}', /array of strings/],
      ['{"schemaVersion":1,"source":"a","target":"b","skills":["b","a"]}', /sorted/],
    ];
    for (const [raw, pattern] of cases) {
      expect(() => parseConfig(raw, 'c.json'), raw).toThrow(pattern);
    }
  });

  it('rejects a NUL byte inside source and target', () => {
    expect(() => parseConfig(JSON.stringify({ ...VALID, source: 'a\u0000b' }), 'c.json')).toThrow(
      /source must be/,
    );
    expect(() => parseConfig(JSON.stringify({ ...VALID, target: 'a\u0000b' }), 'c.json')).toThrow(
      /target must be/,
    );
  });

  it('rejects duplicates', () => {
    expect(() => parseConfig(JSON.stringify({ ...VALID, skills: ['a', 'a'] }), 'c.json')).toThrow(
      CliError,
    );
  });
});

describe('legacy skill list parsing', () => {
  it('ignores blanks, comments, inline comments, and a BOM', () => {
    expect(parseLegacySkills('﻿# c\nalpha\n\nbeta # inline\n')).toEqual(['alpha', 'beta']);
    expect(parseLegacySkills('beta\r\nalpha\r\n')).toEqual(['alpha', 'beta']);
  });

  it('rejects a NUL byte', () => {
    expect(() => parseLegacySkills('alpha\u0000')).toThrow(/NUL byte/);
  });

  it('reads a manifest or explains a missing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sksync-legacy-'));
    try {
      const path = join(dir, 'claude-skills.txt');
      await writeFile(path, 'alpha\n');
      expect(await readLegacySkills(path)).toEqual(['alpha']);
      await expect(readLegacySkills(join(dir, 'missing.txt'))).rejects.toThrow(/not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('legacy skill import validation', () => {
  let dir: string;
  let source: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-legacy-import-'));
    source = join(dir, 'skills');
    await mkdir(join(source, 'alpha'), { recursive: true });
    await writeFile(join(source, 'alpha', 'SKILL.md'), '# alpha\n');
    await mkdir(join(source, 'no-manifest'), { recursive: true });
    await writeFile(join(source, 'plain-file'), 'x');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts a valid skill and its manifest', async () => {
    await expect(assertImportableSkill(source, 'alpha')).resolves.toBeUndefined();
  });

  it('rejects a missing or non-directory source', async () => {
    await expect(assertImportableSkill(source, 'absent')).rejects.toThrow(
      /missing or not a directory/,
    );
    await expect(assertImportableSkill(source, 'plain-file')).rejects.toThrow(
      /missing or not a directory/,
    );
  });

  it('rejects a missing manifest', async () => {
    await expect(assertImportableSkill(source, 'no-manifest')).rejects.toThrow(
      /manifest is missing/,
    );
  });

  it('imports a complete manifest only', async () => {
    const legacy = join(dir, 'claude-skills.txt');
    await writeFile(legacy, 'alpha\n');
    expect(await importLegacySkills({ legacyPath: legacy, sourcePath: source })).toEqual(['alpha']);

    await writeFile(legacy, 'alpha\nabsent\n');
    await expect(importLegacySkills({ legacyPath: legacy, sourcePath: source })).rejects.toThrow(
      CliError,
    );
  });
});

describe('project gitignore planning', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-gitignore-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does nothing outside a git project', async () => {
    const plan = await planProjectGitignore(dir);
    expect(plan.status).toBe('not-project');
    expect(await applyProjectGitignore(plan)).toBe(false);
  });

  it('creates the managed entry', async () => {
    await mkdir(join(dir, '.git'));
    const plan = await planProjectGitignore(dir);
    expect(plan.status).toBe('create');

    expect(await applyProjectGitignore(plan)).toBe(true);
    const content = await import('node:fs/promises').then(({ readFile }) =>
      readFile(join(dir, '.gitignore'), 'utf8'),
    );
    expect(content).toBe(`${MANAGED_GITIGNORE_COMMENT}\n${MANAGED_GITIGNORE_PATTERN}\n`);
    expect((await planProjectGitignore(dir)).status).toBe('kept');
  });

  it('appends the entry to an existing file without a trailing newline', async () => {
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.gitignore'), 'node_modules');
    const plan = await planProjectGitignore(dir);
    expect(plan.status).toBe('update');

    await applyProjectGitignore(plan);
    const content = await import('node:fs/promises').then(({ readFile }) =>
      readFile(join(dir, '.gitignore'), 'utf8'),
    );
    expect(content).toContain('node_modules\n# sksync managed links');
  });

  it('accepts equivalent existing patterns', async () => {
    await mkdir(join(dir, '.git'));
    for (const pattern of ['.claude/skills/', '/.claude/skills']) {
      await writeFile(join(dir, '.gitignore'), `${pattern}\n`);
      expect((await planProjectGitignore(dir)).status).toBe('kept');
    }
  });

  it('refuses a .gitignore that is not a regular file', async () => {
    await mkdir(join(dir, '.git'));
    await mkdir(join(dir, '.gitignore'));
    await expect(planProjectGitignore(dir)).rejects.toThrow(/not a regular file/);
  });

  it('refuses to apply over a concurrently changed file', async () => {
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.gitignore'), 'node_modules');
    const plan = await planProjectGitignore(dir);
    await writeFile(join(dir, '.gitignore'), 'node_modules\nchanged');
    await expect(applyProjectGitignore(plan)).rejects.toThrow(/concurrently changed/);
  });
});
