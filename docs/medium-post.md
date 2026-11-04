<!-- Draft for Medium. Image paths are relative to the repository root; each 🖼️ line marks where an image goes and its caption. -->

# My Team's Claude Codes Now Talk to Each Other

### I built Claude Link, a small desktop app that lets every developer's Claude Code ask, answer and help each other over the office Wi-Fi, without any cloud server.

---

> 🖼️ **IMAGE 1 (cover image):** `screenshots/annotated/01-status.png`
> *Caption:* The team lead's view: who is online, what each person is working on, and live git activity from every machine.

---

## The problem: five developers, five Claudes, zero shared context

I lead a small team: a frontend developer, a backend developer, a QA engineer and an AI developer, plus me. Three of us are on Windows and two on Mac. Everyone uses Claude Code every day.

Each Claude is excellent at its owner's code and knows nothing about anyone else's.

So this happens all the time:

- The frontend developer's Claude needs to know what `GET /orders` returns. It can't look at the backend code, so the developer pings the backend developer, who stops what they are doing, asks *their* Claude, and pastes the answer back into chat.
- QA finds a bug in the checkout page. They write it up, the frontend developer reads it, explains it to their Claude, and the fix starts from there.
- As the lead, I find out what everyone is doing by asking. Several times a day.

The knowledge is already sitting in each person's Claude session and repository. It just can't move between them.

## The idea: let the Claudes talk

What if my teammate's Claude could simply ask the backend developer's Claude?

Not by sharing code, not by uploading repositories to some server, and not by giving anyone access to anyone else's machine. Just a question going from one Claude to another, answered by the Claude that already knows that code, and saved where the whole team can see it.

That's **Claude Link**.

## How it works

> 🖼️ **IMAGE 2:** `docs/how-it-works.png`
> *Caption:* Everything Claude Link does stays on the office network. The only internet traffic is each person's own Claude Code talking to Anthropic, exactly as it does without Claude Link.

The design is deliberately simple:

1. **The team lead's app runs a small team server** on the lead's laptop. It keeps the chat history and the team's status in one local file.
2. **Every teammate installs the same app.** It finds the team on the office Wi-Fi by itself, and the lead approves each new computer. No tokens to copy, no IP addresses to type.
3. **When someone asks another person's Claude a question,** it goes to the team server, then to that person's computer. Their own Claude Code reads their own code and sends the answer back.
4. **Each person's Claude Code runs on their own account,** on their own machine, with their own files. Claude Link only carries the messages.

That last point matters most. Claude Link is a **messenger between Claudes**. It isn't a cloud service, it doesn't collect your code, and it doesn't open anyone's computer to the internet.

## Claude asks Claude

This is the feature that started it all.

> 🖼️ **IMAGE 3:** `screenshots/annotated/03-claude-to-claude.png`
> *Caption:* Arjun's Claude (frontend) asks Sara's Claude (backend) how pagination works. Sara's Claude reads her code and answers with the exact response shape, the file it came from, and a suggestion for the frontend.

The frontend developer types something like *"ask the backend Claude what /orders returns"*. Their Claude sends the question, the backend developer's Claude reads the backend code and answers, and the reply comes straight back into the frontend developer's session.

The backend developer doesn't have to stop what they're doing. Questions are **read-only**: the other Claude can look at the code but can't change anything.

Every one of these conversations is saved, so the next person with the same question can just scroll up.

## Asking for a fix, without losing control

Sometimes you don't want an answer, you want a change. Claude Link supports that too, carefully.

> 🖼️ **IMAGE 4:** `screenshots/annotated/04-fix-request.png`
> *Caption:* QA's Claude asks the frontend developer's Claude to fix a Safari bug. The owner approves it, and the fix is made on its own branch with a diff to review.

When someone's Claude asks for a fix on *your* machine, nothing happens until **you** approve it:

> 🖼️ **IMAGE 5:** `screenshots/annotated/09-approval.png`
> *Caption:* The owner always decides. The request shows exactly what is being asked, and nothing runs until they click Approve.

After approval, the work runs in a separate copy of the project (a git worktree) on a new branch. Your current checkout and uncommitted work are never touched, nothing is pushed, and you review the diff and merge it yourself. Not even the team lead can approve a change on someone else's computer.

> 🖼️ **IMAGE 6:** `screenshots/annotated/06-tasks.png`
> *Caption:* Every question, fix and assignment in one place, with the full diff of each fix.

## One place for the team's conversations

> 🖼️ **IMAGE 7:** `screenshots/annotated/02-chat-team.png`
> *Caption:* The team channel, direct messages and every Claude-to-Claude conversation, side by side.

Claude Link also has a plain team chat: a `#team` channel and direct messages. Human conversations and Claude conversations live next to each other, which turns out to be really useful. You can see *why* a change happened, not just that it did.

## "My Claude": your own Claude, connected to the team

Not everyone on a team lives in a terminal or VS Code, so the app has its own chat with your own Claude Code.

> 🖼️ **IMAGE 8:** `screenshots/annotated/05-my-claude.png`
> *Caption:* Ask your own Claude about the team. It uses the team tools to check everyone's status and tasks, and it's read-only.

I can ask *"What is everyone working on today? Anything blocking the release?"* and my Claude checks the team's status, open tasks and conversations, then gives me a summary. It's read-only: it reads code and talks to the team, but never edits files.

If you prefer your regular Claude Code in VS Code or the terminal, there's an optional switch that adds the same team tools there. It's off by default, so nobody's editor setup changes unless they want it to.

## The lead's view

> 🖼️ **IMAGE 9:** `screenshots/annotated/07-members.png`
> *Caption:* New computers join only after the lead approves them. Each member shows their device, IP address and project folder.

As the lead I get a status board (the cover image), a members page and an audit log:

> 🖼️ **IMAGE 10:** `screenshots/annotated/08-audit.png`
> *Caption:* Every join, question, approval and fix is recorded.

The status board turned out to be the feature I use most. It shows what each person (or their Claude) reported they're working on, their current git branch, uncommitted files and recent commits, and whether they're online right now. I ask "what are you working on?" much less often.

## Built to be safe by default

Giving AI agents a way to reach other people's machines needs care, so the defaults are conservative:

> 🖼️ **IMAGE 11:** `screenshots/annotated/10-settings.png`
> *Caption:* Questions are read-only, code changes always need the owner's approval, and the editor integration is off unless you turn it on.

- **Offline by design.** Claude Link has no cloud backend, no accounts, no telemetry and no auto-updater. All of its traffic stays on the local network.
- **Read-only questions.** A teammate's Claude can read your project but not change it.
- **Fixes need the owner's approval,** run on a separate branch, and are never pushed.
- **The lead approves every new computer,** and can remove one at any time.
- **Only the folders you choose are shared.**
- **Everything is logged** in the audit log.

To be honest about the limits:
- Traffic on the Wi-Fi is plain HTTP, so use it on a trusted office network, not public Wi-Fi.
- The code Claude Code reads goes to Anthropic, as it always does when you use Claude Code.
- The installers aren't code-signed yet, so macOS and Windows show a warning the first time.

## Getting started

> 🖼️ **IMAGE 12:** `screenshots/11-welcome.png`
> *Caption:* The whole setup: the lead creates a team, everyone else joins it.

1. Everyone installs **Claude Code** and signs in once. Claude Link uses each person's own Claude.
2. The lead installs Claude Link (`.dmg` for Mac, `.exe` for Windows) and clicks **Create a team**.
3. Teammates install it, click **Join a team**, pick the team that appears on the Wi-Fi, and wait for the lead to approve.
4. Each person picks their project folder. If you keep frontend, backend and other repositories in one folder, you can add them all at once.

That's it. No servers to rent, no configuration files, no tokens to paste around.

## How it's built

For the curious:

- **Electron** desktop app for Mac and Windows, with a **React** interface.
- A small **Fastify** server with **SQLite** (Node's built-in `node:sqlite`) for chat, tasks and status, running inside the lead's app.
- **WebSockets** for live updates, and **mDNS** so the app can find the team on the network.
- Claude Code runs headless (`claude -p`) for each request, with tool permissions set per request: read tools for questions, file edits only for approved fixes.
- An **MCP server** gives Claude the team tools: `ask_claude`, `report_status`, `get_team_status`, `send_message` and more.
- **Git worktrees** keep every fix isolated from your working copy.

## What's next

Claude Link solved a real, daily problem for my team: knowledge that already existed in five separate Claude sessions can finally move between them.

It's open source on GitHub: **https://github.com/Faydevlop/claude-link**

If your team uses Claude Code too, I'd love to hear whether this would help you, and what you'd want it to do next. Issues and pull requests are welcome.

---

*Claude Link is an independent project. It isn't made by or affiliated with Anthropic.*
