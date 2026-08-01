import { confirm as confirmPrompt } from '@inquirer/prompts';

export function canPrompt(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function confirmAction(message: string, defaultValue = false): Promise<boolean> {
  if (!canPrompt()) return false;
  try {
    return await confirmPrompt({ message, default: defaultValue });
  } catch {
    return false;
  }
}
