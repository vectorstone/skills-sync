import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = join(process.cwd(), 'dist', 'cli.js');

async function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('CLI integration', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'skills-sync-it-'));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  async function makeSkill(name: string, content = `# ${name}`): Promise<void> {
    await mkdir(join(project, '.agents', 'skills', name), { recursive: true });
    await writeFile(join(project, '.agents', 'skills', name, 'SKILL.md'), content);
  }

  it('exits 2 when no scope is provided', async () => {
    const result = await run(['check']);
    expect(result.code).toBe(2);
  });

  it('init --all, sync, check, list form a working loop', async () => {
    await makeSkill('alpha');
    await makeSkill('beta');

    const init = await run(['init', '--all', `--project=${project}`, '--yes']);
    expect(init.code).toBe(0);
    const config = JSON.parse(await readFile(join(project, '.agents', 'skills-sync.json'), 'utf8'));
    expect(config.skills).toEqual(['alpha', 'beta']);

    const sync = await run(['sync', `--project=${project}`]);
    expect(sync.code).toBe(0);
    expect((await lstat(join(project, '.claude', 'skills', 'alpha'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(project, '.claude', 'skills', 'beta'))).isSymbolicLink()).toBe(true);

    const check = await run(['check', `--project=${project}`]);
    expect(check.code).toBe(0);
  });

  it('check reports drift (exit 4) when a link is missing', async () => {
    await makeSkill('alpha');
    await run(['init', '--all', `--project=${project}`, '--yes']);
    const checkBeforeSync = await run(['check', `--project=${project}`]);
    expect(checkBeforeSync.code).toBe(4);
  });

  it('add and remove update the config', async () => {
    await makeSkill('alpha');
    await makeSkill('beta');
    await run(['init', '--empty', `--project=${project}`, '--yes']);
    await run(['add', 'alpha', `--project=${project}`]);
    let config = JSON.parse(await readFile(join(project, '.agents', 'skills-sync.json'), 'utf8'));
    expect(config.skills).toEqual(['alpha']);
    await run(['remove', 'alpha', `--project=${project}`]);
    config = JSON.parse(await readFile(join(project, '.agents', 'skills-sync.json'), 'utf8'));
    expect(config.skills).toEqual([]);
  });

  it('sync --force replaces a wrong symlink', async () => {
    await makeSkill('alpha');
    await mkdir(join(project, '.claude', 'skills'), { recursive: true });
    await symlink('/nonexistent/wrong', join(project, '.claude', 'skills', 'alpha'));
    await run(['init', '--empty', `--project=${project}`, '--yes']);
    await run(['add', 'alpha', `--project=${project}`]);

    const blocked = await run(['sync', `--project=${project}`]);
    expect(blocked.code).toBe(5);

    const forced = await run(['sync', `--project=${project}`, '--force', '--yes']);
    expect(forced.code).toBe(0);
    expect((await lstat(join(project, '.claude', 'skills', 'alpha'))).isSymbolicLink()).toBe(true);
  });

  it('sync --prune removes a stale managed link', async () => {
    await makeSkill('alpha');
    await run(['init', '--all', `--project=${project}`, '--yes']);
    await run(['sync', `--project=${project}`]);
    await run(['remove', 'alpha', `--project=${project}`]);

    const pruned = await run(['sync', `--project=${project}`, '--prune', '--yes']);
    expect(pruned.code).toBe(0);
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

  it('migrates a legacy claude-skills.txt manifest', async () => {
    await makeSkill('alpha');
    await makeSkill('beta');
    await mkdir(join(project, '.agents'), { recursive: true });
    await writeFile(
      join(project, '.agents', 'claude-skills.txt'),
      '# comment\nalpha\n\nbeta # inline\n',
    );
    const migrate = await run(['init', '--from-legacy', `--project=${project}`, '--yes']);
    expect(migrate.code).toBe(0);
    const config = JSON.parse(await readFile(join(project, '.agents', 'skills-sync.json'), 'utf8'));
    expect(config.skills).toEqual(['alpha', 'beta']);
  });

  it('refuses to overwrite a real directory with --force', async () => {
    await makeSkill('alpha');
    await mkdir(join(project, '.claude', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(project, '.claude', 'skills', 'alpha', 'real'), 'x');
    await run(['init', '--empty', `--project=${project}`, '--yes']);
    await run(['add', 'alpha', `--project=${project}`]);
    const forced = await run(['sync', `--project=${project}`, '--force', '--yes']);
    expect(forced.code).toBe(5);
  });
});
