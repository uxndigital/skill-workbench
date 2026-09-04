# @uxndigital/skill-workbench

A secure workbench CLI for developing, syncing, installing, and publishing local skills for AI agent systems.

[中文文档](README.zh-CN.md)

## Installation

```bash
npm install -g @uxndigital/skill-workbench
# or
pnpm add -g @uxndigital/skill-workbench
```

## Commands

```bash
# First clone; after that, omit URL to sync from config
skillw sync <git-url>
skillw sync

# Auto-merge on divergence by default
skillw sync --reconcile auto

# Explicit autostash when working directory has uncommitted changes
skillw sync --autostash

# Explicit choice of overwrite direction (destructive operations require --yes or interactive confirmation)
skillw sync --reconcile local-wins --yes
skillw sync --reconcile remote-wins --yes
skillw sync --reconcile remote-wins --clean --yes

# Continue/abort after merge conflicts
skillw sync --continue
skillw sync --abort

# Install and uninstall skills (managed symlinks)
skillw install <skill>...    # Auto-discover repository (project first), install to project
skillw install <skill>... -g # Global install (to ~/.agents/skills)
skillw uninstall <skill>...

# Force repository source (default auto-discovery: project first, fallback to global)
skillw install <skill> --repo global    # Install from global repo to project
skillw install <skill> --repo global -g # Install from global repo globally

# Use --global to specify repository scope for sync
skillw sync <git-url> --global

skillw status              # Auto-discover repository
skillw status --repo global # Force use global repository
skillw push <skill> [-m "commit message"]
```

`list` command is out of scope for this project and is handled by `apm/skills`.

## Scope and Configuration

### Repository Discovery

`install`, `uninstall`, `status`, `push` commands **auto-discover repositories** by default:
1. Check project repository first (`.skillw/skills-repo`)
2. Fall back to global repository (`~/.skillw/*`)
3. Error if neither exists, prompting to run `sync`

Override with `--repo <project|global>` to force repository source.

### Installation Target

The `-g / --global` flag controls **installation target**:
- Without `-g`: Install to project directory (`.agents/skills`)
- With `-g`: Install to global directory (`~/.agents/skills`)

**Examples**:
```bash
# Read from global repo, install to project directory
skillw install my-skill --repo global

# Read from global repo, install to global directory (equivalent to old install -g)
skillw install my-skill --repo global -g

# Auto-discover repository (project first), global install
skillw install my-skill -g
```

### sync Command Scope

The `--global` flag for `sync` controls **repository scope** (where to create/update the repository):

```bash
skillw sync <git-url>          # Project repository: .skillw/skills-repo
skillw sync <git-url> --global # Global repository: ~/.skillw/<repo-name>
```

### Default Paths

Project scope default paths:

```text
<project>/.skillw/skills-repo
<project>/.agents/skills
```

Global scope defaults:

```text
~/.skillw/skills-repo
~/.agents/skills
```

Global configuration, state, and backups are located at:

```text
~/.skillw/
├── config.json
├── state.json
├── sync-state.json
└── backups/
```

You can change the global workbench data directory via environment variable; global skill target is still resolved relative to the user's home `.agents` directory:

```bash
SKILL_WORKBENCH_HOME=/custom/path skillw sync --global
```

Project configuration file is `.skillw/config.json`:

```json
{
  "version": 1,
  "repoUrl": "git@github.com:example/skills.git",
  "repoPath": ".skillw/skills-repo",
  "targetDir": ".agents/skills"
}
```

Global configuration file defaults to `~/.skillw/config.json`, where `repoPath` is relative to `~/.skillw`, and `targetDir` is resolved relative to user home:

```json
{
  "version": 1,
  "repoPath": "skills-repo",
  "targetDir": ".agents/skills"
}
```

## Installation Targets

The first version of `install` maintains the original symlink semantics of the `link` command: the skill source directory is linked to `<skill>` under the target directory.

```bash
skillw install my-skill --agent codex
skillw install my-skill --agent claude
skillw install my-skill -a codex -a claude
```

Target directories:

- `codex` / `cursor`: `.agents/skills` or global `~/.agents/skills`
- `claude`: `.claude/skills` or global `~/.claude/skills`
- `hermes`: `.hermes/skills` or global `~/.hermes/skills`

When `--agent` is not provided, interactive terminals display a multi-select interface; the default selects generic Agent Skills. Non-interactive environments use `targetDir` from configuration.

If the target contains real files or directories, the CLI backs up first and prompts for confirmation to overwrite. `uninstall` verifies the target is still a workbench-managed symlink and restores backups when possible.

Legacy commands are still supported:

```text
link   = install (deprecated, shows warning)
unlink = uninstall (deprecated, shows warning)
```

## sync Strategy

`sync` checks Git status, fetches remote, and compares local HEAD with upstream:

- **In sync**: No additional operations
- **Remote ahead**: Fast-forward
- **Local ahead**: Keep local, no automatic push
- **Diverged**: Default auto `git merge --no-edit`
- **Working directory has uncommitted/untracked changes**: Abort by default
- **With `--autostash`**: Stash changes, sync, then restore
- **Auto-merge conflicts**: Preserve state, resolve then run `sync --continue`, or run `sync --abort`
- **Note**: `--autostash` cannot be used with `local-wins` / `remote-wins`

### Local Overwrite Remote

```bash
skillw sync --reconcile local-wins --yes
```

Creates local backup ref and uses `--force-with-lease` to push local HEAD to upstream, avoiding overwriting remote commits that appeared after fetch.

### Remote Overwrite Local

```bash
skillw sync --reconcile remote-wins --yes
```

Creates local backup ref before executing `reset --hard` to remote version. Does not delete untracked files by default. For additional cleanup:

```bash
skillw sync --reconcile remote-wins --clean --yes
```

## Safety Behaviors

- `sync` does not auto-push, reset, or delete untracked files by default
- `local-wins` uses `force-with-lease`, not unprotected force push
- `remote-wins` creates `refs/skillw/backup/...` before reset
- Destructive operations require interactive confirmation; non-interactive environments must explicitly use `--yes`
- `--autostash` uses `stash apply`; only drops after successful restoration; conflicts preserve stash
- Does not auto-commit user working directory changes
- `push` rejects unrelated staged paths and only adds specified skill
- `install/uninstall` only operate on verifiable workbench symlinks in state
- Project and global scope repositories, state, locks, and backups are isolated

## zsh Completion

The CLI includes a built-in `completion` subcommand that outputs zsh completion script:

```bash
skillw completion zsh
```

Recommended to manually integrate into your `$fpath` directory:

```bash
mkdir -p ~/.zfunc
skillw completion zsh > ~/.zfunc/_skillw
fpath=(~/.zfunc $fpath)
autoload -Uz compinit && compinit
```

To regenerate completion after upgrading the CLI, re-run the generation command. Do not execute the completion script directly with `eval`; it should be placed as `_skillw` file in `$fpath`.

Note:

```zsh
zstyle ':completion:*' cache-path "$XDG_CACHE_HOME/zsh/zcompcache"
```

This configures the completion runtime cache location, not the installation directory for completion functions. `_skillw` should be placed in a directory within `$fpath`.

Completion covers commands, scopes, sync strategies, agents, `--autostash`, `--continue`, `--abort`, and other parameters. Package installation does not automatically modify user directories or `.zshrc`.

## Development

```bash
pnpm install
pnpm build
pnpm lint
pnpm test
pnpm exec tsx src/cli.ts --help
```

If test environment has global GPG commit signing enabled, temporarily disable:

```bash
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=commit.gpgsign \
GIT_CONFIG_VALUE_0=false \
pnpm test
```

## License

MIT

