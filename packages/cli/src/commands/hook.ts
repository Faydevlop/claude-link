import { makeApi } from '../api.ts';
import { loadConfig } from '../config.ts';
import { git } from '../agent/git.ts';

const readStdin = async () => {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
};

/** Claude Code PostToolUse hook: reports commits as status updates. Never fails the session. */
export async function hookCommand() {
  try {
    const ev = JSON.parse(await readStdin());
    const command: string = ev?.tool_input?.command ?? '';
    if (ev?.hook_event_name !== 'PostToolUse' || ev?.tool_name !== 'Bash' || !/\bgit\b.*\bcommit\b/.test(command)) return;
    const cwd = ev.cwd ?? process.cwd();
    const [subject, branch] = await Promise.all([git(cwd, 'log', '-1', '--pretty=%s'), git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')]);
    await makeApi(loadConfig(), 'cli')('POST', '/api/status', { state: 'working', summary: `Committed on ${branch}: ${subject}` });
  } catch { /* hooks must stay silent */ }
}
