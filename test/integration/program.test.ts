import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeArguments } from '../../src/cli/argv.js';
import { runProgram } from '../../src/cli/program.js';

/**
 * Same scenarios as cli.test.ts, but through runProgram in-process so the v8
 * coverage provider can attribute the executed lines to src/.
 */
async function run(args: readonly string[]): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as never);
  try {
    const code = await runProgram(normalizeArguments([...args]));
    return { code, stdout: chunks.join('') };
  } finally {
    spy.mockRestore();
  }
}

describe('program in-process', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'sksync-inproc-'));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  async function makeSkill(name: string, content = `# ${name}`): Promise<void> {
    await mkdir(join(project, '.agents', 'skills', name), { recursive: true });
    await writeFile(join(project, '.agents', 'skills', name, 'SKILL.md'), content);
  }

  async function readConfig(): Promise<{ skills: string[] }> {
    return JSON.parse(await readFile(join(project, '.agents', 'skills-sync.json'), 'utf8')) as {
      skills: string[];
    };
  }

  function setTty(value: boolean): () => void {
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
    return () => {
      if (stdin === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdin, 'isTTY', stdin);
      if (stdout === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, 'isTTY', stdout);
    };
  }

  it('exits 2 when no scope is provided', async () => {
    expect((await run(['check'])).code).toBe(2);
  });

  it('init --all, sync, check, list form a working loop', async () => {
    await makeSkill('alpha');
    await makeSkill('beta');

    expect((await run(['init', '--all', `--project=${project}`, '--yes'])).code).toBe(0);
    expect((await readConfig()).skills).toEqual(['alpha', 'beta']);

    expect((await run(['sync', `--project=${project}`])).code).toBe(0);
    expect((await lstat(join(project, '.claude', 'skills', 'alpha'))).isSymbolicLink()).toBe(true);

    expect((await run(['check', `--project=${project}`])).code).toBe(0);

    const listed = await run(['list', `--project=${project}`]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('kept: alpha');
    expect(listed.stdout).toContain('list ok');
  });

  it('lists available source skills that are not configured', async () => {
    await makeSkill('alpha');
    await makeSkill('gamma');
    await run(['init', '--empty', `--project=${project}`, '--yes']);
    await run(['add', 'alpha', `--project=${project}`]);

    const listed = await run(['list', '--available', `--project=${project}`]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('gamma');
    expect(listed.stdout).toContain('available, not configured');
  });

  it('check reports drift (exit 4) when a link is missing', async () => {
    await makeSkill('alpha');
    await run(['init', '--all', `--project=${project}`, '--yes']);
    expect((await run(['check', `--project=${project}`])).code).toBe(4);
  });

  it('check --strict treats stale managed links as drift', async () => {
    await makeSkill('alpha');
    await run(['init', '--all', `--project=${project}`, '--yes']);
    await run(['sync', `--project=${project}`]);
    await run(['remove', 'alpha', `--project=${project}`]);

    expect((await run(['check', `--project=${project}`])).code).toBe(0);
    expect((await run(['check', '--strict', `--project=${project}`])).code).toBe(4);
  });

  it('reports a missing source directory (exit 3)', async () => {
    await mkdir(join(project, '.agents'), { recursive: true });
    await writeFile(
      join(project, '.agents', 'skills-sync.json'),
      `${JSON.stringify({ schemaVersion: 1, source: '.agents/skills', target: '.claude/skills', skills: ['alpha'] })}\n`,
    );

    expect((await run(['sync', `--project=${project}`])).code).toBe(3);
    expect((await run(['check', `--project=${project}`])).code).toBe(3);
  });

  it('sync --dry-run accepts a symlinked source root', async () => {
    const realSourcePath = join(project, 'shared', 'skills');
    await mkdir(join(realSourcePath, 'alpha'), { recursive: true });
    await writeFile(join(realSourcePath, 'alpha', 'SKILL.md'), '# alpha\n');
    await mkdir(join(project, '.agents'), { recursive: true });
    await symlink(realSourcePath, join(project, '.agents', 'skills'), 'dir');
    await writeFile(
      join(project, '.agents', 'skills-sync.json'),
      `${JSON.stringify({ schemaVersion: 1, source: '.agents/skills', target: '.claude/skills', skills: ['alpha'] })}\n`,
    );

    const result = await run(['sync', '--dry-run', `--project=${project}`]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('create: alpha');
    await expect(lstat(join(project, '.claude', 'skills'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('add and remove update the config', async () => {
    await makeSkill('alpha');
    await run(['init', '--empty', `--project=${project}`, '--yes']);
    expect((await run(['add', 'alpha', `--project=${project}`])).code).toBe(0);
    expect((await readConfig()).skills).toEqual(['alpha']);
    expect((await run(['remove', 'alpha', `--project=${project}`])).code).toBe(0);
    expect((await readConfig()).skills).toEqual([]);
  });

  it('sync --force replaces a wrong symlink', async () => {
    await makeSkill('alpha');
    await mkdir(join(project, '.claude', 'skills'), { recursive: true });
    await symlink('/nonexistent/wrong', join(project, '.claude', 'skills', 'alpha'));
    await run(['init', '--empty', `--project=${project}`, '--yes']);
    await run(['add', 'alpha', `--project=${project}`]);

    expect((await run(['sync', `--project=${project}`])).code).toBe(5);
    expect((await run(['sync', `--project=${project}`, '--force', '--yes'])).code).toBe(0);
    expect((await lstat(join(project, '.claude', 'skills', 'alpha'))).isSymbolicLink()).toBe(true);
  });

  it('cancels a prune without confirmation when not on a TTY', async () => {
    await makeSkill('alpha');
    await run(['init', '--all', `--project=${project}`, '--yes']);
    await run(['sync', `--project=${project}`]);
    await run(['remove', 'alpha', `--project=${project}`]);

    const cancelled = await run(['sync', `--project=${project}`, '--prune']);
    expect(cancelled.code).toBe(6);
    expect(cancelled.stdout).toContain('cancelled');
    expect((await lstat(join(project, '.claude', 'skills', 'alpha'))).isSymbolicLink()).toBe(true);
  });

  it('sync --prune removes a stale managed link', async () => {
    await makeSkill('alpha');
    await run(['init', '--all', `--project=${project}`, '--yes']);
    await run(['sync', `--project=${project}`]);
    await run(['remove', 'alpha', `--project=${project}`]);

    expect((await run(['sync', `--project=${project}`, '--prune', '--yes'])).code).toBe(0);
    await expect(stat(join(project, '.claude', 'skills', 'alpha'))).rejects.toThrow();
  });

  it('emits a single valid JSON document with --json', async () => {
    await makeSkill('alpha');
    await run(['init', '--all', `--project=${project}`, '--yes']);
    const result = await run(['list', `--project=${project}`, '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { outputVersion: number; command: string };
    expect(parsed.outputVersion).toBe(1);
    expect(parsed.command).toBe('list');
  });

  it('honours --quiet on success and --no-color on failure', async () => {
    await makeSkill('alpha');
    await run(['init', '--all', `--project=${project}`, '--yes']);

    const quiet = await run(['list', `--project=${project}`, '--quiet']);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe('');

    const colored = await run(['check', `--project=${project}`, '--no-color']);
    expect(colored.code).toBe(4);
    expect(colored.stdout).not.toContain('\u001b[');
  });

  it('migrates a legacy claude-skills.txt manifest', async () => {
    await makeSkill('alpha');
    await makeSkill('beta');
    await mkdir(join(project, '.agents'), { recursive: true });
    await writeFile(
      join(project, '.agents', 'claude-skills.txt'),
      '# comment\nalpha\n\nbeta # inline\n',
    );
    expect((await run(['init', '--from-legacy', `--project=${project}`, '--yes'])).code).toBe(0);
    expect((await readConfig()).skills).toEqual(['alpha', 'beta']);
  });

  it('rejects several init selection modes at once', async () => {
    await makeSkill('alpha');
    const result = await run(['init', '--all', '--empty', `--project=${project}`, '--yes']);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('at most one of');
  });

  it('refuses to overwrite a real directory with --force', async () => {
    await makeSkill('alpha');
    await mkdir(join(project, '.claude', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(project, '.claude', 'skills', 'alpha', 'real'), 'x');
    await run(['init', '--empty', `--project=${project}`, '--yes']);
    await run(['add', 'alpha', `--project=${project}`]);
    expect((await run(['sync', `--project=${project}`, '--force', '--yes'])).code).toBe(5);
  });

  it('requires a selection mode when interactive init is unavailable', async () => {
    const restore = setTty(false);
    try {
      const result = await run(['init', `--project=${project}`]);
      expect(result.code).toBe(2);
      expect(result.stdout).toContain('Interactive init requires a TTY');
    } finally {
      restore();
    }
  });

  it('honours --config, --source, and --target overrides', async () => {
    const root = await realpath(project);
    await makeSkill('alpha');
    await makeSkill('beta');
    await run(['init', '--empty', `--project=${root}`, '--yes']);
    await run(['add', 'alpha', `--project=${root}`]);
    await mkdir(join(root, 'alt', 'alpha'), { recursive: true });
    await writeFile(join(root, 'alt', 'alpha', 'SKILL.md'), '# alpha\n');

    const configPath = join(root, 'custom.json');
    await writeFile(
      configPath,
      `${JSON.stringify({ schemaVersion: 1, source: '.agents/skills', target: '.claude/skills', skills: ['alpha'] })}\n`,
    );

    const listed = await run([
      'list',
      `--project=${root}`,
      `--config=${configPath}`,
      `--source=${join(root, 'alt')}`,
      `--target=${join(root, 'links')}`,
    ]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('create: alpha');
    expect(listed.stdout).toContain(`source: ${join(root, 'alt')}`);
    expect(listed.stdout).toContain(`target: ${join(root, 'links')}`);
    expect(listed.stdout).not.toContain('beta');

    const spaced = await run(['list', '--config', configPath, `--project=${root}`]);
    expect(spaced.code).toBe(0);
    expect(spaced.stdout).toContain(`config: ${configPath}`);

    // A relative --config is resolved against the project root, not the cwd.
    const relative = await run(['list', '--config=custom.json', `--project=${root}`]);
    expect(relative.code).toBe(0);
    expect(relative.stdout).toContain(`config: ${configPath}`);
  });

  it('accepts --config on init and writes there', async () => {
    const root = await realpath(project);
    await makeSkill('alpha');
    const configPath = join(root, 'custom.json');

    const result = await run([
      'init',
      '--empty',
      `--project=${root}`,
      '--yes',
      '--config',
      configPath,
    ]);
    expect(result.code).toBe(0);
    const written = JSON.parse(await readFile(configPath, 'utf8')) as { skills: string[] };
    expect(written.skills).toEqual([]);
  });

  it('reports an add failure with an io exit code', async () => {
    await makeSkill('alpha');
    await run(['init', '--empty', `--project=${project}`, '--yes']);
    const result = await run(['add', 'gamma', `--project=${project}`]);
    expect(result.code).toBe(7);
    expect(result.stdout).toContain('gamma');
  });

  it('rejects a config path outside the scope', async () => {
    const result = await run(['list', `--project=${project}`, '--config=../outside.json']);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('must remain inside the selected scope');
  });
});
