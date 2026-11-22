# dauber-claude-plugins

A personal [Claude Code](https://code.claude.com) plugin marketplace: mods and plugins I build for my own workflow, installable with one command.

## Install

Add the marketplace, then install any plugin from it:

```
claude plugin marketplace add ddauber/dauber-claude-plugins
claude plugin install subagent-monitor@dauber-claude-plugins
```

Or from inside a session: `/plugin install subagent-monitor --marketplace ddauber/dauber-claude-plugins`.

To try a plugin from a local checkout without installing it:

```
claude --plugin-dir ./plugins/subagent-monitor
```

## Plugins

| Plugin | What it does |
| --- | --- |
| [subagent-monitor](plugins/subagent-monitor) | A compact live band above the prompt showing every subagent in the session, its state and its token usage. |

## License

MIT, see [LICENSE](LICENSE).
