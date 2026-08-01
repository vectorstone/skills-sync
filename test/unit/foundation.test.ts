import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { normalizeScopeArguments } from '../../src/cli/argv.js';
import { parseConfig, serializeConfig } from '../../src/config/schema.js';
import { CliError } from '../../src/domain/errors.js';
import { isWithin, projectedRealpath } from '../../src/fs/path-guard.js';
import { canonicalNames, isValidSkillName } from '../../src/skills/name.js';

describe('scope argument normalization', () => {
  it('accepts scope before or after the command', () => {
    expect(normalizeScopeArguments(['--project', 'sync'])).toEqual({
      argv: ['sync'],
      scope: { kind: 'project' },
    });
    expect(normalizeScopeArguments(['sync', '--global'])).toEqual({
      argv: ['sync'],
      scope: { kind: 'global' },
    });
  });

  it('requires equals syntax for an explicit project path', () => {
    expect(normalizeScopeArguments(['sync', '--project=/tmp/demo'])).toEqual({
      argv: ['sync'],
      scope: { kind: 'project', projectPath: '/tmp/demo' },
    });
    expect(() => normalizeScopeArguments(['sync', '--project=relative'])).toThrow(CliError);
  });

  it('rejects conflicting scopes', () => {
    expect(() => normalizeScopeArguments(['--global', 'sync', '--project'])).toThrow(CliError);
  });
});

describe('strict config schema', () => {
  const valid = {
    schemaVersion: 1,
    source: '.agents/skills',
    target: '.claude/skills',
    skills: ['alpha', 'beta'],
  } as const;

  it('round trips canonical JSON', () => {
    expect(parseConfig(serializeConfig(valid), 'config.json')).toEqual(valid);
  });

  it('rejects unknown fields, BOMs, duplicates, and unsorted names', () => {
    expect(() => parseConfig(JSON.stringify({ ...valid, extra: true }), 'config.json')).toThrow(
      CliError,
    );
    const bom = String.fromCharCode(0xfeff);
    expect(() => parseConfig(bom + JSON.stringify(valid), 'config.json')).toThrow(CliError);
    expect(() =>
      parseConfig(JSON.stringify({ ...valid, skills: ['alpha', 'alpha'] }), 'config.json'),
    ).toThrow(CliError);
    expect(() =>
      parseConfig(JSON.stringify({ ...valid, skills: ['beta', 'alpha'] }), 'config.json'),
    ).toThrow(CliError);
  });
});

describe('skill names', () => {
  it('uses a safe ASCII segment grammar', () => {
    expect(isValidSkillName('foo.bar_baz-2')).toBe(true);
    expect(isValidSkillName('.hidden')).toBe(false);
    expect(isValidSkillName('foo.')).toBe(false);
    expect(isValidSkillName('foo..bar')).toBe(false);
    expect(isValidSkillName('中文')).toBe(false);
  });

  it('deduplicates and sorts canonically', () => {
    expect(canonicalNames(['beta', 'Alpha', 'beta'])).toEqual(['Alpha', 'beta']);
  });
});

describe('path projection', () => {
  it('recognizes strict descendants', () => {
    expect(isWithin('/tmp/root', '/tmp/root/child')).toBe(true);
    expect(isWithin('/tmp/root', '/tmp/root', false)).toBe(false);
    expect(isWithin('/tmp/root', '/tmp/root-other')).toBe(false);
  });

  it('projects a missing suffix through the nearest real ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-sync-path-'));
    await mkdir(join(root, 'existing'));
    await writeFile(join(root, 'existing', 'file'), 'x');
    const realRoot = await realpath(root);
    await expect(projectedRealpath(join(root, 'existing', 'future', 'leaf'))).resolves.toBe(
      join(realRoot, 'existing', 'future', 'leaf'),
    );
  });
});
