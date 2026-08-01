import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';

export interface PathIdentity {
  readonly entryPath: string;
  readonly realPath?: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly symbolicLink: boolean;
}

export async function captureIdentity(path: string, follow = false): Promise<PathIdentity> {
  const info = follow ? await stat(path, { bigint: true }) : await lstat(path, { bigint: true });
  let resolved: string | undefined;
  try {
    resolved = await realpath(path);
  } catch {
    // A dangling symlink still has a useful entry identity.
  }
  return {
    entryPath: path,
    ...(resolved === undefined ? {} : { realPath: resolved }),
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeNs: info.mtimeNs,
    symbolicLink: info.isSymbolicLink(),
  };
}

export function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return (
    left.entryPath === right.entryPath &&
    left.realPath === right.realPath &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.symbolicLink === right.symbolicLink
  );
}

export function hashBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function hashFile(path: string): Promise<string> {
  return hashBytes(await readFile(path));
}
