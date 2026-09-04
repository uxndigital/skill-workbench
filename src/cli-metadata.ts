export const COMMANDS = [
  ['sync', 'Sync skill repository with auto-merge and autostash support'],
  ['install', 'Install skill (create managed symlink)'],
  ['uninstall', 'Uninstall skill (remove managed symlink)'],
  ['status', 'Check repository changes and installation status'],
  ['push', 'Commit and push specified skill'],
  ['completion', 'Output shell completion script']
] as const;

export const COMPAT_COMMANDS = [
  ['link', 'Compatibility alias: install (deprecated)'],
  ['unlink', 'Compatibility alias: uninstall (deprecated)']
] as const;

export const AGENTS = ['codex', 'cursor', 'claude', 'hermes'] as const;
export const SCOPES = ['project', 'global'] as const;
export const RECONCILE_STRATEGIES = ['auto', 'abort', 'local-wins', 'remote-wins'] as const;

export type ScopeName = (typeof SCOPES)[number];
export type ReconcileStrategyName = (typeof RECONCILE_STRATEGIES)[number];
