#!/usr/bin/env node
import { normalizeArguments } from './cli/argv.js';
import { runProgram } from './cli/program.js';
import { asCliError } from './domain/errors.js';
import { exitOnInterrupt } from './runtime/signals.js';
import { renderResult } from './output/render.js';

async function main(): Promise<void> {
  exitOnInterrupt();
  const normalized = normalizeArguments(process.argv.slice(2));
  const exitCode = await runProgram(normalized);
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  const cliError = asCliError(error);
  process.stdout.write(
    renderResult(
      {
        outputVersion: 1,
        command: 'error',
        mode: 'config',
        status: 'error',
        exitCode: cliError.exitCode,
        summary: {},
        items: [],
        warnings: [],
        errors: [cliError.message],
      },
      { json: false, quiet: false, color: false },
    ),
  );
  process.exit(cliError.exitCode);
});
