export const EXIT_CODES = {
  ok: 0,
  usage: 2,
  missing: 3,
  drift: 4,
  blocked: 5,
  cancelled: 6,
  io: 7,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly status: 'error' | 'cancelled';

  constructor(message: string, exitCode: ExitCode, status: 'error' | 'cancelled' = 'error') {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.status = status;
  }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error) return new CliError(error.message, EXIT_CODES.io);
  return new CliError(String(error), EXIT_CODES.io);
}
