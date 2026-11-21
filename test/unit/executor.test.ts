import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executePlan, executeSync } from '../../src/sync/executor.js';
import { normalizeArguments } from '../../src/cli/argv.js';
import { CliError } from '../../src/domain/errors.js';

describe('plan execution', () => {
  let dir: string;
  let source: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-exec-'));
    source = join(dir, 'source');
    target = join(dir, 'target');
    await mkdir(join(source, 'alpha'), { recursive: true });
    await symlink(join(source, 'alpha'), join(dir, 'alpha-source'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a link and reports success', async () => {
    const result = await executePlan(dir, source, target, [
      {
        name: 'alpha',
        sourcePath: join(source, 'alpha'),
        targetPath: join(target, 'alpha'),
        status: 'create',
      },
    ]);

    expect(result.failed).toBe(false);
    expect(result.items[0]?.outcome).toBe('succeeded');
    expect((await lstat(join(target, 'alpha'))).isSymbolicLink()).toBe(true);
  });

  it('skips dry runs and non-mutating items', async () => {
    const result = await executePlan(
      dir,
      source,
      target,
      [
        {
          name: 'alpha',
          sourcePath: join(source, 'alpha'),
          targetPath: join(target, 'alpha'),
          status: 'create',
        },
        { name: 'kept', status: 'kept' },
        { name: 'blocked', status: 'blocked' },
      ],
      { dryRun: true },
    );

    expect(result.items.map((item) => item.outcome)).toEqual(['skipped', 'succeeded', 'skipped']);
    expect(result.failed).toBe(false);
  });

  it('removes only an exact managed link', async () => {
    const real = await realpath(join(source, 'alpha'));
    await mkdir(target, { recursive: true });
    await symlink(real, join(target, 'alpha'));

    const removed = await executePlan(dir, source, target, [
      { name: 'alpha', sourcePath: real, targetPath: join(target, 'alpha'), status: 'remove' },
    ]);
    expect(removed.items[0]?.outcome).toBe('succeeded');

    const skipped = await executePlan(dir, source, target, [
      { name: 'alpha', sourcePath: real, targetPath: join(target, 'alpha'), status: 'remove' },
    ]);
    expect(skipped.items[0]?.outcome).toBe('skipped');
  });

  it('replaces an existing link atomically on update', async () => {
    await mkdir(target, { recursive: true });
    await symlink('/somewhere/else', join(target, 'alpha'));

    const result = await executePlan(
      dir,
      source,
      target,
      [
        {
          name: 'alpha',
          sourcePath: join(source, 'alpha'),
          targetPath: join(target, 'alpha'),
          status: 'update',
        },
      ],
      { force: true },
    );

    expect(result.items[0]?.outcome).toBe('succeeded');
    expect((await lstat(join(target, 'alpha'))).isSymbolicLink()).toBe(true);
  });

  it('skips updating a target that is no longer a symlink', async () => {
    await mkdir(target, { recursive: true });
    await mkdir(join(target, 'alpha'));

    const result = await executePlan(dir, source, target, [
      {
        name: 'alpha',
        sourcePath: join(source, 'alpha'),
        targetPath: join(target, 'alpha'),
        status: 'update',
      },
    ]);

    expect(result.items[0]?.outcome).toBe('skipped');
  });

  it('marks failures when the plan is malformed or the write fails', async () => {
    const missingTarget = await executePlan(dir, source, target, [
      { name: 'alpha', sourcePath: join(source, 'alpha'), status: 'create' },
    ]);
    expect(missingTarget.failed).toBe(true);

    const missingSource = await executePlan(dir, source, target, [
      { name: 'alpha', targetPath: join(target, 'alpha'), status: 'create' },
    ]);
    expect(missingSource.failed).toBe(true);

    const badSource = await executePlan(dir, source, target, [
      {
        name: 'alpha',
        sourcePath: join(dir, 'does-not-exist'),
        targetPath: join(target, 'alpha'),
        status: 'create',
      },
    ]);
    expect(badSource.failed).toBe(true);
  });

  it('invokes onAction before each mutation', async () => {
    const onAction = vi.fn(async () => undefined);
    await executePlan(
      dir,
      source,
      target,
      [
        {
          name: 'alpha',
          sourcePath: join(source, 'alpha'),
          targetPath: join(target, 'alpha'),
          status: 'create',
        },
      ],
      { onAction },
    );
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('exposes the legacy alias', () => {
    expect(executeSync).toBe(executePlan);
  });
});

describe('argument normalization', () => {
  it('separates globals from command arguments', () => {
    expect(normalizeArguments(['list', '--json', '--no-color', '--yes'])).toEqual({
      argv: ['list'],
      globals: { json: true, noColor: true, yes: true },
    });
  });

  it('reads --config in both forms', () => {
    expect(normalizeArguments(['--config', 'x.json', 'list']).globals).toEqual({
      config: 'x.json',
    });
    expect(normalizeArguments(['--config=y.json', 'list']).globals).toEqual({ config: 'y.json' });
    expect(() => normalizeArguments(['--config'])).toThrow(/requires a value/);
  });

  it('consumes the space-separated --config value instead of leaking it', () => {
    expect(normalizeArguments(['list', '--config', 'x.json'])).toEqual({
      argv: ['list'],
      globals: { config: 'x.json' },
    });
    expect(() => normalizeArguments(['list', '--config='])).toThrow(/requires a value/);
    expect(() => normalizeArguments(['list', '--config', ''])).toThrow(/requires a value/);
    expect(() => normalizeArguments(['list', '--config', '--json'])).toThrow(/requires a value/);
  });

  it('rejects conflicting scope flags and relative project paths', () => {
    expect(() => normalizeArguments(['--global', '--project', 'list'])).toThrow(CliError);
    expect(() => normalizeArguments(['--project=relative', 'list'])).toThrow(CliError);
    expect(() => normalizeArguments(['--project=', 'list'])).toThrow(CliError);
  });

  it('rejects --json together with --quiet', () => {
    expect(() => normalizeArguments(['list', '--json', '--quiet'])).toThrow(/mutually exclusive/);
  });
});
