import { CliError, EXIT_CODES } from '../domain/errors.js';

const SKILL_NAME = /^(?=.{1,128}$)[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME.test(name) && !name.includes('..');
}

export function assertSkillName(name: string): void {
  if (!isValidSkillName(name)) {
    throw new CliError(
      `Invalid skill name "${name}". Use 1-128 ASCII letters, digits, dots, underscores, or hyphens; begin and end with a letter or digit; do not use "..".`,
      EXIT_CODES.usage,
    );
  }
}

export function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertSortedUnique(names: readonly string[]): void {
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (name === undefined) continue;
    assertSkillName(name);
    if (index > 0) {
      const previous = names[index - 1];
      if (previous !== undefined && compareCodePoint(previous, name) >= 0) {
        throw new CliError(
          `Config skills must be unique and sorted by code point: "${previous}" before "${name}" is invalid.`,
          EXIT_CODES.usage,
        );
      }
    }
  }
}

export function canonicalNames(names: readonly string[]): string[] {
  for (const name of names) assertSkillName(name);
  return [...new Set(names)].sort(compareCodePoint);
}
