import { AGENTS, COMMANDS, COMPAT_COMMANDS, RECONCILE_STRATEGIES } from './cli-metadata.js';

export function generateZshCompletion(): string {
  const commandLines = [...COMMANDS, ...COMPAT_COMMANDS].map(([name, description]) => `    '${name}:${description}'`).join('\n');
  return `#compdef skillw

_skill_workbench() {
  local -a commands
  commands=(
${commandLines}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  local command=\${words[2]}
  case \$command in
    sync)
      _arguments -C \\
        '1:git URL:_message "git URL"' \\
        '(-b --branch)'{-b,--branch}'[Select branch]:branch name:_message "branch"' \\
        '--scope[Select scope]:scope:(project global)' \\
        '--project[Use current project scope]' \\
        '(-g --global)'{-g,--global}'[Use global scope]' \\
        '--reconcile[Handle local/remote divergence]:strategy:(${RECONCILE_STRATEGIES.join(' ')})' \\
        '--autostash[Auto-stash and restore working directory before/after sync]' \\
        '--yes[Confirm destructive operations]' \\
        '--clean[Also delete untracked files with remote-wins]' \\
        '--continue[Continue unfinished merge]' \\
        '--abort[Abort unfinished sync]'
      ;;
    install|link|uninstall|unlink)
      _arguments -C \\
        '*:skill name:_message "skill"' \\
        '(-a --agent)'{-a,--agent}'[Install to specified agent]:agent:(${AGENTS.join(' ')})' \\
        '--scope[Select scope]:scope:(project global)' \\
        '--project[Use current project scope]' \\
        '(-g --global)'{-g,--global}'[Use global scope]'
      ;;
    status)
      _arguments \\
        '--scope[Select scope]:scope:(project global)' \\
        '--project[Use current project scope]' \\
        '(-g --global)'{-g,--global}'[Use global scope]'
      ;;
    push)
      _arguments -C \\
        '1:skill name:_message "skill"' \\
        '(-m --message)'{-m,--message}'[commit message]:message:_message "commit message"' \\
        '--scope[Select scope]:scope:(project global)' \\
        '--project[Use current project scope]' \\
        '(-g --global)'{-g,--global}'[Use global scope]'
      ;;
    completion)
      _arguments '1:shell:(zsh)'
      ;;
    *)
      _message 'argument'
      ;;
  esac
}

_skill_workbench "$@"
`;
}
