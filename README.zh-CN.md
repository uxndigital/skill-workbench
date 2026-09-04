# uxndigital-skillw

用于开发、同步、安装和发布本地 skill 的安全工作台 CLI。

## 命令

```bash
# 首次 clone；之后省略地址即可按配置同步
skillw sync <git-url>
skillw sync

# 发生本地/远端分叉时默认自动 merge
skillw sync --reconcile auto

# 工作区有未提交改动时，显式使用 autostash
skillw sync --autostash

# 明确选择覆盖方向（破坏性操作需要 --yes 或交互确认）
skillw sync --reconcile local-wins --yes
skillw sync --reconcile remote-wins --yes
skillw sync --reconcile remote-wins --clean --yes

# merge 冲突后的继续/中止
skillw sync --continue
skillw sync --abort

# 安装和卸载 skill（默认创建/移除受管理的软链接）
skillw install <skill>...    # 自动发现仓库（项目优先），安装到项目目录
skillw install <skill>... -g # 全局安装（安装到 ~/.agents/skills）
skillw uninstall <skill>...

# 强制指定仓库来源（默认自动发现：项目优先，找不到用全局）
skillw install <skill> --repo global    # 从全局仓库安装到项目
skillw install <skill> --repo global -g # 从全局仓库全局安装

# sync 命令使用 --global 指定仓库作用域
skillw sync <git-url> --global

skillw status              # 自动发现仓库
skillw status --repo global # 强制使用全局仓库
skillw push <skill> [-m "commit message"]
```

`list` 不在本项目范围内，由 `apm/skills` 负责。

## 作用域和配置

### 仓库发现机制

`install`、`uninstall`、`status`、`push` 命令默认**自动发现仓库**：
1. 优先查找项目仓库（`.skillw/skills-repo`）
2. 找不到则查找全局仓库（`~/.skillw/*`）
3. 两个都没有则报错提示运行 `sync`

可以通过 `--repo <project|global>` 强制指定仓库来源。

### 安装目标

`-g / --global` 参数控制**安装目标**：
- 不加 `-g`：安装到项目目录（`.agents/skills`）
- 加 `-g`：安装到全局目录（`~/.agents/skills`）

**示例**：
```bash
# 从全局仓库读取，安装到项目目录
skillw install my-skill --repo global

# 从全局仓库读取，安装到全局目录（等同于旧版的 install -g）
skillw install my-skill --repo global -g

# 自动发现仓库（项目优先），全局安装
skillw install my-skill -g
```

### sync 命令的作用域

`sync` 命令的 `--global` 控制**仓库作用域**（在哪里创建/更新仓库）：

```bash
skillw sync <git-url>          # 项目仓库：.skillw/skills-repo
skillw sync <git-url> --global # 全局仓库：~/.skillw/<repo-name>
```

### 默认路径

项目作用域默认路径：

```text
<project>/.skillw/skills-repo
<project>/.agents/skills
```

全局作用域默认使用：

```text
~/.skillw/skills-repo
~/.agents/skills
```

全局配置、状态和备份位于：

```text
~/.skillw/
├── config.json
├── state.json
├── sync-state.json
└── backups/
```

可以通过环境变量改变全局 workbench 数据目录；全局技能目标仍按用户 Home 下的 Agent 目录解析：

```bash
SKILL_WORKBENCH_HOME=/custom/path skillw sync --global
```

项目配置文件为 `.skillw/config.json`：

```json
{
  "version": 1,
  "repoUrl": "git@github.com:example/skills.git",
  "repoPath": ".skillw/skills-repo",
  "targetDir": ".agents/skills"
}
```

全局配置文件默认为 `~/.skillw/config.json`，其中 `repoPath` 相对于 `~/.skillw`，`targetDir` 相对于用户 Home 解析，例如：

```json
{
  "version": 1,
  "repoPath": "skills-repo",
  "targetDir": ".agents/skills"
}
```

## 安装目标

`install` 第一版保持原有 `link` 的软链接语义：skill 源目录会被链接到目标目录下的 `<skill>`。

```bash
skillw install my-skill --agent codex
skillw install my-skill --agent claude
skillw install my-skill -a codex -a claude
```

目标目录：

- `codex` / `cursor`：`.agents/skills` 或全局的 `~/.agents/skills`
- `claude`：`.claude/skills` 或全局的 `~/.claude/skills`
- `hermes`：`.hermes/skills` 或全局的 `~/.hermes/skills`

不传 `--agent` 时，交互终端会显示多选界面；默认选中通用 Agent Skills。非交互环境使用配置中的 `targetDir`。

如果目标存在真实文件或目录，CLI 会先备份，再交互确认覆盖。`uninstall` 会验证目标仍然是 workbench 管理的软链接，并在可能时恢复备份。

当前版本仍兼容旧命令：

```text
link   = install（已废弃，执行时显示警告）
unlink = uninstall（已废弃，执行时显示警告）
```

## sync 策略

`sync` 会先检查 Git 状态、fetch 远端，再比较本地 HEAD 与 upstream：

- 一致：不做额外操作；
- 远端领先：fast-forward；
- 本地领先：保留本地，不自动 push；
- 本地和远端分叉：默认自动 `git merge --no-edit`；
- 工作区有未提交或未跟踪改动：默认中止；
- 使用 `--autostash` 时，会先暂存改动，同步成功后恢复；
- 自动 merge 冲突会保留现场，解决后执行 `sync --continue`，或执行 `sync --abort`；
- `--autostash` 不能与 `local-wins` / `remote-wins` 同时使用。

### 本地覆盖远端

```bash
skillw sync --reconcile local-wins --yes
```

会创建本地备份 ref，并用 `--force-with-lease` 将本地 HEAD 推送到 upstream，避免覆盖 fetch 之后刚刚出现的远端新提交。

### 远端覆盖本地

```bash
skillw sync --reconcile remote-wins --yes
```

会先创建本地备份 ref，再执行 `reset --hard` 到远端版本。默认不删除未跟踪文件；需要额外清理时使用：

```bash
skillw sync --reconcile remote-wins --clean --yes
```

## 安全行为

- `sync` 默认不自动 push、reset 或删除未跟踪文件；
- `local-wins` 使用 `force-with-lease`，不使用无保护的 force push；
- `remote-wins` 在 reset 前创建 `refs/skillw/backup/...`；
- 破坏性操作需要交互确认，非交互环境必须显式使用 `--yes`；
- `--autostash` 使用 `stash apply`，成功恢复后才 drop，恢复冲突时保留 stash；
- 不会自动提交用户工作区改动；
- `push` 会拒绝暂存区中的无关路径，并只 add 指定 skill；
- `install/uninstall` 只操作 state 中可验证的 workbench 软链接；
- 项目和全局作用域的仓库、state、锁和备份相互隔离。

## zsh 补全

CLI 内置 `completion` 子命令，运行时输出 zsh 补全脚本：

```bash
skillw completion zsh
```

推荐手动接入到用户自己的 `$fpath` 目录：

```bash
mkdir -p ~/.zfunc
skillw completion zsh > ~/.zfunc/_skillw
fpath=(~/.zfunc $fpath)
autoload -Uz compinit && compinit
```

如果希望升级 CLI 后重新生成补全文件，重新执行上面的生成命令即可。不要把补全脚本直接用 `eval` 执行；它应该作为 `_skillw` 文件放在 `$fpath` 中。

需要注意：

```zsh
zstyle ':completion:*' cache-path "$XDG_CACHE_HOME/zsh/zcompcache"
```

配置的是 completion 运行时缓存位置，不是补全函数的安装目录。`_skillw` 应该放在 `$fpath` 中的目录内。

补全覆盖命令、作用域、同步策略、Agent、`--autostash`、`--continue` 和 `--abort` 等参数。包安装不会自动修改用户目录或 `.zshrc`。

## 开发

```bash
pnpm install
pnpm build
pnpm lint
pnpm test
pnpm exec tsx src/cli.ts --help
```

测试环境如果启用了全局 GPG commit signing，可临时关闭：

```bash
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=commit.gpgsign \
GIT_CONFIG_VALUE_0=false \
pnpm test
```
