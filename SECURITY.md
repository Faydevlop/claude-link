# Security

This document explains how Claude Link protects a team's code and computers, and what it does not protect against.
It is written for anyone deciding whether Claude Link is acceptable on their network: a technical lead, a CTO or a
security reviewer. Every statement below is checked by an automated test or was verified by hand; the tests are listed
in [Verification](#verification).

**Claude Link is not "completely secure", and this document does not claim that.** It reduces specific risks to
specific levels. [Residual risks](#residual-risks) lists what remains, in plain terms.

- [Summary](#summary)
- [What Claude Link is](#what-claude-link-is)
- [Deployment assumptions](#deployment-assumptions)
- [Threat model](#threat-model)
- [Security architecture](#security-architecture)
- [What data can and cannot be accessed](#what-data-can-and-cannot-be-accessed)
- [Residual risks](#residual-risks)
- [Verification](#verification)
- [Reporting a vulnerability](#reporting-a-vulnerability)

## Summary

| Concern | What Claude Link does |
|---|---|
| Someone on the Wi-Fi reads or replays traffic | All traffic is TLS-encrypted. Each computer pins the team server's certificate when it joins; a different certificate is refused before any token is sent. |
| An unknown device joins the team | Joining needs the lead's approval, confirmed with a 6-digit code shown on both screens. Requests expire after 30 minutes. |
| A teammate's "read-only" question reads secrets or changes files | Questions run with only Read/Grep/Glob and a validated read-only git tool, confined to the shared project folders. No shell, no edits, no web access, no other MCP servers. SSH keys, cloud credentials, `.env` files and Claude Link's own token are denied. |
| A fix request changes code without the owner agreeing | A fix runs only after the owner of that computer approves it **on that computer**. The approval is bound to a hash of the exact request and of the owner's execution settings. Neither the requester, the lead nor the team server can approve it. |
| An approved fix does more than intended | It edits separate git worktrees only, cannot write to the owner's checkout, `.git`, or Claude settings, cannot run commands (unless the owner allowed specific ones), and its result is a commit on a new branch. Nothing is merged or pushed. |
| The owner's own Claude Code settings widen access | Work for teammates runs with `--restricted`, which ignores the owner's user, project and local settings files. |
| A stolen or forgotten token | The lead can rotate or revoke any token, which disconnects that computer at once. Tokens unused for 30 days (configurable) stop working. |
| Abuse of the API | Every request is authenticated and validated. Per-member and per-address rate limits apply. Every join, approval and result is in the audit log. |

## What Claude Link is

Claude Link connects the Claude Code installations of a small team on one local network.

- **The hub** (team server) runs inside the team lead's app (or `claude-link hub`). It stores chat, tasks, status and
  the audit log in one SQLite file on the lead's computer, and relays messages.
- **The agent** runs inside each member's app (or `claude-link agent`). It connects out to the hub, reports git
  status, and runs requests addressed to its owner by starting that owner's own Claude Code.
- **Claude Code** does the actual work, signed in with each person's own account, exactly as if they used it in a terminal.

Claude Link itself never contacts the internet. The only internet traffic is Claude Code talking to Anthropic, as it
always does. Claude Link adds no data to that connection, but **any code Claude Code reads is sent to Anthropic as part
of normal Claude Code use** (see [Residual risks](#residual-risks)).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for components and data flow.

## Deployment assumptions

Claude Link's protections hold under these assumptions. Outside them, read [Residual risks](#residual-risks) first.

1. **A private LAN.** The hub listens on port 4545 of the lead's computer. It must not be exposed to the internet
   (no port forwarding). TLS protects the traffic, but the hub is not hardened as an internet-facing service.
2. **Trusted operating systems.** Each computer's user account is controlled by its owner. Claude Link is not a
   defence against malware already running as that user: such malware can read the user's files, including Claude
   Link's token, regardless of Claude Link.
3. **The lead is trusted with confidentiality.** The hub stores every message, request, answer and diff in plain
   form on the lead's computer, and the lead can read every conversation. The lead **cannot** run code on a member's
   computer or approve changes there.
4. **Members are colleagues, not adversaries with full trust.** Members can ask questions that are answered from
   other members' shared projects. Sharing a project means sharing its source code (and anything committed in it)
   with the team.
5. **A current Claude Code.** The strongest boundary (`--restricted`, `--tools`) needs a Claude Code version that
   supports those flags (2.x; detected automatically). Older versions get an explicit deny list instead, which is weaker.
6. **People look before they approve.** A fix runs only after its owner approves it. Approving a request you did
   not read is the same as running it yourself.

## Threat model

### Assets

- Source code and git history of shared projects.
- Secrets on members' computers: SSH keys, cloud credentials, `.env` files, Claude Code credentials, Claude Link tokens.
- Integrity of members' working copies and repositories.
- Integrity of members' computers (no unwanted code execution).
- Team chat, requests, answers and diffs stored on the hub.

### Adversaries considered

| Adversary | Capabilities | Main controls |
|---|---|---|
| **Network observer** on the same Wi-Fi | Reads and replays traffic; can run a fake hub or sit in the middle (ARP spoofing). | TLS everywhere; certificate pinning; join verification code; tokens only in headers. |
| **Unauthorised device** on the LAN | Sends requests to the hub; floods join requests. | Authentication on every endpoint except health/join; lead approval with verification code; rate limits; origin checks. |
| **Malicious or careless teammate** (authenticated) | Sends questions and fix requests; writes prompts designed to manipulate another person's Claude ("prompt injection"). | Read-only execution boundary; fixes need owner approval on the owner's computer; viewers cannot request fixes; rate limits; audit log. |
| **Untrusted content** in a repository or in teammates' messages | Text that tries to instruct Claude (e.g. "print ~/.ssh/id_rsa"). | Tool boundary (Claude cannot reach secrets or run commands), secret deny rules, system prompt marks requests as untrusted. |
| **Compromised or malicious hub** (or lead) | Edits stored requests; marks fixes approved; sends arbitrary events to agents. | Agents validate every event; fixes need a **local** approval bound to the request hash; the agent never runs a fix the hub claims was approved unless its own owner approved it. |
| **Compromised desktop renderer** (e.g. a script injection bug in the UI) | Calls the desktop app's internal API. | Context isolation, sandbox, no Node in the renderer, CSP; the internal API checks the caller and accepts only validated input, and cannot change what runs (Claude binary, extra tools, hub address). |

### Out of scope

- Malware or another person with control of a member's user account or the lead's computer.
- Anthropic's handling of data sent by Claude Code (governed by your Anthropic agreement).
- Denial of service by someone who can disconnect the Wi-Fi or flood the network.
- Physical theft of an unlocked computer (lock screens and disk encryption are your OS's job; revoke the token).

## Security architecture

### 1. Network: TLS with certificate pinning

- On first start the hub creates its own ECDSA P-256 certificate (`hub-cert.pem`, `hub-key.pem`, key file
  owner-only) and serves **only HTTPS and WSS**, TLS 1.2 or newer.
- There is no certificate authority. Instead each computer **pins** the certificate it saw when it joined
  (trust on first use), and from then on accepts only that exact certificate, whatever IP address the hub has.
  The pin is checked during the TLS handshake, so an impostor is rejected **before any request or token is sent**.
  This applies to the agent, the MCP server, and the desktop UI (Chromium's certificate check is replaced for the pinned certificate only).
- The first contact is protected by people: the **verification code** (below) and the fingerprint shown in
  Settings (desktop) or printed by `claude-link hub` / `claude-link join` (CLI). `claude-link join --fingerprint` checks it non-interactively.
- Plain HTTP on the same port receives a redirect (browsers) or `426 Upgrade Required` (older apps). Nothing is served over HTTP.
- `claude-link hub --insecure-http` exists for networks where TLS is impossible. The app then shows "Not encrypted" everywhere.

### 2. Joining and authentication

- **Join requests**: a new computer asks to join with a name, role and device name. The hub returns a one-time
  secret to the requester. Both sides derive a 6-digit **verification code** from that secret and the certificate
  fingerprint: the requester from the certificate *it* saw, the hub from its own. The lead sees the code next to the
  request and approves only if it matches the code on the requester's screen. A mismatch means someone is in the middle.
  The lead also chooses the new member's access level. Requests lapse after 30 minutes.
- **Tokens**: each member has one random 192-bit bearer token. The hub stores only its SHA-256 hash.
  Tokens are accepted in the `Authorization` header. Browsers open the live connection with a **single-use ticket**
  valid for 60 seconds, so tokens never appear in URLs or logs.
- **Revocation**: rotating or removing a member's token takes effect on the next request and **closes their open
  connections immediately**; their agent stops, cancels a running task, and their open requests are cancelled.
- **Expiry**: a token unused for 30 days stops working (the lead can choose 7–90 days or never). The lead's own token
  is exempt because it lives on the hub machine itself (`claude-link hub --rotate-lead-token` replaces it).
- **Brute force**: 30 failed sign-ins from one address within 5 minutes block that address for the rest of the window.

### 3. Authorization (enforced by the hub, not the UI)

| Action | Lead (admin) | Developer | Viewer |
|---|---|---|---|
| Chat, DMs, read the inbox | ✓ | ✓ | ✓ |
| Ask a teammate's Claude a question (read-only) | ✓ | ✓ | ✓ |
| Request a code change (fix) | ✓ | ✓ | ✗ |
| Approve a fix | only on their own computer | only on their own computer | only on their own computer |
| Assign tasks, see the status board and audit log | ✓ | ✗ | ✗ |
| Add, remove, rotate members; change access; team settings | ✓ | ✗ | ✗ |

- Members see only names, roles and online state of others. Git branches, uncommitted files, project folders, IP
  addresses and devices are visible to the lead and to the member themself.
- Members see only their own tasks, DMs they are part of, and the team channel. The lead sees all threads (assumption 3).
- Rate limits per member: 600 API requests, 30 task requests and 60 chat messages per minute.
- Every request body is validated against a schema. IDs are positive integers; text fields have length limits.

### 4. Executing requests from teammates

This is the core boundary. It is built in one place
([`packages/cli/src/agent/policy.ts`](packages/cli/src/agent/policy.ts)) and tested on its own.

**Questions (read-only):**

- Claude Code is started with `--restricted` (ignores the owner's user, project and local settings; confines file
  tools to the working directories), `--tools Read,Grep,Glob` (no other built-in tools exist in the session),
  `--strict-mcp-config` (no MCP servers except Claude Link's read-only git server), `--permission-mode dontAsk`
  and `--permission-prompts none` (anything not pre-approved is denied, never prompted).
- Git history comes from a **read-only git MCP server** instead of shell access. It offers status, log, diff,
  show and blame with fixed options: external diff and textconv programs, fsmonitor hooks and pagers are disabled;
  revisions cannot start with `-` (so `--output=<file>` is impossible); paths must stay inside the project; secret
  files are excluded from all diffs.
- Deny rules (which override any allow rule) protect secrets wherever they are: `.env*`, `*.pem`, `*.key`, SSH keys,
  `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`, `~/.kube`, `~/.docker`, `~/.gnupg`,
  `~/.claude` and `~/.claude.json` (Claude credentials), Claude Link's data folder (the token), `.git-credentials`,
  `.npmrc`, `.netrc`. They are passed in a per-run settings file that is deleted afterwards.
- The environment is **scrubbed**: SSH agent socket, cloud and CI credentials, tokens, passwords, and URLs with
  embedded credentials are removed. What Claude Code needs to authenticate (e.g. `ANTHROPIC_API_KEY`, Bedrock/Vertex
  credentials when Claude Code is configured to use them) is kept.
- The system prompt tells Claude that the request comes from another person's AI and is untrusted.
- A timeout (15 minutes by default, at most 120) stops Claude **and everything it started**; leaving the team or
  revocation cancels it too. Answers are capped in size.
- The owner can turn off automatic answers; then each question needs a click.

**Fixes (code changes):**

- **Approval happens on the computer that runs the fix.** In the desktop app the Approve button records the
  approval locally, then informs the hub; in the terminal agent it is a `y/N` prompt. The record holds a SHA-256
  hash of the exact request (requester, target, mode, title, prompt) and a fingerprint of the execution settings
  (projects, extra tools, timeout).
- Before running, the agent checks that record. If the request text changed, the hub's approval hash differs, or
  the owner's settings changed since approving, it refuses (or asks the owner again). A fix "approved" only on the
  hub, for example in a browser, triggers a confirmation dialog on the owner's computer, and is refused if nobody confirms.
- The hub additionally requires the agent to **claim** the task with the matching approval hash, records who
  approved it and when, and logs it.
- The fix runs in **separate git worktrees** on a new branch `claude-link/task-<id>`. The owner's checkout and
  uncommitted work are not touched. *A worktree is not a security sandbox*; the boundary is the permission policy:
  - tools: Read, Grep, Glob, Edit, Write (plus Bash only if the owner configured specific commands);
  - edits are auto-accepted only inside the working directories (`acceptEdits` + `--restricted`);
  - edits to the owner's real repositories (including their `.git`), to `.git`, `.claude`, `.mcp.json`, `.husky`
    and `.vscode/tasks.json` anywhere, and to secrets are denied;
  - no web access, no other MCP servers, scrubbed environment, same secret deny rules as questions.
- Claude Link commits the result with `--no-verify` (repository hooks are code; they run when the owner commits, not on a
  teammate's request). It **never merges and never pushes**. The owner reviews the full diff in the app and merges
  it themselves if they want it.
- Extra commands for fixes (`fixAllowedTools`, e.g. `Bash(npm test:*)`) can only be set in the owner's config file,
  not from the UI, and only specific command prefixes are accepted. `Bash`, `Bash(*)` or file rules are dropped.

**My Claude (the owner's own assistant in the desktop app):** read-only regardless of the owner's own settings
(`--tools Read,Grep,Glob,WebSearch,WebFetch`); it may use the web and the team tools. The same secret deny rules
apply, because teammates' messages it reads could try to talk it into sending secrets somewhere.

### 5. Reliability controls that are also security controls

- **Exactly-once execution**: tasks are claimed atomically (`queued → running`), so a re-sent dispatch or a second
  agent process for the same person can never run a task twice.
- **No lost results**: completions are retried until the hub acknowledges them; completion is idempotent.
- **Heartbeats** in both directions detect dead connections within about a minute; agents reconnect with backoff and jitter.
- **Validated input from the hub**: agents parse and schema-check every event and ignore anything malformed.
- **One fix per repository at a time**: git worktree operations on one repository are serialised; stale worktrees are pruned.
- **Database upgrades** run in a transaction, are rolled back on failure, and keep a backup copy of `hub.db` first.

### 6. Desktop app (Electron)

- Renderer: `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`, no `<webview>`, no new windows,
  navigation locked to the app's own page, all permission requests (camera, notifications from the page, etc.) denied.
- Content-Security-Policy on the built page: scripts only from the app itself.
- The internal API (IPC) checks that each call comes from the app's own page and validates every argument.
  The UI can change only: projects, auto-answer, start at login, editor integration. It cannot change the Claude
  Code binary, extra fix tools, the hub address or the token.
- External links open in the system browser and only for `https://`.
- Settings (including the token and pinned certificate) are written atomically with owner-only permissions on
  macOS and Linux; on Windows the user-profile ACLs apply.
- Claude Link has no auto-updater and makes no network connections other than to the team server.

### 7. Hub web dashboard (CLI deployments)

Served by the hub over HTTPS with `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options:
nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` on API responses. Requests from other
websites' pages are refused (origin check), which also blocks cross-site WebSocket hijacking. Browsers warn about
the self-signed certificate; compare the fingerprint before accepting it.

### 8. Audit log

The hub records joins (with IP, device and verification code), approvals and rejections (with the approver and the
request hash), task creation and results, member and token changes, team-setting changes, and agent connections. The
lead can search it in the app. It is stored in `hub.db` on the lead's computer.

## What data can and cannot be accessed

| Who | Can access | Cannot access |
|---|---|---|
| **A teammate asking your Claude a question** | The answer your Claude writes, based on files and git history of the projects you chose to share. | Files outside those projects; secrets listed above; your other folders; your shell; changes to anything. |
| **A teammate's approved fix** | Edits in temporary copies of your shared projects; the resulting branch and diff. | Your working copy; your `.git` settings and hooks; your Claude settings; secrets; pushing or merging. |
| **The lead** | All chat, DMs, requests, answers, diffs and the audit log (stored on their computer); everyone's git status. | Running anything on your computer; approving fixes on your computer; your files. |
| **The team server (hub)** | Everything that passes through it (as the lead). | Your files; your Claude Code account; your token (it stores only a hash). |
| **Someone else on the Wi-Fi** | That a Claude Link team exists (name, lead's name, port, certificate). | Content of any traffic; tokens; joining without the lead's approval. |
| **Anthropic** | Whatever Claude Code sends while working, as with any Claude Code use: prompts and the code it reads. | Anything from Claude Link itself. |

## Residual risks

These remain after the measures above. They are listed so that a reviewer can decide whether they are acceptable.

1. **Questions disclose code by design.** Anyone on the team can ask your Claude about your shared projects, and
   prompt injection can make your Claude quote any readable file in them verbatim. Secrets inside ordinary source files
   (hard-coded keys, config files with passwords not named like the patterns above) are readable. *Mitigate:* share only
   projects the whole team may read; keep secrets out of repositories; turn off automatic answers if needed.
2. **Code goes to Anthropic.** Code Claude Code reads is sent to Anthropic's API as part of normal use. Follow your
   organisation's policy for Claude Code.
3. **No operating-system sandbox.** Claude Code runs as your user. The boundary is Claude Code's own permission system
   (`--restricted`, `--tools`, deny rules). A bug in that system, or in Claude Link's use of it, could widen access.
   Deny rules for Grep/Glob are best-effort in Claude Code. *Commands allowed through `fixAllowedTools` run repository
   code (e.g. tests) with your full user rights and are not sandboxed.* For high-assurance environments, run agents in a
   container or VM.
4. **Older Claude Code versions are weaker.** Without `--restricted`/`--tools` the boundary relies on deny rules, and
   the owner's own allow rules and hooks still apply. Keep Claude Code updated.
5. **The lead and the hub machine see everything.** Chat and diffs are stored unencrypted in `hub.db` on the lead's
   computer. The lead can read all DMs. A malicious lead cannot run fixes on your machine, but can read everything and
   send questions.
6. **Trust on first use.** If someone impersonates the hub at the exact moment you join, and nobody compares the
   verification code or fingerprint, you would pin the impostor. Members of teams created before encryption existed
   are upgraded automatically, pinning the certificate seen at that moment; compare the fingerprint in Settings with the lead's once.
7. **Bearer tokens.** A token copied from a computer works from any device until it is rotated or expires. Tokens are
   stored unencrypted in the app's settings (owner-only file) and, for the browser dashboard, in the browser's local storage.
8. **Approval fatigue.** A fix's result is only as safe as the review. Malicious changes can be subtle; review diffs
   before merging, as you would any contribution.
9. **Self-signed certificate in browsers.** Browser users must accept a certificate warning; people may click through
   without checking the fingerprint.
10. **Limits are per process.** Rate limits reset when the hub restarts.
11. **Unsigned installers.** The installers are not code-signed, so their authenticity relies on how you received them
    (build from source, or check the GitHub release).
12. **Legacy compatibility.** For older apps the WebSocket still accepts a token in its URL, and the hub can run without
    TLS when started with `--insecure-http`.

## Verification

Run everything with `npm test` (66 tests). The ones most relevant to this document:

| Claim | Test |
|---|---|
| Questions get only Read/Grep/Glob, `--restricted`, `dontAsk`, strict MCP; no shell, edits or web | `packages/cli/test/projects.test.ts` › "runs questions read-only" |
| Secrets denied (env files, SSH, cloud, Claude credentials, Claude Link token); env files never in git output | `projects.test.ts` › "keeps secrets out of reach" |
| Credentials removed from the environment | `projects.test.ts` › "does not hand teammates' requests…"; `security.test.ts` › "drops credentials" |
| Fallback for older Claude Code | `projects.test.ts` › "falls back to an explicit deny list" |
| Fixes edit only worktrees; owner's repo, `.git`, `.claude` denied; no broad allow rules | `projects.test.ts` › "bounds a fix" |
| Only specific extra commands accepted | `projects.test.ts` › "only passes specific extra commands"; `security.test.ts` › "accepts only specific extra commands" |
| Repository hooks do not run on teammates' fixes | `projects.test.ts` › "commits without running the repository's hooks" |
| Timeouts/cancellation stop Claude | `projects.test.ts` › "stops Claude when the agent is cancelled" |
| Git server refuses `--output`, path escapes, secrets (end to end over MCP) | `security.test.ts` › "read-only git server" |
| Approvals bound to the exact request and settings | `security.test.ts` › "approvals recorded on the machine that runs the fix"; `hub/test/security.test.ts` › "a fix cannot be claimed without…" |
| Hub-only approval is refused by the agent; owner confirmation runs it | `e2e.test.ts` › "refuses a fix that the hub marks approved…", "asks its owner…" |
| Impostor hub gets no token; plain HTTP serves nothing | `e2e.test.ts` › "encrypted connection" |
| Exactly-once execution; idempotent completion | `hub/test/security.test.ts` › "claimed exactly once", "completion is idempotent"; `e2e.test.ts` › "two agents" |
| Viewers cannot request fixes; lead-only actions; no second lead | `hub/test/security.test.ts` › "access levels" |
| Teammates don't see each other's git/devices | `hub/test/security.test.ts` › "teammates do not see each other's git activity" |
| Token only in header; brute-force block; idle expiry; WS tickets single-use; origin check | `hub/test/security.test.ts` › "authentication" |
| Revocation disconnects immediately and cancels work | `hub/test/security.test.ts` › "removing a member…"; `e2e.test.ts` › "a removed member's agent is cut off" |
| Reconnect after hub restart | `e2e.test.ts` › "reconnects after the hub restarts" |
| Safe database upgrade with backup | `hub/test/security.test.ts` › "database upgrades" |

The desktop app's renderer isolation, IPC validation, CSP and certificate pinning in the UI were verified by hand by
driving the built app over the DevTools protocol (see [docs/AUDIT-REPORT.md](docs/AUDIT-REPORT.md#manual-verification)).

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

- Use GitHub's **Report a vulnerability** button on the repository's **Security** tab (private advisory), or
- email the maintainer at the address in `packages/desktop/package.json` (`author`).

Include what you found, how to reproduce it, and the version (Settings shows it in the app). You will get an
acknowledgement within a few days. Please give a reasonable time to release a fix before disclosing publicly.
Claude Link is a small open-source project without a bug bounty.

Supported versions: security fixes go into the latest release only.
