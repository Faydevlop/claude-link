import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stands in for Claude Code. `--help` lists the hardening flags (unless FAKE_CLAUDE_OLD is set, to act like an
 * older version). Otherwise it reports where it ran, the arguments, MCP config and environment it got, and in fix
 * mode edits backend/app.txt (or app.txt). A prompt containing HANG makes it wait until killed.
 */
const SCRIPT = String.raw`
const fs = require('fs'), { execSync } = require('child_process');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  if (!process.env.FAKE_CLAUDE_OLD) console.log('  --restricted   x\n  --tools <tools...>  x\n  --strict-mcp-config  x\n  --permission-prompts <target>  x\n  --settings <file-or-json>  x\n  (choices: "acceptEdits", "dontAsk")');
  process.exit(0);
}
let prompt = '';
process.stdin.on('data', d => prompt += d).on('end', () => {
  if (prompt.includes('HANG')) { setInterval(() => {}, 1000); return; }
  const flag = n => argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined;
  const fix = flag('--permission-mode') === 'acceptEdits';
  if (fix && !prompt.includes('KEEPSAME')) {
    const target = fs.existsSync('backend') ? 'backend/app.txt' : 'app.txt';
    fs.writeFileSync(target, 'hello fixed\n');
  }
  const mcpFile = flag('--mcp-config');
  const settings = flag('--settings') ? JSON.parse(fs.readFileSync(flag('--settings'), 'utf8')) : { permissions: { allow: [], deny: [] } };
  const out = o => console.log(JSON.stringify(o));
  out({ type: 'system', subtype: 'init', session_id: 's1' });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: 's1',
    result: JSON.stringify({
      cwd: process.cwd(), entries: fs.readdirSync('.').sort(), argv, prompt,
      addDirs: argv.flatMap((a, i) => a === '--add-dir' ? [argv[i + 1]] : []),
      allowed: [...new Set([...(flag('--allowedTools') || '').split(',').filter(Boolean), ...settings.permissions.allow])],
      disallowed: [...new Set([...(flag('--disallowedTools') || '').split(',').filter(Boolean), ...settings.permissions.deny])],
      argLength: process.argv.join(' ').length,
      tools: flag('--tools'), mode: flag('--permission-mode'),
      mcp: mcpFile && fs.existsSync(mcpFile) ? JSON.parse(fs.readFileSync(mcpFile, 'utf8')) : null,
      env: Object.keys(process.env),
      backendLog: fs.existsSync('backend') ? execSync('git -C backend log -p', { encoding: 'utf8' }) : '',
    }) });
});
`;

/** Writes the fake into `dir` and returns the path to use as `claudeBin`. */
export function installFakeClaude(dir: string): string {
  const js = join(dir, 'fake-claude.cjs');
  writeFileSync(js, SCRIPT);
  if (process.platform === 'win32') {
    const cmd = join(dir, 'fake-claude.cmd');
    writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    return cmd;
  }
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}
