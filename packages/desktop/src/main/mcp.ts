// Entry for the Claude Link MCP server, started by Claude Code with Electron in node mode.
import { mcpCommand } from '../../../cli/src/mcp/server.ts';

mcpCommand().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
