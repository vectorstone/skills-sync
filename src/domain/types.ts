export type ScopeKind = 'project' | 'global';

export interface ScopeSelection {
  readonly kind: ScopeKind;
  readonly root: string;
}

export interface ConfigDocument {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly target: string;
  readonly skills: readonly string[];
}

export interface ResolvedPaths {
  readonly scope: ScopeSelection;
  readonly configPath: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly rawSource: string;
  readonly rawTarget: string;
}

export type PlanStatus =
  | 'kept'
  | 'create'
  | 'update'
  | 'remove'
  | 'missingSource'
  | 'invalidLink'
  | 'blocked'
  | 'stale'
  | 'ignored'
  | 'failed'
  | 'skipped';

export type ApplyOutcome = 'succeeded' | 'failed' | 'skipped';

export interface PlanItem {
  readonly name?: string;
  readonly status: PlanStatus;
  readonly sourcePath?: string;
  readonly targetPath?: string;
  readonly reason?: string;
  readonly outcome?: ApplyOutcome;
}

export interface CommandResult {
  readonly outputVersion: 1;
  readonly command: string;
  readonly scope?: ScopeSelection;
  readonly mode: 'check' | 'plan' | 'apply' | 'config';
  readonly paths?: ResolvedPaths;
  readonly status: 'ok' | 'error' | 'cancelled';
  readonly exitCode: number;
  readonly summary: Readonly<Record<string, number>>;
  readonly items: readonly PlanItem[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}
