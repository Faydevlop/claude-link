# Architecture

How Claude Link works, for developers and reviewers. For the security model see [SECURITY.md](../SECURITY.md).

## Components

```
 Lead's computer                                   Each teammate's computer
┌───────────────────────────────────────┐          ┌──────────────────────────────────────────┐
│ Claude Link app (or `claude-link hub`)│          │ Claude Link app (or `claude-link agent`)  │
│                                       │  HTTPS   │                                          │
│  Hub (Fastify)  ◄─────────────────────┼──────────┼──  Agent ──── starts ──► Claude Code (-p) │
│   ├ REST API  /api/*                  │  + WSS   │    │                       │  ▲           │
│   ├ WebSocket /ws  (events)           │ pinned   │    │ git status            │  │ MCP       │
│   ├ SQLite hub.db                     │  cert    │    ▼                       ▼  │           │
│   └ TLS cert (self-signed)            │          │  shared projects      read-only git MCP   │
│                                       │          │  (+ temporary worktrees for fixes)       │
│  Agent + My Claude for the lead       │          │  UI (Electron renderer) ── same API ──►  │
└───────────────────────────────────────┘          └──────────────────────────────────────────┘
                                         Claude Code ──HTTPS──► Anthropic (as usual)
```

| Package | What it is |
|---|---|
| `packages/shared` | Protocol types and request schemas (zod), the approval hash, the desktop bridge contract. |
| `packages/hub` | The team server: Fastify REST + WebSocket, SQLite store (`node:sqlite`), TLS identity, rate limiting. |
| `packages/cli` | `claude-link` command: `hub`, `join`, `agent`, `mcp` (team tools for Claude Code), `git-mcp` (read-only git), `hook`. Also the agent, task runner and execution policy shared with the desktop app. |
| `packages/web` | React dashboard. Served by the hub to browsers, and bundled as the desktop app's UI. |
| `packages/desktop` | Electron app: hosts the hub (lead), runs the agent and My Claude, exposes a small validated bridge to the UI. |

Everything runs TypeScript directly on Node ≥ 23.6 (type stripping) except the web UI and the Electron bundle, which are built with Vite.

## Network

- The hub listens on one TCP port (default 4545) on all interfaces. A small front server looks at the first byte of
  each connection: TLS handshakes go to the HTTPS server; plain HTTP gets a redirect (browsers) or `426` (old apps).
- Agents connect **out** to the hub; members' computers open no ports.
- Discovery: the lead's app advertises `_claude-link._tcp` over mDNS with the team and lead names. Discovery carries
  nothing secret; joining still needs approval.
- Trust: there is no CA. Each client pins the hub certificate it saw at join time (`hubCert` in its settings) and
  passes it as the only trusted CA with hostname checks disabled, so the LAN IP may change freely.
  The desktop UI gets the same check via Electron's `setCertificateVerifyProc`.

## Authentication flow

```
Join request (new computer)                      Lead
  probe https://host:4545  ── TLS (TOFU) ──►  hub presents cert C
  POST /api/join-requests {name, role, device}
       ◄── {requestId, secret}
  code = H(fingerprint(C) | secret) → shown     hub: code = H(fingerprint(own cert) | secret)
                                                lead compares codes, picks access, approves
  GET /api/join-requests/:id?secret=… (poll)
       ◄── {token, member}   (only once)
  save {hubUrl, hubCert: C, token}
```

Alternative: the lead adds a member in **Members → Add member** and sends the address and token privately; the
member uses **Join a team → I have a token** (the certificate is pinned on that first connection).

Every API call carries `Authorization: Bearer <token>`. Browsers get a 60-second single-use ticket
(`POST /api/ws-ticket`) to open `/ws`. The hub keeps only SHA-256 hashes of tokens.

## Task lifecycle

```
  read (question)                     fix (code change)                      assignment
  ───────────────                     ─────────────────                      ──────────
  queued                              pending_approval                       open
    │ dispatch (task.run) to agent      │ owner approves on own computer        │ assignee updates
    │ agent: beforeRun (optional ask)   │   (local record: hash of request      ▼
    │ agent: POST claim (CAS)           │    + execution settings)           in_progress / blocked
    ▼                                   ▼  hub stores approver, time, hash      │
  running ── complete ──► done/failed  queued ── dispatch ──► agent:           ▼
                                         check local approval (else ask/refuse) done
                                         POST claim {approvalHash} (CAS)
                                         ▼
                                       running ── complete ──► done/failed
                                         (worktrees, commit on claude-link/task-N)
  rejected: owner rejects, or withdraws an approval before the fix starts
```

- **Dispatch** is a WebSocket event to the target's agent (`task.run`). It is sent when a task becomes runnable
  and again whenever the agent reconnects. Duplicates are harmless: only one **claim** (`queued → running`) succeeds.
- **Completion** is retried by the agent until the hub acknowledges it and is idempotent on the hub.
- If an agent restarts while a task is `running`, it marks that task failed on reconnect ("send it again").
- Follow-up questions in the same Claude conversation resume the target's Claude session (`--resume`), so context is kept.

## Execution on the target computer

The agent turns a task into one `claude -p` run. The arguments come from `buildPolicy()`
([`packages/cli/src/agent/policy.ts`](../packages/cli/src/agent/policy.ts)):

| | Question (`read`) | Fix (`fix`) | My Claude (`personal`) |
|---|---|---|---|
| Built-in tools (`--tools`) | Read, Grep, Glob | Read, Grep, Glob, Edit, Write (+ Bash if configured) | Read, Grep, Glob, WebSearch, WebFetch |
| Permission mode | `dontAsk` | `acceptEdits` | `default` |
| Owner's settings files | ignored (`--restricted`) | ignored (`--restricted`) | used |
| MCP servers | read-only git only (`--strict-mcp-config`) | read-only git only | read-only git + team tools |
| Working directory | project / workspace folder | temporary worktrees | project / workspace folder |
| Environment | scrubbed | scrubbed | owner's own |

Permission rules too long for a command line go into a per-run `--settings` file under `~/.claude-link/run/`
(deleted after the run). Capabilities of the installed Claude Code are read from `claude --help`; older versions get
an explicit deny list instead of `--tools`/`--restricted`.

Fixes: for each shared project, `git worktree add -b claude-link/task-N <tmp>/<project> HEAD`; Claude edits there;
Claude Link stages, diffs, and commits changed projects (`--no-verify`), removes the worktrees, keeps the branch only
where something changed, and returns the combined diff.

## Data storage

| Where | What | Protection |
|---|---|---|
| Lead: `hub.db` (+ `hub.db.backup-v*` after upgrades) | Members (token hashes), threads, messages, tasks (prompts, results, diffs), status, audit log, join requests | User profile; not encrypted at rest |
| Lead: `hub-key.pem`, `hub-cert.pem` (`tls/` in the app data folder, or `~/.claude-link/hub/`) | Hub TLS identity | Key file owner-only |
| Each computer: `config.json` (app data folder, or `~/.claude-link/`) | Hub URL, pinned certificate, token, projects, preferences | Owner-only, written atomically |
| Each computer: `approvals.json` | Local fix approvals (hash of request + settings) | Owner-only |
| Each computer: `my-claude.json` (desktop) | My Claude conversation history | Owner-only |
| Each computer: `worktrees/`, `run/` | Temporary fix worktrees and per-run policy files | Removed after each task |

App data folder: `%APPDATA%\Claude Link` (Windows), `~/Library/Application Support/Claude Link` (macOS).

## Events (WebSocket)

`hello`, `member.updated`, `member.removed`, `status.updated`, `thread.updated`, `message.created`, `task.updated`,
`joinRequest.updated`, and `task.run` (agent only). Each viewer receives only what they may see (member details are
redacted for non-leads; tasks only for the people involved and the lead). Agents validate `task.run` and
`task.updated` against a schema before acting. Both sides ping every 25–30 s and drop connections that stop answering.

## Code layout (key files)

```
packages/hub/src/server.ts        routes, auth, RBAC, rate limits, dispatch, TLS front server
packages/hub/src/db.ts            schema + migrations (with backup and rollback), queries
packages/hub/src/tls.ts           self-signed certificate, fingerprint, verification code
packages/cli/src/net.ts           HTTPS client with certificate pinning, trust-on-first-use, hub probing
packages/cli/src/agent/core.ts    agent: connection, validation, claims, approvals, outbox, heartbeats
packages/cli/src/agent/runner.ts  runs Claude Code for a task; worktrees for fixes
packages/cli/src/agent/policy.ts  the execution boundary (tools, rules, MCP, flags)
packages/cli/src/agent/protect.ts secret deny rules, environment scrubbing
packages/cli/src/agent/approvals.ts local approval records
packages/cli/src/mcp/gitServer.ts read-only git MCP server
packages/cli/src/mcp/server.ts    team tools for Claude Code (ask_claude, send_message, …)
packages/desktop/src/main/index.ts Electron main: window hardening, IPC validation, services
```
