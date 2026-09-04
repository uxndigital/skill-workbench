#!/usr/bin/env node

import { CommanderError } from 'commander';
import { buildProgram } from './cli-program.js';
import { WorkbenchError, toWorkbenchError } from './core/errors.js';

function printHelp(): void {
  console.log(`skillw

Usage:
  skillw sync [git-url] [-b|--branch <branch>] [-g|--global] [--scope project|global] [--reconcile auto|abort|local-wins|remote-wins] [--autostash]
  skillw sync --continue|--abort [-g|--global] [--scope project|global]
  skillw install <skill...> [-a|--agent <codex|cursor|claude|hermes>] [-g|--global] [--scope project|global]
  skillw uninstall <skill...> [-a|--agent <codex|cursor|claude|hermes>] [-g|--global] [--scope project|global]
  skillw status [-g|--global] [--scope project|global]
  skillw push <skill> [-m <message>] [-g|--global] [--scope project|global]
  skillw completion [zsh]

Commands:
  sync        Sync skill repository: supports auto-merge, autostash, and conflict resolution
  install     Install specified skill (create managed symlink)
  uninstall   Uninstall specified skill (remove managed symlink)
  status      Check repository changes and installation status
  push        Commit and push specified skill only
  completion  Output zsh completion script

Compatibility commands: link=install, unlink=uninstall (deprecated but retained)
Global data directory: ~/.skillw; Global install directory: ~/.agents/skills`);
}

function commanderFailure(error: CommanderError): WorkbenchError {
  if (error.code === 'commander.helpDisplayed' || error.code === 'commander.help') {
    printHelp();
    return new WorkbenchError('', 'HELPDisplayed', 0);
  }
  return new WorkbenchError(error.message, 'INVALID_ARGUMENTS', error.exitCode === 0 ? 2 : error.exitCode);
}

async function main(): Promise<void> {
  if (!process.argv[2]) {
    printHelp();
    return;
  }
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv, { from: 'node' });
  } catch (error) {
    if (error instanceof CommanderError) {
      const failure = commanderFailure(error);
      if (failure.exitCode === 0) return;
      throw failure;
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  const failure = toWorkbenchError(error);
  if (failure.exitCode === 0) return;
  console.error(`[${failure.code}] ${failure.message}`);
  process.exitCode = failure.exitCode;
});
