import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteFile } from '../../src/fs/atomic-write.js';
import { captureIdentity, hashBytes, hashFile, sameIdentity } from '../../src/fs/identity.js';
import { createResult } from '../../src/output/result.js';
import { renderResult } from '../../src/output/render.js';
import type { CommandResult } from '../../src/domain/types.js';

describe('atomic file writes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-atomic-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes content and leaves no temporary file behind', async () => {
    const destination = join(dir, 'file.json');
    await atomicWriteFile(destination, '{"a":1}\n');

    expect(await readFile(destination, 'utf8')).toBe('{"a":1}\n');
    const entries = await readFile(join(dir, '.'), { encoding: 'utf8' }).catch(() => '');
    expect(entries).not.toContain('.tmp');
  });

  it('applies the requested mode', async () => {
    const destination = join(dir, 'exec.sh');
    await atomicWriteFile(destination, 'echo hi\n', 0o755);
    expect((await stat(destination)).mode & 0o777).toBe(0o755);
  });

  it('runs beforeRename and discards the temporary file when it throws', async () => {
    const destination = join(dir, 'guarded.json');
    let called = false;
    await expect(
      atomicWriteFile(destination, 'x', 0o644, async () => {
        called = true;
        throw new Error('guard failed');
      }),
    ).rejects.toThrow('guard failed');

    expect(called).toBe(true);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('path identity', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sksync-identity-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('captures the same identity for an unchanged path', async () => {
    const file = join(dir, 'note.md');
    await writeFile(file, '# note\n');

    const first = await captureIdentity(file);
    const second = await captureIdentity(file);

    expect(sameIdentity(first, second)).toBe(true);
    expect(first.symbolicLink).toBe(false);
    expect(first.realPath).toBeDefined();
  });

  it('detects a modified file through mtime and size', async () => {
    const file = join(dir, 'note.md');
    await writeFile(file, '# note\n');
    const before = await captureIdentity(file);
    await writeFile(file, '# note changed\n');
    const after = await captureIdentity(file);

    expect(sameIdentity(before, after)).toBe(false);
  });

  it('keeps a dangling symlink identity without a real path', async () => {
    const link = join(dir, 'dangling');
    const { symlink } = await import('node:fs/promises');
    await symlink(join(dir, 'missing'), link);

    const identity = await captureIdentity(link);
    expect(identity.symbolicLink).toBe(true);
    expect(identity.realPath).toBeUndefined();
  });

  it('follows a symlink when asked to', async () => {
    const file = join(dir, 'note.md');
    const link = join(dir, 'link.md');
    const { symlink } = await import('node:fs/promises');
    await writeFile(file, '# note\n');
    await symlink(file, link);

    expect((await captureIdentity(link)).symbolicLink).toBe(true);
    expect((await captureIdentity(link, true)).symbolicLink).toBe(false);
  });

  it('hashes bytes and files consistently', async () => {
    const file = join(dir, 'blob.txt');
    await writeFile(file, 'content');

    expect(hashBytes('content')).toBe(await hashFile(file));
    expect(hashBytes(Buffer.from('content'))).toBe(hashBytes('content'));
  });
});

describe('result rendering', () => {
  const base: CommandResult = createResult({
    command: 'list',
    mode: 'check',
    exitCode: 0,
    items: [
      { name: 'beta', status: 'kept' },
      { name: 'alpha', status: 'create' },
    ],
    warnings: ['b warning', 'a warning'],
    errors: ['b error', 'a error'],
    paths: {
      scope: { kind: 'project', root: '/tmp/demo' },
      configPath: '/tmp/demo/.agents/skills-sync.json',
      sourcePath: '/tmp/demo/.agents/skills',
      targetPath: '/tmp/demo/.claude/skills',
      rawSource: '.agents/skills',
      rawTarget: '.claude/skills',
    },
  });

  it('sorts items and derives a summary', () => {
    expect(base.items.map((item) => item.name)).toEqual(['alpha', 'beta']);
    expect(base.summary).toEqual({ create: 1, kept: 1 });
    expect(base.warnings).toEqual(['a warning', 'b warning']);
    expect(base.errors).toEqual(['a error', 'b error']);
    expect(base.status).toBe('ok');
  });

  it('marks a non-zero exit code as an error', () => {
    expect(createResult({ command: 'check', mode: 'check', exitCode: 4 }).status).toBe('error');
  });

  it('renders a readable summary', () => {
    const text = renderResult(base, { json: false, quiet: false, color: false });
    expect(text).toContain('config: /tmp/demo/.agents/skills-sync.json');
    expect(text).toContain('create: alpha');
    expect(text).toContain('warning: a warning');
    expect(text).toContain('error: a error');
    expect(text).toContain('list ok: create=1 kept=1');
    expect(text).not.toContain('\u001b[');
  });

  it('colors status labels when enabled', () => {
    const text = renderResult(base, { json: false, quiet: false, color: true });
    expect(text).toContain('\u001b[36mcreate\u001b[0m');
  });

  it('renders JSON, suppresses quiet success, and keeps quiet failures', () => {
    const json = renderResult(base, { json: true, quiet: false, color: false });
    expect(JSON.parse(json)).toMatchObject({ outputVersion: 1, command: 'list' });

    expect(renderResult(base, { json: false, quiet: true, color: false })).toBe('');

    const failing = createResult({ command: 'check', mode: 'check', exitCode: 4 });
    expect(renderResult(failing, { json: false, quiet: true, color: false })).toContain(
      'check error',
    );
  });

  it('shortens paths inside the home directory', () => {
    const home = homedir();
    const result = createResult({
      command: 'list',
      mode: 'check',
      paths: {
        scope: { kind: 'project', root: home },
        configPath: join(home, '.agents', 'skills-sync.json'),
        sourcePath: home,
        targetPath: '/elsewhere/skills',
        rawSource: '.agents/skills',
        rawTarget: '.claude/skills',
      },
    });

    const text = renderResult(result, { json: false, quiet: false, color: false });
    expect(text).toContain('source: ~');
    expect(text).toContain('config: ~/.agents/skills-sync.json');
    expect(text).toContain('target: /elsewhere/skills');
  });
});
