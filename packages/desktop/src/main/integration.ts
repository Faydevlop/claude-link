import { runClaudeSync } from '../../../cli/src/agent/claudeBin.ts';
import { mcpServerSpec } from './myClaude.ts';

/** Adds or removes the Claude Link tools in the user's Claude Code (VS Code extension and terminal share this config). */
export function setClaudeCodeIntegration(enabled: boolean) {
  try { runClaudeSync(['mcp', 'remove', '--scope', 'user', 'claude-link']); } catch { /* not registered */ }
  if (!enabled) return;
  const spec = mcpServerSpec();
  const env = Object.entries(spec.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  runClaudeSync(['mcp', 'add', '--scope', 'user', ...env, 'claude-link', '--', spec.command, ...spec.args]);
}
