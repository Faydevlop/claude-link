// Entry for Claude Link's MCP servers, started by Claude Code with Electron in node mode.
//   mcp.js              → the team tools (ask a teammate's Claude, chat, status)
//   mcp.js git <file>   → read-only git for Claude while it works for a teammate
import { mcpCommand } from '../../../cli/src/mcp/server.ts';
import { gitMcpCommand } from '../../../cli/src/mcp/gitServer.ts';

const [mode, arg] = process.argv.slice(2);
(mode === 'git' && arg ? gitMcpCommand(arg) : mcpCommand()).catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
