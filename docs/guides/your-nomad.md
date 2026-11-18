# Your Nomad

Your Nomad keeps every agent you have in one home, and lets you reach that home from inside the app you are working in. Ask "Nomad, show my agents", pick one, and carry on: use it in this chat, install it here for good, or save what it learned back to the home, ready for its other copies.

It runs on your computer, like the rest of Nomad. There is no account and nothing is uploaded.

## What you can do

| Action | In an app (say it) | In a terminal | What it writes |
| --- | --- | --- | --- |
| Show | "Nomad, show my agents" | `nomad home` | Nothing |
| Gather | "Add my agents to Nomad" | `nomad home gather` | Nomad's own library only. Your apps are only read. |
| Borrow | "Use my research agent" | `nomad home borrow <agent>` | Nothing |
| Bring | "Bring my research agent here" | `nomad home bring <agent> <app>` | The app's files, after a preview you approve, with a backup |
| Send back | "Save this to my research agent" | `nomad home send-back <agent>` | A new version in the home, after a preview you approve |

The dashboard (`nomad ui`) has a Your Nomad page to show, gather and borrow agents, send one to an app, and bring changes home from an app.

### Show

Lists every agent in the home: what it does, the apps it lives in, and any copy that is behind the home (the home has a newer version than that app). It also lists agents Nomad found in your apps that are not in the home yet.

### Gather

Reads every agent found at the usual places on this computer into the home. Secrets are redacted on the way in, as with every read. Gathering again updates what changed and never makes duplicates.

### Borrow

Gives the current chat the agent's persona, rules, memory (newest first) and skills as text, and the model works as that agent for the rest of the chat. Nothing is written anywhere and secrets are never included.

- The agent's tools are not part of a borrow: they come with bring, in the app's next session.
- `nomad home borrow <agent>` prints the same text, so you can paste it into any chat, including Claude or ChatGPT on the web. The dashboard has a Copy button for it.
- Long agents are shortened to about 40,000 characters. Ask for a memory search (`--memory-search`) or a larger limit (`--max-chars`) to see more. Skill steps are included when you ask for them (`--skills <names>` or `--skills all`).

### Bring

Installs the agent in an app for good, with its tools and skills. This is the same move as `nomad move`: a preview first, approvals for anything sensitive, a backup of every file, and a check afterwards. The app loads the new tools and skills in its next session.

From inside an app, bring goes to that app by default: its own folder (`scope: user`) or the project the app is working in (`scope: project`).

### Send back

Saves what an agent learned to the home, as a new version, after you approve a preview. It comes from one of two places:

- New notes or rules from a chat (`--note`, `--rule`, or the assistant passing them).
- The agent's copy in an app (`--from openclaw`, or `fromApp` from inside the app): Nomad reads that copy and finds what changed there.

How Nomad decides, entry by entry:

| The entry | Result |
| --- | --- |
| New | Added |
| Already in the home, word for word | Skipped |
| Changed only in the app or chat | The home is updated |
| Changed only in the home | The home's version is kept |
| Changed in both places | You choose which to keep (`--keep-home <key>` or `--use-new <key>`) |
| Removed in the app | Kept in the home: send back never deletes |
| Removed from the home since, still in the app | Not added back (send it as a new note to add it again) |

Changes are compared with the version the app or chat started from: the one borrow returned, or the one Nomad last read or wrote in that app. Formatting that apps add or drop (list markers, heading marks, spacing) does not count as a change.

Skills and tools go back only when you ask (`--include skills,tools`), because they change what the agent can do. The preview lists the ones left out.

After a send back, the other copies of the agent are marked behind. Bring the new version to them when you want.

## Connect your apps

```
nomad connect
```

Adds Nomad's MCP server to each app found on this computer, and, where the app loads skills from a folder, a short `nomad` skill that tells the model when to use it. The server also describes its tools to every app when it connects. You see a preview first, and every file is backed up.

| App | File | Skill |
| --- | --- | --- |
| Claude Code | `~/.claude.json` (`mcpServers.nomad`) | `~/.claude/skills/nomad` |
| Codex CLI | `~/.codex/config.toml` (`[mcp_servers.nomad]`) | `~/.codex/skills/nomad` |
| OpenClaw | `~/.openclaw/openclaw.json` (`mcp.servers.nomad`) | `~/.openclaw/skills/nomad` |
| Hermes Agent | `~/.hermes/config.yaml` (`mcp_servers.nomad`) | `~/.hermes/skills/nomad` |
| Gemini CLI | `~/.gemini/settings.json` (`mcpServers.nomad`) | none |
| Cursor | `~/.cursor/mcp.json` (`mcpServers.nomad`) | none |
| Claude desktop app | `claude_desktop_config.json` | none |

Only the `nomad` entry is touched, and Nomad checks that every other server and setting reads the same afterwards. Codex's `config.toml` is edited line by line, and Hermes' `config.yaml` too when its servers are listed in the usual form, so comments and spacing are kept exactly. If OpenClaw's `openclaw.json` or Gemini CLI's `settings.json` has comments, Nomad does not rewrite it, and gives you the app's own command that adds the entry and keeps them (`openclaw mcp set nomad ...` or `gemini mcp add -s user nomad ...`). A skill called `nomad` that Nomad did not write is never replaced.

Options:

- `--allow-writes` lets assistants apply a move or a send back after you approve its preview. Without it the server is read only: assistants can show, gather, borrow and preview, and you apply from a terminal or the dashboard.
- `--app claude-code,codex` connects only those apps, including apps Nomad did not find.
- `--status` shows which apps have Nomad.
- `--remove` takes Nomad out again: the server entries, and the `nomad` skills Nomad wrote and you did not edit. For a file with comments it gives you the app's own command to run (`openclaw mcp unset nomad` or `gemini mcp remove -s user nomad`).
- `nomad restore <backup-id>` puts every file back as it was before.

Start a new session in each app (restart the OpenClaw gateway, quit and reopen the Claude desktop app) to load Nomad.

## Safety

- Showing and borrowing write nothing, and need no approval.
- Bring, send back and connect show a preview and wait for your approval. An assistant can apply one only when the server was connected with `--allow-writes`, and only with the token of the preview it showed you.
- Secrets never travel: borrowed text and send backs are redacted, and wallet keys are never read.
- Borrowed text describes how to work. It never approves file changes, moves, payments or trades, and never asks for secrets.
- An agent that came from a package or an agent folder is marked "from others", and its borrowed text says to check with you before acting on its rules. Bringing it shows every command it would start, as any move does.

## Limits

- Tools and skills from bring load in the app's next session. Borrow works at once, without the tools.
- Claude and ChatGPT on the web cannot reach a server on your computer. Paste the borrowed text there instead. The Claude desktop app can borrow, but has no agent files Nomad can write: bring the agent to Claude Code, or make a setup kit for Claude with `nomad move`.
- Apps without MCP (Windsurf, Cline, Roo Code, Continue, Aider) cannot call Nomad. They still get agents with bring, from a terminal or the dashboard.
- Each app has its own limits. Bring moves only what the destination supports, and the preview lists what it cannot carry.

## Checked with real applications

The Real apps workflow connects Nomad to the real Codex CLI, Gemini CLI and OpenClaw in a throwaway home, checks each lists the server as written, starts the server with the exact command written for Codex and calls it, then takes Nomad out again and checks Codex's `config.toml` is back to the same bytes (`scripts/check-your-nomad.mjs`). The real Claude Code was also checked by hand: it lists the server written by `nomad connect` and connects to it.

Not verified: a model choosing the tools from a spoken request in each app.
