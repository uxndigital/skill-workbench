import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, repoPathFromConfig, saveConfig, targetDirsForAgents, type AgentTarget, type WorkbenchConfig } from './core/config.js';
import { WorkbenchError } from './core/errors.js';
import { git, gitOutput, stagedPaths, statusEntries, tryGit } from './core/git.js';
import { linkSkill, inspectLinks, unlinkSkill } from './core/link-manager.js';
import { withOperationLock } from './core/lock.js';
import { pathBelongsToSkill, discoverSkillSources, resolveSkill, type SkillSource } from './core/skill-resolver.js';
import { loadState } from './core/state.js';
import { checkbox } from './core/checkbox.js';
import type { LinkRecord } from './core/state.js';
import { createInterface } from 'node:readline/promises';
import { displayPath, USER_HOME, type Scope } from './core/paths.js';
import { syncCommand, syncContinueCommand, syncAbortCommand } from './sync/orchestrator.js';
import type { ReconcileStrategy } from './sync/snapshot-planner.js';

export type RepoSource = 'project' | 'global' | 'auto';

function displayRepo(repoPath: string, scope: Scope): string { return displayPath(repoPath, scope); }
function uniqueValues(values: string[]): string[] { return [...new Set(values)]; }
function recordedTargetPaths(record: LinkRecord): string[] { return record.targets?.map((target) => target.target) ?? [record.target]; }

async function discoverRepo(repoSource: RepoSource): Promise<{ config: WorkbenchConfig; repoPath: string }> {
  if (repoSource === 'project') {
    const config = await loadConfig('project');
    const repoPath = await requireRepo(config);
    return { config, repoPath };
  }

  if (repoSource === 'global') {
    const config = await loadConfig('global');
    const repoPath = await requireRepo(config);
    return { config, repoPath };
  }

  // auto: project first, fallback to global
  const projectConfig = await loadConfig('project');
  const projectRepoPath = repoPathFromConfig(projectConfig);

  try {
    const info = await lstat(projectRepoPath);
    if (info.isDirectory() && await tryGit(projectRepoPath, ['rev-parse', '--show-toplevel'])) {
      return { config: projectConfig, repoPath: projectRepoPath };
    }
  } catch {}

  // Project repository doesn't exist, try global
  const globalConfig = await loadConfig('global');
  const globalRepoPath = repoPathFromConfig(globalConfig);

  try {
    const info = await lstat(globalRepoPath);
    if (info.isDirectory() && await tryGit(globalRepoPath, ['rev-parse', '--show-toplevel'])) {
      return { config: globalConfig, repoPath: globalRepoPath };
    }
  } catch {}

  throw new WorkbenchError(
    `Skill repository not found.\n` +
    `  Project repository: ${displayRepo(projectRepoPath, 'project')}\n` +
    `  Global repository: ${displayRepo(globalRepoPath, 'global')}\n` +
    `Please run sync to create repository.`,
    'REPO_NOT_FOUND',
    1
  );
}

async function requireRepo(config: WorkbenchConfig): Promise<string> {
  const repoPath = repoPathFromConfig(config);
  try {
    const info = await lstat(repoPath);
    if (!info.isDirectory()) throw new Error('not-directory');
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(`Skill repository does not exist: ${displayRepo(repoPath, config.scope)}. Please run sync first.`, 'REPO_NOT_FOUND', 1);
  }
  if (!(await tryGit(repoPath, ['rev-parse', '--show-toplevel']))) throw new WorkbenchError(`Not a Git repository: ${displayRepo(repoPath, config.scope)}`, 'NOT_GIT_REPO', 1);
  return repoPath;
}

async function askCommitMessage(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new WorkbenchError('Non-interactive environment must use --message to provide commit message.', 'MISSING_COMMIT_MESSAGE', 2);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const message = (await readline.question('Commit message: ')).trim();
    if (!message || message.includes('\n') || message.includes('\r')) throw new WorkbenchError('Commit message cannot be empty and must be single-line.', 'INVALID_COMMIT_MESSAGE', 2);
    return message;
  } finally { readline.close(); }
}

async function confirm(question: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new WorkbenchError('Non-interactive environment must use --yes for destructive sync.', 'CONFIRMATION_REQUIRED', 2);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${question} [y/N] `)).trim().toLowerCase();
    if (!['y', 'yes'].includes(answer)) throw new WorkbenchError('Destructive sync cancelled.', 'OPERATION_CANCELLED', 1);
  } finally { readline.close(); }
}

function displayStatusEntry(entry: { index: string; worktree: string; path: string }): string { return `${entry.index}${entry.worktree} ${entry.path}`; }
function displaySkillSource(source: SkillSource): string { return `${source.name} (${source.relativePath.split(path.sep).join('/')})`; }
const linkTargetChoices = (globalInstall: boolean) => globalInstall
  ? [{ value: path.join(USER_HOME, '.agents/skills'), label: 'Generic Agent Skills (~/.agents/skills) — Codex, Cursor', checked: true }, { value: path.join(USER_HOME, '.claude/skills'), label: 'Claude Code (~/.claude/skills)' }, { value: path.join(USER_HOME, '.hermes/skills'), label: 'Hermes (~/.hermes/skills)' }] as const
  : [{ value: '.agents/skills', label: 'Generic Agent Skills (.agents/skills) — Codex, Cursor', checked: true }, { value: '.claude/skills', label: 'Claude Code (.claude/skills)' }, { value: '.hermes/skills', label: 'Hermes (.hermes/skills)' }] as const;
async function chooseLinkTargets(globalInstall: boolean): Promise<string[]> { return checkbox('Select installation targets (Generic Agent Skills selected by default):', [...linkTargetChoices(globalInstall)]); }
async function resolveLinkTargets(agents: string[] | undefined, globalInstall: boolean): Promise<AgentTarget[]> {
  const scope: Scope = globalInstall ? 'global' : 'project';
  const baseConfig = await loadConfig(scope);
  if (agents && agents.length > 0) return targetDirsForAgents(uniqueValues(['codex', ...agents]), baseConfig);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return [{ targetDir: baseConfig.targetDir, agents: [] }];
  return (await chooseLinkTargets(globalInstall)).map((targetDir) => ({ targetDir, agents: [] }));
}

export async function installCommand(skills: string[], agents?: string[], repoSource: RepoSource = 'auto', globalInstall: boolean = false): Promise<void> {
  await withOperationLock(async () => {
    const { config: repoConfig, repoPath } = await discoverRepo(repoSource);

    // Resolve skills, if auto mode and not found, try alternative repository
    const sources: SkillSource[] = [];
    for (const skill of skills) {
      try {
        sources.push(await resolveSkill(repoPath, skill));
      } catch (err) {
        if (repoSource === 'auto' && err instanceof WorkbenchError && err.code === 'SKILL_NOT_FOUND') {
          // Try alternative repository
          const altScope: Scope = repoConfig.scope === 'project' ? 'global' : 'project';
          const altConfig = await loadConfig(altScope);
          const altRepoPath = repoPathFromConfig(altConfig);

          try {
            const info = await lstat(altRepoPath);
            if (info.isDirectory() && await tryGit(altRepoPath, ['rev-parse', '--show-toplevel'])) {
              sources.push(await resolveSkill(altRepoPath, skill));
              continue;
            }
          } catch {}
        }
        throw err;
      }
    }

    const targetScope: Scope = globalInstall ? 'global' : 'project';
    const targetConfig = await loadConfig(targetScope);
    for (const target of await resolveLinkTargets(agents, globalInstall)) {
      const finalConfig = { ...targetConfig, targetDir: target.targetDir };
      for (const source of sources) await linkSkill(finalConfig, source);
    }
  }, globalInstall ? 'global' : 'project');
}

async function chooseUninstallTargets(skills: string[], globalInstall: boolean): Promise<AgentTarget[]> {
  const scope: Scope = globalInstall ? 'global' : 'project';
  const state = await loadState(scope);
  const activeTargetDirs = new Set<string>();
  for (const skill of skills) for (const target of state.links[skill] ? recordedTargetPaths(state.links[skill]!) : []) activeTargetDirs.add(path.dirname(target));
  const baseConfig = await loadConfig(scope);
  if (activeTargetDirs.size === 0) return [{ targetDir: baseConfig.targetDir, agents: [] }];
  if (!process.stdin.isTTY || !process.stdout.isTTY) return [...activeTargetDirs].map((targetDir) => ({ targetDir, agents: [] }));
  const choices = [...activeTargetDirs].sort().map((targetDir) => ({ value: targetDir, label: targetDir, checked: true }));
  return (await checkbox('Select uninstall targets (all selected by default):', choices)).map((targetDir) => ({ targetDir, agents: [] }));
}

export async function uninstallCommand(skills: string[], agents?: string[], repoSource: RepoSource = 'auto', globalInstall: boolean = false): Promise<void> {
  await withOperationLock(async () => {
    const { config: repoConfig, repoPath } = await discoverRepo(repoSource);
    const targetScope: Scope = globalInstall ? 'global' : 'project';
    const targetConfig = await loadConfig(targetScope);
    const targets = agents && agents.length > 0 ? targetDirsForAgents(uniqueValues(agents), targetConfig) : await chooseUninstallTargets(skills, globalInstall);
    for (const target of targets) {
      const finalConfig = { ...targetConfig, targetDir: target.targetDir };
      for (const skill of skills) await unlinkSkill(finalConfig, skill);
    }
  }, globalInstall ? 'global' : 'project');
}

export const linkCommand = installCommand;
export const unlinkCommand = uninstallCommand;

export async function statusCommand(repoSource: RepoSource = 'auto'): Promise<number> {
  const { config, repoPath } = await discoverRepo(repoSource);
  const entries = await statusEntries(repoPath);
  const branch = await tryGit(repoPath, ['branch', '--show-current']);
  const upstream = await tryGit(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const state = await loadState(config.scope);
  const sources = await discoverSkillSources(repoPath);
  const changedSkills = new Map<string, string[]>(); const repositoryChanges: string[] = [];
  for (const entry of entries) {
    const skill = sources.find((source) => pathBelongsToSkill(entry.path, source.relativePath));
    if (skill) { const list = changedSkills.get(skill.name) ?? []; list.push(displayStatusEntry(entry)); changedSkills.set(skill.name, list); } else repositoryChanges.push(displayStatusEntry(entry));
  }
  const links = await inspectLinks(config, state);
  console.log(`Skill repository: ${displayRepo(repoPath, config.scope)}`);
  console.log(`Branch: ${branch?.stdout.trim() || '(detached)'}`);
  console.log(`Upstream: ${upstream?.stdout.trim() || '(none)'}`);
  console.log(`Working tree: ${entries.length ? 'DIRTY' : 'CLEAN'}\n`);
  console.log('Changed skills:'); if (changedSkills.size === 0) console.log('  (none)'); for (const [skill, files] of changedSkills) { console.log(`  ${skill}`); for (const file of files) console.log(`    ${file}`); }
  console.log('\nRepository-level changes:'); if (repositoryChanges.length === 0) console.log('  (none)'); for (const file of repositoryChanges) console.log(`  ${file}`);
  const linkedSkills = new Set(links.filter((link) => link.status === 'OK').map((link) => link.skill));
  console.log('\nAvailable to link:'); const availableSources = sources.filter((source) => !linkedSkills.has(source.name)).sort((a, b) => a.name.localeCompare(b.name) || a.relativePath.localeCompare(b.relativePath));
  if (availableSources.length === 0) console.log('  (none)'); for (const source of availableSources) console.log(`  ${displaySkillSource(source)}`);
  console.log('\nLinks:'); if (links.length === 0) console.log('  (none)'); for (const link of links) console.log(`  ${link.skill}: ${link.status} (${link.target}${link.detail ? ` -> ${link.detail}` : ''})`);
  return entries.length || links.some((link) => link.status !== 'OK') ? 1 : 0;
}

export async function pushCommand(skill: string, message?: string, repoSource: RepoSource = 'auto'): Promise<void> {
  await withOperationLock(async () => {
    const { config, repoPath } = await discoverRepo(repoSource);
    const source = await resolveSkill(repoPath, skill);
    const upstream = await tryGit(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    if (!upstream || !upstream.stdout.trim()) throw new WorkbenchError('Current branch has no upstream, refusing to commit and push.', 'NO_UPSTREAM', 1);
    const root = path.resolve(await gitOutput(repoPath, ['rev-parse', '--show-toplevel'])); const sourceRelative = path.relative(root, source.path);
    if (!sourceRelative || sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)) throw new WorkbenchError('Skill source directory is not inside Git repository.', 'PATH_ESCAPE', 2);
    const stagedBefore = await stagedPaths(repoPath);
    if (stagedBefore.some((file) => !pathBelongsToSkill(file, sourceRelative))) throw new WorkbenchError('Staging area already has changes outside the specified skill, refusing to commit unrelated content.', 'UNRELATED_STAGED_CHANGES', 1);
    await git(repoPath, ['add', '--', sourceRelative]); const stagedAfter = await stagedPaths(repoPath);
    if (stagedAfter.length === 0) throw new WorkbenchError(`Skill has no changes to commit: ${skill}`, 'NO_CHANGES', 1);
    if (stagedAfter.some((file) => !pathBelongsToSkill(file, sourceRelative))) throw new WorkbenchError('After staging, found changes outside the specified skill, refusing to commit.', 'UNRELATED_STAGED_CHANGES', 1);
    console.log('About to commit:'); for (const file of stagedAfter) console.log(`  ${file}`);
    const commitMessage = message?.trim() || await askCommitMessage();
    if (!commitMessage || commitMessage.includes('\n') || commitMessage.includes('\r')) throw new WorkbenchError('Commit message cannot be empty and must be single-line.', 'INVALID_COMMIT_MESSAGE', 2);
    await git(repoPath, ['commit', '-m', commitMessage]); const commit = await gitOutput(repoPath, ['rev-parse', 'HEAD']);
    try { await git(repoPath, ['push']); console.log(`Committed and pushed ${skill}: ${commit.slice(0, 12)}`); }
    catch (error) { throw new WorkbenchError(`Local commit created ${commit.slice(0, 12)}, but push failed: ${error instanceof WorkbenchError ? error.message : String(error)}`, 'PUSH_FAILED_AFTER_COMMIT', 3); }
  }, 'project');
}

export async function completionCommand(shell?: string): Promise<void> {
  if (shell !== undefined && shell !== 'zsh') throw new WorkbenchError('Completion currently only supports zsh.', 'INVALID_ARGUMENTS', 2);
  const { generateZshCompletion } = await import('./completion.js');
  process.stdout.write(generateZshCompletion());
}
