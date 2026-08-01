import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function atomicWriteFile(
  destination: string,
  content: string | Uint8Array,
  mode = 0o644,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const temporary = join(
    dirname(destination),
    `.${destination.split(/[\\/]/).at(-1) ?? 'file'}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (beforeRename !== undefined) await beforeRename();
    await rename(temporary, destination);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
