# Claude Link — security and engineering audit (v0.2.0 → v0.3.0)

Date: 2026-11-05. Scope: the whole repository at commit `75c489b` (hub, CLI and agent, MCP server, desktop app,
web UI, build and CI). Method: full source read; threat modelling; each finding confirmed against the code (and, where
possible, reproduced by a failing test before the fix); fixes verified by automated tests and manual checks.

Summary: **5 critical, 6 high, 15 medium and 9 low** findings. All are fixed or mitigated in this change, except where
noted under [Remaining limitations](#remaining-limitations). The product's features and workflows are unchanged; two
behaviours changed on purpose (see [Compatibility](#compatibility-and-upgrade-notes)).

## How the system worked before

- The hub served plain HTTP/WebSocket on port 4545. Every member had one bearer token (stored hashed).
- Teammates' questions ran `claude -p` on the owner's computer with `--allowedTools Read,Grep,Glob,Bash(git status:*),
  Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(ls:*)` and `--permission-mode default`, inheriting the
  owner's environment and Claude Code settings.
- Fixes needed approval on the hub by the target member, then ran in git worktrees with `acceptEdits` and
  `--allowedTools …,Edit,Write,MultiEdit` plus any `fixAllowedTools`.
- The desktop app hosted the hub/agent and exposed an IPC bridge to the React UI.

The documentation said questions were read-only and fixes were confined to a branch. The code did not fully enforce either.

## Findings

Severity reflects impact on a member's computer or data, assuming the [deployment assumptions](../SECURITY.md#deployment-assumptions).

### Critical

| # | Finding | Impact | Fix | Verified by |
|---|---|---|---|---|
| C1 | Questions' bare `Read` allow rule and `Bash(ls:*)` were not limited to the project. | A teammate (or injected text) could make the owner's Claude read and return `~/.ssh/id_*`, `~/.claude/.credentials.json`, the Claude Link token, cloud credentials. | `--restricted` confines file tools to the working directories; `--tools Read,Grep,Glob`; no bare allow rules; deny rules for secret files/folders and Claude Link's data folder. | `projects.test.ts` "runs questions read-only", "keeps secrets out of reach" |
| C2 | "Read-only" questions could write files: `Bash(git diff:*)` permits `git diff --output=<any path>`; `--no-index` reads files outside the repo. | Arbitrary file write/read on the owner's computer from a question. | Shell removed from questions. New read-only git MCP server with fixed options, `-`-prefixed revisions refused, paths confined, secrets excluded. | `security.test.ts` "read-only git server" (end to end: `--output` refused, no file created) |
| C3 | Fixes had bare `Edit`/`Write`/`MultiEdit` allow rules, which apply to any path. | An approved fix could modify the owner's real checkout, `.git/hooks`, `~/.claude/settings.json` (hooks run commands), shell profiles: code execution beyond the worktree. | No broad edit rules (`acceptEdits` covers the working dirs only); `--restricted`; deny edits to the owner's repositories, `.git`, `.claude`, `.mcp.json`, `.husky`, `.vscode/tasks.json`, secrets. | `projects.test.ts` "bounds a fix" |
| C4 | The owner's own Claude Code configuration applied to teammates' tasks: user/project allow rules, hooks and MCP servers (including Claude Link's own team tools). | If the owner allowed e.g. `Bash` for themselves, every teammate's "read-only" question had a shell. Teammates' questions could act as the owner via the team tools. | `--restricted` ignores user/project/local settings; `--strict-mcp-config` loads only the read-only git server; `--tools` allowlist. | `projects.test.ts` "runs questions read-only" |
| C5 | All traffic was plain HTTP/WS. | Anyone on the Wi-Fi could read code, answers and diffs, steal tokens and replay them, or impersonate the hub. | TLS by default (self-signed ECDSA P-256), certificate pinning in every client including the UI, verification code at join, HTTP → redirect/426. | `e2e.test.ts` "encrypted connection" (impostor receives no token), manual desktop check |

### High

| # | Finding | Impact | Fix | Verified by |
|---|---|---|---|---|
| H1 | Desktop IPC `settings:update` accepted any key from the renderer, incl. `claudeBin`, `fixAllowedTools`, `hubUrl`, `token`. No IPC sender check. | Any script running in the UI (e.g. through a future injection bug) could set `claudeBin` to any program and have it executed: code execution. | Strict whitelist schema for UI-changeable settings; every IPC handler validates its caller and arguments. | Manual: `updateSettings({claudeBin})` from the page is rejected ("Unrecognized key") |
| H2 | Fix approval existed only on the hub. | Whoever controlled the hub (the lead's computer, a modified hub, or anyone in the middle on plain HTTP) could mark a fix approved and have it run without the owner's consent. | Approval recorded on the owner's computer, bound to a hash of the request and execution settings; agent refuses or asks again otherwise; hub requires a claim with the matching hash and stores approver/time/hash. | `security.test.ts` approvals; `hub/security.test.ts` "a fix cannot be claimed…"; `e2e.test.ts` "refuses a fix that the hub marks approved…" |
| H3 | Tasks inherited the full environment. | `SSH_AUTH_SOCK` (push with the owner's keys), cloud and CI tokens, database URLs were available to code Claude ran (e.g. via `fixAllowedTools`). | Environment scrubbed for teammates' tasks (keeps Claude Code's own auth). | `projects.test.ts` "does not hand…credentials"; `security.test.ts` "drops credentials" |
| H4 | Join requests could be spoofed: any device could request to join as an existing teammate's name; the lead had no way to tell. | An attacker on the LAN gets a member token by social engineering the approval. | Verification code shown on both screens, bound to the request secret and the TLS certificate (also detects a man in the middle); requests expire after 30 min; device and IP shown. | `hub/security.test.ts` "joining" |
| H5 | `fixAllowedTools` was passed through unchecked. | A config entry like `Bash` gave fixes a full shell. | Only specific `Bash(<command prefix>)` rules are accepted; settable only in the config file, not the UI. | `security.test.ts`, `projects.test.ts` "only passes specific extra commands" |
| H6 | Unauthenticated WebSocket attempts left sockets that prevented the hub from shutting down (Node stops tracking upgrade sockets). Found while writing tests. | Anyone on the LAN could make "Stop team"/quit hang. | Sockets of refused upgrades are closed by the hub. | `hub/security.test.ts` "WebSocket tickets…" (closes cleanly after a 401) |

### Medium

| # | Finding | Fix |
|---|---|---|
| M1 | Every member received everyone's git branch, uncommitted file names, project paths, IPs and device names (`/api/members`, events), though the status board was lead-only. | Redacted for non-leads (they see names, roles, online state). |
| M2 | No atomic claim: two agent processes for one person (e.g. app and CLI) or a re-sent dispatch could run a task twice. | Compare-and-set claim `queued → running`; dispatch duplicates are harmless. |
| M3 | A completion sent while the hub was unreachable was lost; the task stayed `running` forever. | Agent outbox with retry; idempotent completion on the hub. |
| M4 | A malformed WebSocket message crashed the agent (unguarded `JSON.parse` in an event handler). | Guarded parse plus schema validation of every event the agent acts on. |
| M5 | No server-side heartbeat; the agent sent pings but never noticed missing pongs. Half-open connections showed people online and stalled agents. | Ping/pong on both sides with termination; reconnect with backoff and jitter. |
| M6 | Timeouts killed only the direct child. With npm's `claude.cmd` on Windows that is `cmd.exe`; Claude kept running. | Process-tree kill (`taskkill /T`, process groups on macOS/Linux) with escalation; cancellation on stop/revocation. |
| M7 | Tokens accepted in the query string of every API route; the web UI put its token in the WebSocket URL. | Tokens only in the `Authorization` header; browsers use single-use 60 s tickets; credentials redacted from any log line. |
| M8 | No rate limiting except join requests; no brute-force protection. | Per-member API/task/message limits; failed sign-ins block an address for 5 min. |
| M9 | Tokens never expired. | Idle expiry (default 30 days, lead-configurable; lead exempt). |
| M10 | `Access-Control-Allow-Origin: *` and no origin check on the WebSocket (cross-site WebSocket hijacking with a ticket/token). | Origin allowlist (app, same origin, localhost dev); others get 403. |
| M11 | Removing a member left their requests queued forever and did not stop a running task. | Their open tasks are cancelled; the agent cancels the running task on revocation. |
| M12 | Database migrations had no rollback (a failure left a transaction open) and no backup; a newer schema was not detected. | Transactional migrations with rollback, `VACUUM INTO` backup before upgrading, refusal to open newer schemas. |
| M13 | Fix commits ran the repository's git hooks (`pre-commit` etc.) on a teammate's request. | Commits use `--no-verify` and no GPG signing. |
| M14 | My Claude was labelled read-only but used the owner's settings (which may allow edits) and had WebFetch with access to secrets, while reading teammates' messages (prompt-injection exfiltration path). | `--tools` read-only allowlist regardless of settings; secret deny rules; strict MCP config. |
| M15 | The permission rule list could exceed `cmd.exe`'s 8,191-character limit, breaking every task for users whose `claude` is npm's `.cmd` shim. Found by tests on Windows. | Rules go into a per-run `--settings` file; only short tool names stay on the command line. |

### Low

| # | Finding | Fix |
|---|---|---|
| L1 | No Content-Security-Policy or security headers on the hub's web page or the desktop UI. | CSP (scripts from self only) in built pages and as a header; `nosniff`, `DENY` framing, `no-referrer`, `no-store` on API. |
| L2 | Electron: no permission request handler, `<webview>` not blocked, navigation allowed to any `file://`, `http:` links opened externally. | All permissions denied, webviews and new windows blocked, navigation locked to the app page, only `https:` opened externally. |
| L3 | Config and session files written non-atomically. | Atomic owner-only writes. |
| L4 | Concurrent or crashed fix runs could leave worktrees that block the next one. | Per-repository lock and `git worktree prune` before each fix. |
| L5 | Unbounded stdout buffer for Claude's output. | Line and result size caps. |
| L6 | No access levels beyond lead/member. | Developer and viewer levels; viewers cannot request fixes. |
| L7 | Audit log metadata (approver hash, IP, device) not visible; no search; capped at 300 entries in the UI. | Search, details and paging in the Audit tab. |
| L8 | Errors shown with `alert()`; missing ARIA labels/states on toggles, tabs and expanders. | Inline error messages with `role="alert"`; `aria-label`, `aria-current`, `aria-pressed`, `aria-expanded`. |
| L9 | Three moderate advisories in transitive dependencies (`glob`, `minimatch` via `@fastify/static`). | `npm audit fix` (compatible updates): 0 vulnerabilities. |

Also fixed: three runner tests failed on Windows because the test stand-in for Claude Code was a shebang script; it is now cross-platform (and exercises the real `.cmd` quoting path on Windows).

## New protections (overview)

1. TLS with certificate pinning (all clients, including the Electron UI), HTTP redirect/426.
2. Join verification codes; join request expiry; access level chosen at approval.
3. Access levels (admin/developer/viewer) enforced by the hub; member detail redaction.
4. Single-use WebSocket tickets; header-only tokens; idle token expiry; brute-force and rate limits; origin checks; security headers.
5. Execution policy per run mode: `--restricted`, `--tools`, `--strict-mcp-config`, `dontAsk`/`--permission-prompts none`, secret deny rules via a settings file, capability detection with deny-list fallback.
6. Read-only git MCP server replacing shell access.
7. Environment scrubbing for teammates' tasks.
8. Local, hash-bound fix approvals; claim with approval hash; approver/time/hash on the task and in the audit log; withdraw approval before start.
9. Exactly-once claims, completion outbox, idempotent completion, heartbeats, schema-validated events, process-tree kill, cancellation on revocation.
10. Electron hardening: validated IPC with sender checks, permission denial, navigation/webview lock, CSP.
11. Safe database migrations with backup and rollback.
12. CI on Linux, macOS and Windows: typecheck, tests, builds, dependency audit.

## Files

**New**

| File | Purpose |
|---|---|
| `SECURITY.md` | Security architecture, threat model, deployment assumptions, residual risks, reporting |
| `docs/ARCHITECTURE.md` | Components, data flow, task lifecycle, storage |
| `docs/AUDIT-REPORT.md` | This report |
| `.github/workflows/ci.yml` | Tests, typechecks and builds on three OSes |
| `packages/hub/src/tls.ts` | Self-signed certificate, fingerprints, verification codes |
| `packages/hub/src/rateLimit.ts` | Sliding-window rate limiter |
| `packages/shared/src/approval.ts` | Approval hash bound to the exact request |
| `packages/cli/src/net.ts` | Pinned HTTPS client, trust on first use, hub probing |
| `packages/cli/src/agent/policy.ts` | Execution boundary per run mode |
| `packages/cli/src/agent/approvals.ts` | Local approval records |
| `packages/cli/src/agent/selfCommand.ts` | How Claude Link starts its helper processes (CLI vs. Electron) |
| `packages/cli/src/mcp/gitServer.ts` | Read-only git MCP server |
| `packages/hub/test/security.test.ts`, `packages/cli/test/security.test.ts`, `packages/cli/test/e2e.test.ts`, `packages/cli/test/fakeClaude.ts` | Tests |

**Changed**: `packages/hub/src/{server,db}.ts`; `packages/shared/src/{index,desktop}.ts`;
`packages/cli/src/{api,config,index}.ts`, `agent/{core,runner,agent,claudeBin,protect}.ts`, `commands/{hub,join}.ts`,
`mcp/server.ts`; `packages/desktop/src/main/{index,agentHost,hubHost,myClaude,network,settings,mcp}.ts`,
`src/preload/index.ts`, `electron.vite.config.ts`, `package.json`; `packages/web/src/{App,store}.tsx`,
`pages/{Chat,Members,Audit,Settings,Tasks,Onboarding}.tsx`, `vite.config.ts`; tests `hub.test.ts`, `projects.test.ts`;
`README.md`; `package-lock.json` (audit fix); versions 0.3.0.

## Test results

Environment: Windows 11, Node 24.13.0, git 2.52, Claude Code 2.1.312 (capability detection only; no model calls in tests).

```
npm test            5 files, 66 tests, all passed
                    hub.test.ts (15)          existing API behaviour (updated for claims)
                    hub/security.test.ts (19) RBAC, redaction, claims, approvals, auth, expiry, tickets, origin, joining, migrations
                    projects.test.ts (14)     discovery; execution policy for questions/fixes; secrets; env; hooks; cancellation
                    cli/security.test.ts (9)  git MCP (unit + end to end), env scrubbing, rule paths, approvals
                    e2e.test.ts (9)           TLS hub + real agents: pinning, impostor, HTTP, approve/run, refuse, confirm,
                                              exactly-once, hub restart, revocation
npm run typecheck   pass (CLI, hub, shared)
tsc desktop         pass
tsc web             pass
npm run build       pass (web)
electron-vite build pass (desktop)
npm audit --omit=dev  0 vulnerabilities
```

### Manual verification

Performed on the built desktop app (`electron-vite build`, then Electron with a throwaway profile, driven over the
Chrome DevTools protocol; the profiles were deleted afterwards):

- The UI renders; calls from the app's own page pass the IPC sender check.
- `window.require` and `process` are undefined in the renderer; the CSP meta tag is present.
- `updateSettings({ claudeBin: "C:/evil.exe" })` from the page is rejected.
- Joining a TLS hub through the app's own join flow pins its certificate (fingerprint matches the hub); the agent
  connects; the renderer loads the team UI over the pinned TLS connection; the live WebSocket connects with a ticket;
  the header shows 🔒.
- The bundled `mcp.js git` server runs under Electron's node mode: `git_log` answers; `git_diff --output=…` is refused
  and no file is created.
- Capability detection against the installed Claude Code 2.1.312 finds `--restricted`, `--tools`,
  `--strict-mcp-config`, `--permission-prompts`, `dontAsk` and `--settings`.

Not verified here: macOS and Linux runs (covered by the new CI workflow on the next push), installer packaging
(`electron-builder`), and real Claude Code model runs under the new flags (they cost API usage; the flags and settings
file format were checked against `claude --help`, and the policy is unit-tested with a stand-in).

## Compatibility and upgrade notes

- **Database**: upgraded automatically from schema 2 to 3 on first start; a backup `hub.db.backup-v2-<time>` is kept.
- **Encryption**: the lead's app switches the hub to HTTPS automatically. Members' apps (v0.3.0) upgrade their
  connection automatically and pin the certificate they see then; compare the fingerprint in Settings with the lead's
  once. Apps older than 0.3.0 cannot connect to an encrypted hub ("upgrade required"): update everyone together.
  CLI users re-run `claude-link join https://<lead-ip>:4545 --token <token>` (it shows the fingerprint).
- **Fixes need local approval** (deliberate change). Fixes approved in a browser are confirmed on the owner's computer
  (dialog in the app, `y/N` in the terminal agent). Non-interactive CLI agents refuse them unless the owner sets
  `"trustHubApprovals": true` in `config.json` (not recommended).
- **Older agents** (before 0.3.0) cannot reach an encrypted hub. With a hub started with `--insecure-http` they can
  still answer questions, but cannot run fixes (the hub requires a claim with an approval hash).
- **Older Claude Code** without `--restricted`/`--tools` still works, with the weaker deny-list boundary (logged in each task's progress).
- `fixAllowedTools` entries other than `Bash(<command>)` are ignored.

## Remaining limitations

See [SECURITY.md → Residual risks](../SECURITY.md#residual-risks) for the full list. In short: questions disclose shared
code by design and can be steered by prompt injection; code goes to Anthropic as with any Claude Code use; there is no
OS-level sandbox (the boundary is Claude Code's permission system, and commands allowed for fixes are unsandboxed); the
lead/hub sees all content, stored unencrypted; trust on first use; bearer tokens on disk; unsigned installers.

## Recommended next steps

1. **OS-level isolation for fixes**, especially when `fixAllowedTools` is used: run fix tasks in a container or
   devcontainer, or use Claude Code's Bash sandbox where available.
2. **Device-bound credentials**: per-device keys or mutual TLS instead of bearer tokens, with short-lived session
   tokens; encrypt tokens at rest with the OS keychain (Electron `safeStorage`; the MCP server would need its own scoped token).
3. **Per-person sharing controls**: choose which teammates may question your Claude, per project.
4. **Code signing** for the macOS and Windows installers, and a signed update channel.
5. **Hub data protection**: optional encryption of `hub.db`, retention settings, an option to hide DMs from the lead,
   tamper-evident audit log (hash chain) and export.
6. **UI end-to-end tests** (Playwright with Electron) for onboarding, approval and review flows.
7. **Real-model regression check**: an opt-in test that runs actual Claude Code against a fixture repo to confirm that
   the denied paths and tools are refused in practice.
