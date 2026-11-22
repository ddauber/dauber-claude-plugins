# subagent-monitor

A compact live band above the Claude Code prompt that lists every subagent in the current session, its state, and its token usage. It is hidden while the session has no subagents.

```
● code-reviewer  opus  loop                            18.4k · 1:12
● test-writer  sonnet  3/5  ⚠ conflict: app.ts          9.1k · 0:48
◉ docs-checker  haiku  idle 42s                         6.2k · 1:30
○ explorer  haiku                                       4.0k · 0:20
+2 more · 1 running · 1 idle
✓ 6 done · 142k                                           64.7k tok
```

## What it shows

Each line reads `[status] name  model  [tags]          tokens · time`.

- **name** is the subagent type, and **model** is a short tag (opus, sonnet, haiku, fable).
- **tokens · time**: cumulative tokens (see below) and elapsed time as m:ss, right-aligned.
- **Session total** (`64.7k tok`): the sum over every subagent seen this session, at the right end of the last line.

### Status

| Dot | Meaning |
| --- | --- |
| green `●` `◉` `○` `◉`, pulsing | Running. The frame steps about every 450 ms. |
| amber, slower pulse + `idle Ns` | Stalled: no tool call or model step from that agent for 30 s or more. |
| red + `loop` | Looping: the same tool with the same input three or more times in a row. |
| `✓` green, muted line | Finished. |
| `✗` red, muted line | Failed or cancelled. |

### Tags (shown only when there's something to say)

- `3/5`: done/total, but only when the agent keeps its own todo or task list (TodoWrite, TaskCreate/TaskUpdate). There is no percentage, because subagents don't know how far along they are.
- `ctx 85%` (amber): the agent's context window is more than 80% full.
- `⚠ conflict: app.ts` (red): two running agents have both written this file. Reads don't count.

### Sorting and limits

- **Sort order:** red warnings first, then amber warnings, then running agents, then finished ones.
- **Row limit:** at most 4 agent rows, followed by a summary like `+5 more · 3 running · 1 idle`.
- **Folding:** finished agents fold into one line about 5 seconds after they finish, e.g. `✓ 6 done · 142k`.
- **Narrow terminals:** long names are cut with an ellipsis instead of wrapping.

## Expanded mode

Expanded mode lists every agent, with no row limit and no folding. Under each agent it adds a line with the description the agent was spawned with, its context fill and the files it has written:

```
● general-purpose  opus                               47.7k · 0:40
    long task · ctx 4% · wrote essay.md, improvements.md
                                                         143k tok
```

**To toggle compact and expanded:**

- **Keyboard:** press **ctrl+x**, then **tab** to focus the band, then **e**. Esc returns to the prompt.
- **Mouse:** click any line of the band, in the terminal or in the Desktop Code tab.
- **Fallback:** after ctrl+x tab, use Tab to reach a line of the band and press **Enter**.

The `e` hotkey only works while the band has focus, because mods can't register global shortcuts. If another plugin ever puts `e` on its own band row, Claude Code presses neither, so use the click or Enter instead.

## What the token figure counts

**New input + cache-creation input + output tokens, summed over every model request the agent made.** Cache reads are left out. Every turn re-sends the whole context, so cache reads grow with each step and would swamp the figure. Leaving them out keeps the number close to the work the agent actually did.

Because of this, the figures are much lower than the "↓ N tokens" counter in Claude Code's own task list, which counts the agent's latest context plus output. No cost in currency is shown.

The figures come from Claude Code's own per-agent usage (`$.agent.list()`). Context fill is the agent's latest request (input, cache reads, cache writes and output) divided by its model's context window size.

## Read-only

**The mod only reads events and draws.** Every hook passes its event on unchanged with `next(e)`. Nothing is denied, rewritten, delayed or blocked: no tool call, model step, prompt or anything else Claude Code does. The only state it writes is its own: the band's snapshot and the expanded/compact toggle.

## Known limits

- **Stall false positives:** the stall warning counts tool calls and model steps. A single tool call that runs longer than 30 s, such as a long build, also shows as `idle`.
- **Progress tags are rare:** in current Claude Code builds, subagents usually have no todo or task tools, so `done/total` mostly stays hidden.
- **Short terminals:** the band's height limit is shared with other mods' band rows. In a short terminal with several mods, Claude Code scrolls the band.
- **Hot reloads:** reloading the mod while developing resets its own counters, so stall timers and folding start over.
- **Desktop alignment:** right alignment is done with spaces, so it lines up exactly only in monospace terminals.

## Install

```
claude plugin marketplace add ddauber/dauber-claude-plugins
claude plugin install subagent-monitor@dauber-claude-plugins
```

## Develop

```
claude --plugin-dir ./plugins/subagent-monitor   # session with the mod, hot-reloads on save
claude plugin validate ./plugins/subagent-monitor
claude plugin test ./plugins/subagent-monitor
```

MIT licensed.
