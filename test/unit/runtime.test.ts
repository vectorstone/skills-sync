import { afterEach, describe, expect, it, vi } from 'vitest';
import { canPrompt, confirmAction } from '../../src/runtime/confirm.js';
import { exitOnInterrupt, onInterrupt } from '../../src/runtime/signals.js';
import { VERSION } from '../../src/version.js';
import pkg from '../../package.json' with { type: 'json' };

const prompts = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('@inquirer/prompts', () => ({ confirm: prompts.confirm }));

function setTty(value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
  return () => {
    if (descriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdin, 'isTTY', descriptor);
    if (stdoutDescriptor === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
  };
}

afterEach(() => {
  prompts.confirm.mockReset();
});

describe('version', () => {
  it('matches the package manifest', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('falls back when the manifest cannot be read', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        readFileSync: () => {
          throw new Error('unreadable');
        },
      };
    });
    try {
      const reloaded = await import('../../src/version.js');
      expect(reloaded.VERSION).toBe('0.0.0');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('interaction guards', () => {
  it('detects a TTY', () => {
    const restore = setTty(true);
    try {
      expect(canPrompt()).toBe(true);
    } finally {
      restore();
    }
    const restoreOff = setTty(false);
    try {
      expect(canPrompt()).toBe(false);
    } finally {
      restoreOff();
    }
  });

  it('returns false without prompting when not on a TTY', async () => {
    const restore = setTty(false);
    try {
      expect(await confirmAction('Continue?', true)).toBe(false);
    } finally {
      restore();
    }
    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  it('forwards the answer when prompting is possible', async () => {
    const restore = setTty(true);
    prompts.confirm.mockResolvedValue(true);
    try {
      expect(await confirmAction('Continue?', false)).toBe(true);
    } finally {
      restore();
    }
    expect(prompts.confirm).toHaveBeenCalledWith({ message: 'Continue?', default: false });
  });

  it('treats a prompt failure as a refusal', async () => {
    const restore = setTty(true);
    prompts.confirm.mockRejectedValue(new Error('aborted'));
    try {
      expect(await confirmAction('Continue?')).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('interrupt handling', () => {
  const listenersBefore = process.listenerCount('SIGINT');

  afterEach(() => {
    process.removeAllListeners('SIGINT');
    for (let index = 0; index < listenersBefore; index += 1) process.on('SIGINT', () => {});
  });

  it('runs the handler once and detaches itself', () => {
    let calls = 0;
    onInterrupt(() => {
      calls += 1;
    });

    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGINT', 'SIGINT');

    expect(calls).toBe(1);
  });

  it('writes an interrupt notice and exits 130', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      exitOnInterrupt();
      process.emit('SIGINT', 'SIGINT');

      expect(write).toHaveBeenCalledWith('Interrupted.\n');
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      write.mockRestore();
      exit.mockRestore();
    }
  });
});
