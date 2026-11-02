import { existsSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve, isAbsolute } from 'node:path';
import type { Project } from '../../shared/src/index.ts';
import type { Config } from './config.ts';

const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'venv', '.venv', '__pycache__']);

export const isRepo = (dir: string) => existsSync(join(dir, '.git'));

/** Finds git repositories at or below `dir` (not inside other repositories). */
export function findRepos(dir: string, maxDepth = 3): Project[] {
  const root = resolve(dir);
  if (isRepo(root)) return [{ name: basename(root), path: root }];
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > maxDepth || found.length >= 50) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (isRepo(p)) found.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(root, 1);
  return uniqueNames(found.sort().map(p => ({ name: relative(root, p).split(/[\\/]/).join('-'), path: p })));
}

/** Project names become folder names in fix workspaces, so they must be distinct and path-safe. */
export function uniqueNames(projects: Project[]): Project[] {
  const used = new Set<string>();
  return projects.map(p => {
    const base = (p.name || basename(p.path)).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}`;
    used.add(name.toLowerCase());
    return { name, path: p.path };
  });
}

export function projectsOf(c: Pick<Config, 'projects' | 'repoPath'>): Project[] {
  const list = c.projects?.length ? c.projects : c.repoPath ? [{ name: basename(c.repoPath), path: c.repoPath }] : [];
  return list.filter(p => existsSync(p.path));
}

const inside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return !r || (!r.startsWith('..') && !isAbsolute(r));
};

/** Where Claude starts, plus extra directories it may read, so every project is reachable. */
export function workspaceFor(c: Pick<Config, 'projects' | 'repoPath' | 'workspaceRoot'>): { cwd: string; addDirs: string[]; projects: Project[] } | null {
  const projects = projectsOf(c);
  if (!projects.length) return null;
  const root = c.workspaceRoot && existsSync(c.workspaceRoot) ? c.workspaceRoot : null;
  const cwd = projects.length === 1 ? projects[0]!.path : root ?? projects[0]!.path;
  return { cwd, addDirs: projects.map(p => p.path).filter(p => !inside(p, cwd)), projects };
}

export const describeProjects = (projects: Project[]) => projects.map(p => `${p.name} (${p.path})`).join(', ');
