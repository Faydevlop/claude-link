import { writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Secrets that Claude must never read or change while working for a teammate, wherever they are.
 * These are Claude Code permission rules; deny rules win over any allow rule, including the user's own settings.
 */
const SECRET_FILES_ANYWHERE = [
  '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*',
  '**/.git-credentials', '**/.npmrc', '**/.pypirc', '**/.netrc', '**/.git/config',
];
const SECRET_DIRS_IN_HOME = [
  '.ssh', '.aws', '.azure', '.config/gcloud', '.config/gh', '.kube', '.docker', '.gnupg', '.password-store',
  '.claude', '.claude-link', 'Library/Keychains', 'Library/Application Support/Claude Link', 'AppData/Roaming/Claude Link',
];
const SECRET_FILES_IN_HOME = ['.claude.json', '.npmrc', '.netrc', '.git-credentials', '.bash_history', '.zsh_history'];

/** `git show HEAD:.env` and friends print a committed file directly. */
const SECRET_GIT_COMMANDS = ['Bash(git show *.env*)', 'Bash(git diff *.env*)', 'Bash(git log *.env*)'];

/**
 * Absolute paths in permission rules start with `//`. Windows paths are written in both forms Claude Code
 * has used (`//c/Users/x` and `//C:/Users/x`); a rule that matches nothing costs nothing.
 */
export function absoluteRulePaths(path: string): string[] {
  const p = resolve(path).replace(/\\/g, '/').replace(/\/+$/, '');
  const m = /^([A-Za-z]):\/(.*)$/.exec(p);
  if (!m) return [`/${p}`];
  return [...new Set([`//${m[1]!.toLowerCase()}/${m[2]}`, `//${m[1]!.toUpperCase()}:/${m[2]}`])];
}

/** Deny rules protecting secrets. Read rules also cover Grep/Glob; Edit rules cover every tool that writes files. */
export function secretDenyRules(extraDirs: string[] = []): string[] {
  const home = homedir();
  const patterns = [
    ...SECRET_FILES_ANYWHERE,
    ...SECRET_DIRS_IN_HOME.flatMap(d => [`~/${d}/**`, ...absoluteRulePaths(join(home, d)).map(p => `${p}/**`)]),
    ...SECRET_FILES_IN_HOME.flatMap(f => [`~/${f}`, ...absoluteRulePaths(join(home, f))]),
    ...extraDirs.flatMap(d => absoluteRulePaths(d).map(p => `${p}/**`)),
  ];
  return [
    ...['Read', 'Edit'].flatMap(tool => patterns.map(p => `${tool}(${p})`)),
    ...SECRET_GIT_COMMANDS,
  ];
}

// ---- environment ----

const KEEP_ALWAYS = new Set([
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'ProgramData', 'PROGRAMFILES', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);
/** Variables that grant access to other systems even though their names look harmless. */
const DROP_ALWAYS = new Set([
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GPG_AGENT_INFO', 'GNUPGHOME', 'KUBECONFIG', 'DOCKER_HOST',
  'DOCKER_CONFIG', 'NPM_CONFIG_USERCONFIG', 'GIT_SSH', 'GIT_SSH_COMMAND', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS',
]);
const SECRET_NAME = /TOKEN|SECRET|PASSW|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|SESSION|COOKIE|AUTH|_PAT$|^PAT_/i;
const CREDENTIAL_IN_URL = /:\/\/[^/\s:@]+:[^/\s@]+@/;
const SECRET_PREFIXES = /^(AWS_|AZURE_|GOOGLE_|GCLOUD_|GCP_|GITHUB_|GH_|GITLAB_|BITBUCKET_|NPM_|DIGITALOCEAN_|HEROKU_|VERCEL_|NETLIFY_|STRIPE_|OPENAI_|SLACK_|TWILIO_|SENTRY_|DATADOG_|DD_)/i;

/**
 * The environment for Claude Code when it works for a teammate: enough to run and to authenticate Claude Code
 * itself, without the other credentials a developer's shell usually carries (SSH agent, cloud keys, tokens).
 */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const bedrock = !!base.CLAUDE_CODE_USE_BEDROCK;
  const vertex = !!base.CLAUDE_CODE_USE_VERTEX;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const claudeOwn = /^(ANTHROPIC_|CLAUDE_)/.test(k) && !/^CLAUDE_LINK_/.test(k);
    const provider = (bedrock && /^AWS_/.test(k)) || (vertex && /^(GOOGLE_|CLOUD_ML_|VERTEX_|ANTHROPIC_VERTEX_)/.test(k));
    if (claudeOwn || provider || KEEP_ALWAYS.has(k)) { out[k] = v; continue; }
    if (DROP_ALWAYS.has(k) || /^CLAUDE_LINK_/.test(k) || SECRET_NAME.test(k) || SECRET_PREFIXES.test(k) || CREDENTIAL_IN_URL.test(v)) continue;
    out[k] = v;
  }
  return out;
}

let attributesFile: string | null = null;

/**
 * Environment for processes working for a teammate: secrets scrubbed, plus a git setting that marks env files
 * as binary so git diff/log/show print "Binary files differ" instead of their contents.
 */
export function protectedEnv(base: NodeJS.ProcessEnv = process.env, opts: { scrub?: boolean } = {}): NodeJS.ProcessEnv {
  if (!attributesFile) {
    attributesFile = join(tmpdir(), 'claude-link-gitattributes');
    writeFileSync(attributesFile, '.env -diff\n.env.* -diff\n*.pem -diff\n*.key -diff\n');
  }
  const env = opts.scrub === false ? { ...base } : scrubbedEnv(base);
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.attributesFile', [`GIT_CONFIG_VALUE_${n}`]: attributesFile,
    // Never let git open an interactive prompt or a pager inside a task.
    GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat',
  };
}
