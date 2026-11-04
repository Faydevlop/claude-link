# Claude Link

Claude Link connects your team's Claude Code sessions over the office network. With it, you can:

- **See team progress.** The lead's dashboard shows each person's status, git branch, uncommitted files and recent commits.
- **Ask another person's Claude.** "Ask the backend Claude what `/orders` returns." The request runs in their repo with read-only access, and the answer comes back to you.
- **Request a fix in someone else's repo.** Their Claude makes the change on a new git branch, but only after the owner approves it.
- **Chat.** There is a `#team` channel and direct messages, and every Claude-to-Claude conversation is saved.

- **Talk to your own Claude.** The app's My Claude tab runs Claude Code on your project and can reach teammates' Claudes for you.

The lead's app shows Status, Chat, My Claude, Tasks, Members, Audit and Settings. Everyone else sees Chat, My Claude, Requests and Settings.

## How it works

![How Claude Link works](docs/how-it-works.png)

The diagram source is [docs/how-it-works.drawio](docs/how-it-works.drawio); open it in [draw.io](https://www.drawio.com) to edit it.

- The lead's app runs a small **team server** on the lead's computer. It keeps the chat history and team status in one file there (`hub.db`).
- Every other app connects to that server over the office Wi-Fi. They find it automatically, and the lead approves each new computer.
- When you ask a teammate's Claude something, the question goes to the team server, then to that teammate's app. Their own Claude Code reads their code and sends the answer back the same way.
- The actual thinking is done by each person's own **Claude Code**, signed in with their own account, exactly as if they were using it in a terminal.

## Offline and safe: what Claude Link is (and isn't)

Claude Link is only a **messenger between Claudes** on your office network. It passes questions, answers and chat messages from one team member's computer to another. That is all it does.

**Claude Link itself works fully offline.**
- All of its traffic stays on the office Wi-Fi. It has no cloud server, no account system, no telemetry or analytics, and no auto-updater, and it never contacts any internet address.
- The app's screens, fonts and styles are bundled inside it, so nothing is downloaded when it runs.
- The only outside links are the "install Claude Code" and "install Git" help links on the setup screen. They open in your browser, and only if you click them.

**The only internet traffic is Claude Code.**
- Claude Code talks to Anthropic over HTTPS to run Claude, the same as when you use Claude Code on its own. That is the blue dashed line in the diagram.
- Claude Link adds no extra data to that connection, and it never sends anything to Anthropic itself.

**It is not a remote-access tool.**
- Nobody can control your computer or open a shell on it through Claude Link.
- Questions from teammates are read-only: their Claude can read and search the projects you share, and their git history, but cannot change files, run commands, use the web, or read secrets such as `.env` files, SSH keys, cloud credentials or your Claude Link token. Your own Claude Code settings do not widen this.
- **My Claude** is read-only too, whatever your Claude Code settings allow.
- A *fix* request does nothing until **you**, the owner of that computer, approve it **on your computer**. Even then it only edits separate copies of your projects on a new git branch, never touches your current work, and never merges or pushes anything. Not even the lead can approve a fix on your computer.
- Only the project folders you choose are shared. Your other files are not.

**Network.**
- All traffic is encrypted (TLS). Each computer remembers the team server's certificate when it joins and refuses any other, so someone else on the Wi-Fi cannot read or fake it.
- Only the lead's computer accepts connections, on port 4545. Teammates' apps open no ports; they only connect out to the lead.
- The team server is reachable from the office network only. It is not reachable from the internet unless someone deliberately sets up the office router to forward that port. Don't.
- Joining needs the lead's approval, checked with a code shown on both screens. Every request carries a secret token, stored hashed. The lead can remove a computer or issue a new token at any time, and tokens that go unused for 30 days stop working.
- Every join, request, approval and result is recorded in the **Audit** tab.

**Limits to be aware of.**
- Code that Claude Code reads is sent to Anthropic as part of normal Claude Code use. Follow your company's rules for Claude Code as usual.
- Teammates can ask about anything in the projects you share. Keep secrets out of your repositories.
- Claude Code runs as your user; the limits above come from Claude Code's permission system, not from an operating-system sandbox. See [SECURITY.md](SECURITY.md) for the full security model and remaining risks.
- The installers are not signed with a paid certificate yet. The warnings from macOS ("unidentified developer") and Windows SmartScreen ("unknown publisher") are about the missing certificate, not about anything the app does. The full source code is in this repository.


## Desktop app (recommended)

### Install
Download the installer from the repo's **Releases** page:
- **Mac:** `Claude-Link-<version>-mac-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel). Open it and drag Claude Link to Applications.
- **Windows:** `Claude-Link-Setup-<version>.exe`. Run it and follow the installer.

The installers aren't code-signed yet, so the first launch shows a warning:
- **Mac:** right-click Claude Link in Applications, choose **Open**, then **Open** again.
- **Windows:** click **More info**, then **Run anyway**.

Everyone also needs:
- **Claude Code**, installed and logged in. Run `claude` once in a terminal to log in.
- **Git.**
- To be on the **same Wi-Fi** as the team lead.

The app checks for Claude Code and Git during setup.

### Team lead
1. Open Claude Link and choose **Create a team**.
2. Enter your name and the team name, then click **Create team**. When asked, allow incoming connections:
   - Mac: macOS asks whether to accept incoming network connections. Click **Allow**.
   - Windows: the Defender Firewall prompt appears. Tick **Private networks** and click **Allow**.
3. Choose your projects: **One project**, or **Several projects** if your repositories (e.g. frontend, backend) live in one folder. Pick that folder and every git repository inside is listed; untick any you don't want, or add projects from elsewhere.
4. Set your permissions, then click **Finish setup**.
5. Keep the app open while the team works. Closing the window keeps it running in the menu bar (Mac) or system tray (Windows).
6. When a teammate asks to join, you get a notification. Open **Members**, check that the code matches the one on their screen, choose their access (Developer, or Viewer for questions only) and click **Approve**.

### Teammates
1. Open Claude Link and choose **Join a team**.
2. Pick your team from the list. If it doesn't show up, type the address shown in the lead's **Settings → Team address**.
3. Enter your name and role, then click **Send join request**.
4. Tell the lead the **verification code** on your screen. They approve only if it matches the code next to your request. The app continues by itself once they do.
5. Choose your projects (**One project** or **Several projects**, as above), set your permissions, then click **Finish setup**.

Alternatively, the lead can add you under **Members → Add member** and send you an address and token. Use **Join a team → I have a token**.

### Using it
- **Chat:** `#team`, direct messages, and every Claude-to-Claude conversation. Click **Ask a teammate's Claude** to send a question or a fix request.
- **My Claude:** chat with your own Claude Code. It works on your project and can also message teammates' Claudes, for example "ask the backend Claude what `/orders` returns" or "report status: login page done".
  It is read-only: it can read your code but never changes files.
- **Approvals:** when someone's Claude wants to change your code, you get a notification and a yellow banner with the exact request and what approving allows. Click **Approve and run** or **Reject**. After the fix runs, review its diff in **Requests** and merge the branch yourself if you want it.
- **Several projects:**
  - Questions can read all of them.
  - A fix gets a separate working copy of each project on the same `claude-link/task-N` branch. The branch is kept only in the projects that actually changed.
  - The diff is labelled by project, e.g. `backend/app.txt`.
- **Settings:**
  - add or remove projects;
  - turn automatic answers to questions on or off;
  - start the app when you log in;
  - optionally add the team tools to your regular Claude Code in VS Code or the terminal (off by default).

### Building the installers (.dmg and .exe)

You need **Node.js 24 or newer** and **git**. Run every command from the repository folder.

**1. Get the code and install dependencies (once)**
```bash
git clone https://github.com/Faydevlop/claude-link.git
cd claude-link
npm install
npm test             # optional: check everything works
```

**2. Build**

| You want | Run | Works on |
|---|---|---|
| Mac installer (`.dmg`) | `npm run dist:mac` | a Mac |
| Windows installer (`.exe`) | `npm run dist:win` | a Mac or a Windows PC |

The installers are written to `packages/desktop/release/`:

| File | For |
|---|---|
| `Claude-Link-<version>-mac-arm64.dmg` | Macs with an Apple chip (M1 and later) |
| `Claude-Link-<version>-mac-x64.dmg` | Older Intel Macs |
| `Claude-Link-Setup-<version>.exe` | Windows 10 and 11 (64-bit) |

To check which chip a Mac has, open Apple menu → **About This Mac**. The first build downloads Electron and the installer tools, which needs internet. Later builds reuse them.

**3. Share them.** Send the files any way you like: a shared drive, a USB stick or chat. Teammates install them as described under [Install](#install).

**Releasing a new version**
1. Change `"version"` in `packages/desktop/package.json`, for example `0.2.0` → `0.3.0`. The version shows in **Settings** and in the file names.
2. Build again as above, or let GitHub build both installers.

**Building on GitHub instead**

`.github/workflows/desktop.yml` builds the Mac and Windows installers on GitHub's own machines. There are two ways to start it:
- **Without a release:** on GitHub, open **Actions → Desktop app → Run workflow**. When it finishes, download the installers from the run's **Artifacts** section.
- **With a release:** push a version tag, for example `git tag v0.3.0 && git push origin v0.3.0`. This builds both installers and attaches them to a GitHub Release.

**For development**
```bash
npm run app          # run the app from source, without building an installer
```

**Troubleshooting**
- Before installing a new build over an old one, quit Claude Link: tray or menu bar icon → **Quit**. Closing the window only hides it. Your team, settings and chat history are kept.
- The installers are not signed with a paid certificate. That is why macOS asks you to right-click → **Open** the first time, and why Windows shows **More info → Run anyway**.

---

## Command-line version
The app is the easiest way to run Claude Link. If you prefer terminals, the same features are also available as a CLI.

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
The hub prints a **Network URL** (for example `https://192.168.1.77:4545`), its **certificate fingerprint** and your **lead token**. The token is shown only once. If you lose it, restart with `--rotate-lead-token`.
The first time it runs, macOS asks whether Node may accept incoming connections. Click **Allow**.

Open the URL, sign in with the lead token, and add teammates under **Members → Add member**. Each new member gets their own token. The browser warns that the certificate is self-signed: check that the fingerprint matches what the hub printed before you continue.

Connect your own Claude Code as well:
```bash
claude-link join 127.0.0.1:4545 --token <lead-token> --repo ~/work/project
claude-link agent
```

### 2. Each teammate
```bash
# same install steps (clone, npm install, cd packages/cli && npm link), then:
claude-link join <lead-ip>:4545 --token <their-token> --repo ~/work/project [--hooks]
# several projects: --workspace ~/work   (adds every git repository inside)
#               or: --repo ~/work/frontend ~/work/backend
# non-interactive:  --fingerprint <sha256 printed by the hub>
claude-link agent          # keep this running while you work
```
`join` shows the hub's certificate fingerprint and asks you to confirm it matches the one the lead's hub printed, then checks the token, saves `~/.claude-link/config.json` (with the pinned certificate), and registers the `claude-link` MCP server with Claude Code at user scope. The optional `--hooks` flag also adds a Claude Code hook that reports each commit to the lead's status board.

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
Summary below; the full model, threat analysis and remaining risks are in [SECURITY.md](SECURITY.md).

- **Read requests** run Claude Code with only `Read`, `Grep` and `Glob` on your shared projects, plus a read-only git tool (status, log, diff, show, blame). No shell, no edits, no web, no other MCP servers, and your own Claude Code settings are ignored (`--restricted`). Secrets (`.env`, keys, `~/.ssh`, cloud credentials, Claude credentials, your Claude Link token) are denied, and credentials are removed from the environment.
- **Fix requests** do nothing until the target machine's owner approves them **on that machine**, in the agent terminal (`y/N`) or the app. The approval is bound to the exact request; if it changes, it must be approved again. After approval:
  - the work runs in a separate **git worktree** on the branch `claude-link/task-<id>`, so your checkout and uncommitted work stay untouched; Claude can edit only there;
  - the result is committed to that branch (without running repository hooks) and **never merged or pushed**;
  - you review it with `git diff HEAD...claude-link/task-<id>` and merge it yourself.
- Not even the lead can approve a fix on someone else's machine. Viewers cannot request fixes.
- Each request runs on the target person's own Claude Code login.
- Traffic is TLS-encrypted with a pinned certificate. Tokens are stored hashed; every API call needs one; the lead can rotate or revoke any token, which disconnects that computer at once.

Optional settings in `~/.claude-link/config.json`:
- `taskTimeoutMinutes` (default 15, at most 120);
- `fixAllowedTools`, for example `["Bash(npm test:*)"]`, to let fixes run specific commands such as your tests. Only `Bash(<command>)` entries are accepted. These commands run code from the repository with your user's rights, outside Claude Code's file restrictions;
- `claudeBin`, a path to the `claude` executable;
- `trustHubApprovals` (default `false`): run fixes approved in the hub's web page without asking again in the terminal. Leave it off unless the agent cannot be interactive.

The hub runs HTTPS by default. `claude-link hub --insecure-http` serves plain HTTP for networks where that is unavoidable; everything then travels unencrypted.

## Development
```bash
npm test            # unit, integration and end-to-end tests (vitest); no Claude API calls
npm run typecheck   # CLI, hub, shared
npx tsc -p packages/desktop/tsconfig.json --noEmit
npx tsc -p packages/web/tsconfig.json
npm run dev:web     # Vite dev server on :5173, proxied to a local hub on :4545
```
CI (`.github/workflows/ci.yml`) runs all of these on Linux, macOS and Windows. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together and [docs/AUDIT-REPORT.md](docs/AUDIT-REPORT.md) for the latest security audit.
Code layout:
- `packages/shared` holds the protocol types and schemas.
- `packages/hub` is the Fastify server, SQLite store and TLS identity.
- `packages/cli` contains the `hub`, `join`, `agent`, `mcp`, `git-mcp` and `hook` commands, and the execution policy (`src/agent/policy.ts`).
- `packages/web` is the React dashboard.
- `packages/desktop` is the Electron app. It hosts the hub (lead), runs the agent and My Claude, and reuses the web UI.

Set `CLAUDE_LINK_HOME` to run several identities on one machine while testing.

## License

[MIT](LICENSE) © 2026 Fayis

Claude Link is an independent project. It is not made by or affiliated with Anthropic. It uses each person's own [Claude Code](https://claude.com/claude-code) installation.
