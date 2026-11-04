import { Command } from 'commander';

const program = new Command('claude-link')
  .description('Connect your team\'s Claude Code sessions: shared status, Claude-to-Claude requests, and team chat.')
  .version('0.3.0');

program.command('hub')
  .description('Run the team hub (team lead\'s machine). Serves the API, realtime events and web dashboard.')
  .option('-p, --port <port>', 'port to listen on', '4545')
  .option('--host <host>', 'interface to bind (0.0.0.0 = whole LAN)', '0.0.0.0')
  .option('--name <name>', 'your name, used when creating the lead account', 'Lead')
  .option('--data <dir>', 'data directory (default ~/.claude-link/hub)')
  .option('--rotate-lead-token', 'issue a new lead token (the old one stops working)')
  .option('--insecure-http', 'serve plain HTTP instead of HTTPS (not recommended: tokens travel unencrypted)')
  .action(async opts => (await import('./commands/hub.ts')).hubCommand(opts));

program.command('join')
  .description('Connect this machine to a hub and register the Claude Link MCP server with Claude Code.')
  .argument('<hub-url>', 'e.g. 192.168.1.10:4545 or https://192.168.1.10:4545')
  .requiredOption('-t, --token <token>', 'your token from the team lead')
  .option('-r, --repo <paths...>', 'your project checkout(s), where teammates\' requests run')
  .option('-w, --workspace <dir>', 'a folder holding several projects; every git repository inside is added')
  .option('--no-mcp', 'do not register the MCP server with Claude Code')
  .option('--hooks', 'also add a Claude Code hook that reports your commits as status updates')
  .option('--fingerprint <sha256>', 'expected hub certificate fingerprint (printed by the lead\'s hub); required when not interactive')
  .action(async (url, opts) => (await import('./commands/join.ts')).joinCommand(url, opts));

program.command('agent')
  .description('Stay connected so teammates\' Claudes can reach yours; runs incoming tasks and asks you to approve fixes.')
  .action(async () => (await import('./agent/agent.ts')).agentCommand());

program.command('mcp')
  .description('MCP server over stdio (started by Claude Code; you do not run this yourself).')
  .action(async () => (await import('./mcp/server.ts')).mcpCommand());

program.command('git-mcp', { hidden: true })
  .description('Read-only git MCP server used by Claude when it works for a teammate (started by Claude Link).')
  .argument('<projects-file>')
  .action(async file => (await import('./mcp/gitServer.ts')).gitMcpCommand(file));

program.command('hook')
  .description('Claude Code hook handler (installed by "join --hooks").')
  .action(async () => (await import('./commands/hook.ts')).hookCommand());

program.parseAsync().catch(e => {
  console.error(`\n  ✗ ${(e as Error).message}\n`);
  process.exit(1);
});
