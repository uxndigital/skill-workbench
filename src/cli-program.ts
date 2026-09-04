import { Command, Option } from 'commander';
import { WorkbenchError } from './core/errors.js';
import { AGENTS, COMMANDS, COMPAT_COMMANDS, RECONCILE_STRATEGIES, SCOPES, type ScopeName } from './cli-metadata.js';
import {
  completionCommand,
  installCommand,
  pushCommand,
  statusCommand,
  uninstallCommand,
  type RepoSource
} from './commands.js';
import { syncAbortCommand, syncCommand, syncContinueCommand } from './sync/orchestrator.js';
import type { ReconcileStrategy } from './sync/snapshot-planner.js';
import type { Command as CommanderCommand } from 'commander';

export interface ParsedScopeOptions {
  global?: boolean;
  project?: boolean;
  scope?: ScopeName;
}

export interface ParsedRepoOptions {
  repo?: 'project' | 'global';
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function addScopeOptions(command: Command): Command {
  return command
    .addOption(new Option('-g, --global', 'Use global scope'))
    .addOption(new Option('--project', 'Use current project scope'))
    .addOption(new Option('--scope <scope>', 'Select scope').choices([...SCOPES]));
}

export function resolveScope(options: ParsedScopeOptions): ScopeName | undefined {
  const hasScopeFlag = options.global === true || options.project === true;
  const hasExplicitScope = options.scope !== undefined;
  if (options.global === true && options.project === true) {
    throw new WorkbenchError('--global and --project cannot be used together.', 'INVALID_SCOPE', 2);
  }
  if (hasScopeFlag && hasExplicitScope) {
    throw new WorkbenchError('--global/--project cannot be used with --scope.', 'INVALID_SCOPE', 2);
  }
  return options.global ? 'global' : options.project ? 'project' : options.scope;
}

function optionsFor(command: CommanderCommand): Record<string, unknown> {
  return command.opts<Record<string, unknown>>();
}

function addSyncOptions(command: Command): Command {
  return addScopeOptions(command)
    .option('-b, --branch <branch>', 'Select branch')
    .addOption(new Option('--reconcile <strategy>', 'Handle local/remote divergence').choices([...RECONCILE_STRATEGIES]))
    .option('--autostash', 'Auto-stash and restore working directory before/after sync')
    .option('--yes', 'Confirm destructive operations')
    .option('--clean', 'Also delete untracked files with remote-wins')
    .option('--continue', 'Continue unfinished merge')
    .option('--abort', 'Abort unfinished sync');
}

function addInstallOptions(command: Command): Command {
  return command
    .addOption(new Option('-g, --global', 'Global install (to ~/.agents/skills etc.)'))
    .addOption(new Option('--repo <source>', 'Specify repository source').choices(['project', 'global']))
    .addOption(new Option('-a, --agent <agent>', 'Install to specified agent').choices([...AGENTS]).argParser(collect).default([]))
    .addHelpText('after', `\nSupported agents: ${AGENTS.join(', ')}\nDefault: auto-discover repository (project first), install to project directory\nUse -g for global install, --repo to force repository source\n`);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('skillw')
    .description('Secure workbench for syncing, installing, inspecting, and publishing local skills')
    .showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined
    });

  const sync = addSyncOptions(program.command('sync').description(COMMANDS[0][1]).argument('[git-url]', 'Git repository URL'));
  sync.action(async (gitUrl: string | undefined, _options: unknown, command: CommanderCommand) => {
    const options = optionsFor(command);
    const scope = resolveScope(options as ParsedScopeOptions);
    const continueSync = options.continue === true;
    const abortSync = options.abort === true;
    if (continueSync && abortSync) throw new WorkbenchError('--continue and --abort cannot be used together.', 'INVALID_ARGUMENTS', 2);
    if (continueSync || abortSync) {
      if (gitUrl || options.branch || options.reconcile || options.autostash || options.yes || options.clean) {
        throw new WorkbenchError('sync --continue/--abort does not accept other sync options.', 'INVALID_ARGUMENTS', 2);
      }
      if (continueSync) await syncContinueCommand(scope);
      else await syncAbortCommand(scope);
      return;
    }
    await syncCommand(gitUrl, options.branch as string | undefined, {
      scope,
      reconcile: options.reconcile as ReconcileStrategy | undefined,
      autostash: options.autostash as boolean | undefined,
      yes: options.yes as boolean | undefined,
      clean: options.clean as boolean | undefined
    });
  });

  const install = addInstallOptions(program.command('install').description(COMMANDS[1][1]).argument('<skill...>', 'Skill name(s)'));
  install.action(async (skills: string[], _options: unknown, command: CommanderCommand) => {
    const options = optionsFor(command);
    const repoSource: RepoSource = options.repo ? (options.repo as 'project' | 'global') : 'auto';
    const globalInstall = options.global === true;
    await installCommand(skills, options.agent as string[] | undefined, repoSource, globalInstall);
  });

  const uninstall = addInstallOptions(program.command('uninstall').description(COMMANDS[2][1]).argument('<skill...>', 'Skill name(s)'));
  uninstall.action(async (skills: string[], _options: unknown, command: CommanderCommand) => {
    const options = optionsFor(command);
    const repoSource: RepoSource = options.repo ? (options.repo as 'project' | 'global') : 'auto';
    const globalInstall = options.global === true;
    await uninstallCommand(skills, options.agent as string[] | undefined, repoSource, globalInstall);
  });

  const status = program.command('status').description(COMMANDS[3][1])
    .addOption(new Option('--repo <source>', 'Specify repository source').choices(['project', 'global']));
  status.action(async (_options: unknown, command: CommanderCommand) => {
    const options = optionsFor(command);
    const repoSource: RepoSource = options.repo ? (options.repo as 'project' | 'global') : 'auto';
    process.exitCode = await statusCommand(repoSource);
  });

  const push = program.command('push').description(COMMANDS[4][1]).argument('<skill>', 'Skill name')
    .option('-m, --message <message>', 'Commit message')
    .addOption(new Option('--repo <source>', 'Specify repository source').choices(['project', 'global']));
  push.action(async (skill: string, _options: unknown, command: CommanderCommand) => {
    const options = optionsFor(command);
    const repoSource: RepoSource = options.repo ? (options.repo as 'project' | 'global') : 'auto';
    await pushCommand(skill, options.message as string | undefined, repoSource);
  });

  const completion = program.command('completion').description(COMMANDS[5][1]).argument('[shell]', 'Shell type');
  completion.action(async (shell: string | undefined) => {
    await completionCommand(shell);
  });

  for (const [name, description] of COMPAT_COMMANDS) {
    const target = name === 'link' ? install : uninstall;
    const compatible = addInstallOptions(program.command(name).description(description).argument('<skill...>', 'Skill name(s)'));
    compatible.action(async (skills: string[], _options: unknown, command: CommanderCommand) => {
      console.error(`Warning: ${name} is deprecated, please use ${target.name()}.`);
      const options = optionsFor(command);
      const repoSource: RepoSource = options.repo ? (options.repo as 'project' | 'global') : 'auto';
      const globalInstall = options.global === true;
      if (name === 'link') await installCommand(skills, options.agent as string[] | undefined, repoSource, globalInstall);
      else await uninstallCommand(skills, options.agent as string[] | undefined, repoSource, globalInstall);
    });
  }

  return program;
}
