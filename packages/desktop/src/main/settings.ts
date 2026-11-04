import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DesktopSettings } from '../../../shared/src/desktop.ts';
import { writePrivateJson } from '../../../cli/src/config.ts';

// Stored in the same shape as the CLI's config.json, so the bundled MCP server can read it via CLAUDE_LINK_HOME.
export const dataDir = () => app.getPath('userData');
const file = () => join(dataDir(), 'config.json');

let current: DesktopSettings | null = null;

export function loadSettings(): DesktopSettings | null {
  if (current) return current;
  if (!existsSync(file())) return null;
  try { current = JSON.parse(readFileSync(file(), 'utf8')) as DesktopSettings; }
  catch { current = null; }
  // Settings from before multi-project support only had repoPath.
  if (current && !current.projects) {
    current.projects = current.repoPath ? [{ name: basename(current.repoPath), path: current.repoPath }] : [];
    current.workspaceRoot = null;
  }
  return current;
}

export function saveSettings(s: DesktopSettings) {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  // Holds the team token: owner-only, written atomically.
  writePrivateJson(file(), s);
  current = s;
}

export function updateSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const s = loadSettings();
  if (!s) throw new Error('Not set up yet');
  const next = { ...s, ...patch };
  saveSettings(next);
  return next;
}

export function clearSettings() {
  rmSync(file(), { force: true });
  current = null;
}

export const newSettings = (s: Omit<DesktopSettings, 'autoApproveReads' | 'launchAtLogin' | 'claudeCodeIntegration' | 'onboarded' | 'repoPath' | 'projects' | 'workspaceRoot'>): DesktopSettings => ({
  repoPath: null, projects: [], workspaceRoot: null, autoApproveReads: true, launchAtLogin: false, claudeCodeIntegration: false, onboarded: false, ...s,
});
