import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../fs/atomic-write.js';
import { hashBytes, hashFile } from '../fs/identity.js';
import { CliError, EXIT_CODES } from '../domain/errors.js';

export const MANAGED_GITIGNORE_COMMENT = '# agent-skills-sync managed links';
export const MANAGED_GITIGNORE_PATTERN = '/.claude/skills/';

export type GitignorePlan =
  | { readonly status: 'not-project' | 'kept'; readonly path: string }
  | {
      readonly status: 'create';
      readonly path: string;
      readonly content: string;
    }
  | {
      readonly status: 'update';
      readonly path: string;
      readonly beforeHash: string;
      readonly content: string;
    };

/** Plan the project-only managed .gitignore entry without changing the filesystem. */
export async function planProjectGitignore(projectRoot: string): Promise<GitignorePlan> {
  const path = join(projectRoot, '.gitignore');
  if (!(await pathExists(join(projectRoot, '.git')))) return { status: 'not-project', path };

  let existing: string;
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) {
      throw new CliError(`Project .gitignore is not a regular file: ${path}`, EXIT_CODES.blocked);
    }
    existing = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (isMissing(error)) {
      return {
        status: 'create',
        path,
        content: `${MANAGED_GITIGNORE_COMMENT}\n${MANAGED_GITIGNORE_PATTERN}\n`,
      };
    }
    throw error;
  }

  if (hasIgnorePattern(existing)) return { status: 'kept', path };
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  return {
    status: 'update',
    path,
    beforeHash: hashBytes(existing),
    content: `${existing}${separator}${MANAGED_GITIGNORE_COMMENT}\n${MANAGED_GITIGNORE_PATTERN}\n`,
  };
}

/** Apply exactly the planned content, refusing to overwrite a concurrently changed file. */
export async function applyProjectGitignore(plan: GitignorePlan): Promise<boolean> {
  if (plan.status === 'not-project' || plan.status === 'kept') return false;
  const writePlan = plan as Extract<GitignorePlan, { readonly status: 'create' | 'update' }>;

  if (writePlan.status === 'create') {
    try {
      await lstat(writePlan.path);
      throw concurrentChange(writePlan.path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  } else {
    try {
      if ((await hashFile(writePlan.path)) !== writePlan.beforeHash)
        throw concurrentChange(writePlan.path);
    } catch (error) {
      if (isMissing(error)) throw concurrentChange(writePlan.path);
      throw error;
    }
  }

  await atomicWriteFile(writePlan.path, writePlan.content, 0o644, async () => {
    if (plan.status === 'create') {
      try {
        await lstat(writePlan.path);
        throw concurrentChange(writePlan.path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      return;
    }
    if (writePlan.status !== 'update') return;
    try {
      if ((await hashFile(writePlan.path)) !== writePlan.beforeHash)
        throw concurrentChange(writePlan.path);
    } catch (error) {
      if (isMissing(error)) throw concurrentChange(writePlan.path);
      throw error;
    }
  });
  return true;
}

function hasIgnorePattern(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const pattern = line.trim();
    return (
      pattern === MANAGED_GITIGNORE_PATTERN ||
      pattern === '.claude/skills/' ||
      pattern === '/.claude/skills'
    );
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function concurrentChange(path: string): CliError {
  return new CliError(
    `Refusing to overwrite concurrently changed .gitignore: ${path}`,
    EXIT_CODES.io,
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
