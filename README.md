# Claude Link

Claude Link connects your team's Claude Code sessions over the office network. With it, you can:

- **See team progress.** The lead's dashboard shows each person's status, git branch, uncommitted files and recent commits.
- **Ask another person's Claude.** "Ask the backend Claude what `/orders` returns." The request runs in their repo with read-only access, and the answer comes back to you.
- **Request a fix in someone else's repo.** Their Claude makes the change on a new git branch, but only after the owner approves it.
- **Chat.** There is a `#team` channel and direct messages, and every Claude-to-Claude conversation is saved.

The lead uses the full web dashboard (Status, Chat, Tasks, Members, Audit). Everyone else uses the chat view.

```
 Lead's laptop: claude-link hub  ◄──── WebSocket + REST ────►  claude-link agent (each teammate)
   SQLite · API · web dashboard                                  ├ MCP server → their Claude Code
                                                                 └ runs `claude -p` in their repo
```

## Requirements
- Node.js 23.6 or newer. It runs the TypeScript directly, so there is no build step except for the web UI.
- Claude Code, installed and logged in on every machine.
- Every machine on the same network as the hub.

## Setup

### 1. Team lead: start the hub
```bash
git clone <this repo> claude-link && cd claude-link
npm install && npm run build      # build the web dashboard
cd packages/cli && npm link && cd ../..   # puts `claude-link` on your PATH
claude-link hub --name "Your Name"
```
The hub prints a **Network URL** (for example `http://192.168.1.77:4545`) and your **lead token**. The token is shown only once. If you lose it, restart with `--rotate-lead-token`.
The first time it runs, macOS asks whether Node may accept incoming connections. Click **Allow**.

Open the URL, sign in with the lead token, and add teammates under **Members → Add member**. Each new member gets their own token and a join command to copy.

Connect your own Claude Code as well:
```bash
claude-link join http://127.0.0.1:4545 --token <lead-token> --repo ~/work/project
claude-link agent
```

### 2. Each teammate
```bash
# same install steps (clone, npm install, cd packages/cli && npm link), then:
claude-link join http://<lead-ip>:4545 --token <their-token> --repo ~/work/project [--hooks]
claude-link agent          # keep this running while you work
```
`join` checks the token, saves `~/.claude-link/config.json`, and registers the `claude-link` MCP server with Claude Code at user scope. The optional `--hooks` flag also adds a Claude Code hook that reports each commit to the lead's status board.

## Using it from Claude Code
Restart Claude Code after joining, then ask in plain language:

- "Ask the backend Claude what the `/api/orders` response looks like."
- "Ask Priya's Claude to fix the null check in `OrderList.tsx`." This creates a fix request that Priya must approve.
- "Report status: working on the checkout page, blocked on the payments API."
- "Show me the team status." (lead only)
- "Assign QA a task to regression-test login." (lead only)
- "Any new messages?" or "Tell the team I'm deploying staging at 5."

| Tool | What it does |
|---|---|
| `list_team` | Who is on the team and whose agent is online |
| `ask_claude` | Send a `read` question or a `fix` request to a teammate's Claude. Pass `thread_id` to follow up in the same conversation with context kept |
| `check_task`, `list_tasks` | Status, results and diffs of requests |
| `report_status` | Tell the lead what you're doing |
| `get_team_status` | Lead only: everyone's status and git activity |
| `assign_task`, `update_task` | Lead assigns work; the assignee updates its progress |
| `send_message`, `read_inbox`, `list_threads`, `read_thread` | Team chat |

## Safety model
- **Read requests** run with read-only tools only: `Read`, `Grep`, `Glob`, and `git status/log/diff/show`.
- **Fix requests** do nothing until the target machine's owner approves them, either in the agent terminal (`y/N`) or with the web banner. After approval:
  - the work runs in a separate **git worktree** on the branch `claude-link/task-<id>`, so your checkout and uncommitted work stay untouched;
  - the result is committed to that branch and **never pushed**;
  - you review it with `git diff HEAD...claude-link/task-<id>` and merge it yourself.
- Not even the lead can approve a fix on someone else's machine.
- Each request runs on the target person's own Claude Code login.
- Tokens are stored hashed. Every API call needs a token. The lead can rotate or revoke any token.
- Traffic uses plain HTTP inside the LAN. Use it only on a trusted office network.

Optional settings in `~/.claude-link/config.json`:
- `taskTimeoutMinutes` (default 15);
- `fixAllowedTools`, for example `["Bash(npm test:*)"]`, to let fixes run your tests;
- `claudeBin`, a path to the `claude` executable.

## Development
```bash
npm test            # hub API tests (vitest)
npm run typecheck
npm run dev:web     # Vite dev server on :5173, proxied to a hub on :4545
```
Code layout:
- `packages/shared` holds the protocol types and schemas.
- `packages/hub` is the Fastify server and SQLite store.
- `packages/cli` contains the `hub`, `join`, `agent`, `mcp` and `hook` commands.
- `packages/web` is the React dashboard.

Set `CLAUDE_LINK_HOME` to run several identities on one machine while testing.
