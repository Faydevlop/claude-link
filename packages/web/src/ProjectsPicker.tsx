import { useState } from 'react';
import type { Project } from '../../shared/src/index.ts';
import { desktop } from './desktop.ts';
import { Button, cx } from './ui.tsx';

export interface ProjectSelection {
  projects: Project[];
  workspaceRoot: string | null;
}

const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+|^[A-Z]:\\Users\\[^\\]+/i, '~');

/**
 * Lets the user pick one project, or a folder holding several (each git repository inside is listed and can be
 * unticked), plus extra projects from anywhere else.
 */
export default function ProjectsPicker({ value, onChange }: { value: ProjectSelection; onChange: (v: ProjectSelection) => void }) {
  const bridge = desktop!;
  const [mode, setMode] = useState<'single' | 'multiple'>(value.projects.length > 1 || value.workspaceRoot ? 'multiple' : 'single');
  // Repositories found in the workspace folder, including unticked ones.
  const [found, setFound] = useState<Project[]>(() => value.workspaceRoot ? value.projects.filter(p => p.path.startsWith(value.workspaceRoot!)) : []);
  const [notice, setNotice] = useState('');

  const selected = new Set(value.projects.map(p => p.path));
  const extras = value.projects.filter(p => !found.some(f => f.path === p.path));
  const merge = (list: Project[]) => list.filter((p, i) => list.findIndex(q => q.path === p.path) === i);

  const pickSingle = async () => {
    setNotice('');
    const f = await bridge.pickProjectFolder();
    if (!f) return;
    if (f.isGit) { setFound([]); onChange({ projects: f.repos, workspaceRoot: null }); return; }
    if (f.repos.length) {
      setNotice(`This folder isn't a project itself, but it contains ${f.repos.length} project${f.repos.length > 1 ? 's' : ''}. Use "Several projects" to add them.`);
    } else {
      setNotice('That folder isn\'t a git repository. Choose your project\'s root folder (the one with the .git folder).');
    }
  };

  const pickWorkspace = async () => {
    setNotice('');
    const f = await bridge.pickProjectFolder();
    if (!f) return;
    if (!f.repos.length) { setNotice('No git repositories were found in that folder.'); return; }
    setFound(f.repos);
    onChange({ projects: merge([...f.repos, ...extras]), workspaceRoot: f.isGit ? null : f.path });
  };

  const addProject = async () => {
    setNotice('');
    const f = await bridge.pickProjectFolder();
    if (!f) return;
    if (!f.repos.length) { setNotice('No git repository found there.'); return; }
    onChange({ ...value, projects: merge([...value.projects, ...f.repos]) });
  };

  const toggle = (p: Project) => onChange({
    ...value,
    projects: selected.has(p.path) ? value.projects.filter(x => x.path !== p.path) : merge([...value.projects, p]),
  });

  const switchMode = (m: 'single' | 'multiple') => {
    setMode(m);
    setNotice('');
    if (m === 'single' && value.projects.length > 1) onChange({ projects: [], workspaceRoot: null });
  };

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        {([['single', 'One project', 'A single repository, e.g. just the frontend.'], ['multiple', 'Several projects', 'A folder holding several repositories, e.g. frontend + backend.']] as const).map(([m, t, d]) => (
          <button key={m} onClick={() => switchMode(m)}
            className={cx('rounded-xl border p-4 text-left', mode === m ? 'border-brand bg-brand/5' : 'border-stone-300 bg-white hover:border-stone-400 dark:border-stone-700 dark:bg-stone-900')}>
            <div className="font-medium">{t}</div>
            <div className="mt-0.5 text-xs text-stone-500">{d}</div>
          </button>
        ))}
      </div>

      {mode === 'single' ? (
        <div className="mt-4 rounded-xl border-2 border-dashed border-stone-300 p-5 text-center dark:border-stone-700">
          {value.projects[0]
            ? <><div className="font-medium">{value.projects[0].name}</div><div className="break-all font-mono text-xs text-stone-500">{shortPath(value.projects[0].path)}</div></>
            : <div className="text-sm text-stone-500">No project selected</div>}
          <Button className="mt-3" onClick={pickSingle}>{value.projects[0] ? 'Choose another…' : 'Choose project folder…'}</Button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-stone-200 p-3 dark:border-stone-800">
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">Projects folder</div>
              <div className="break-all font-mono text-xs text-stone-500">{value.workspaceRoot ? shortPath(value.workspaceRoot) : 'Not chosen'}</div>
            </div>
            <Button onClick={pickWorkspace}>{value.workspaceRoot ? 'Change…' : 'Choose folder…'}</Button>
          </div>
          {(found.length > 0 || extras.length > 0) && (
            <div className="rounded-xl border border-stone-200 dark:border-stone-800">
              <div className="border-b border-stone-200 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:border-stone-800">
                {value.projects.length} project{value.projects.length === 1 ? '' : 's'} selected
              </div>
              {found.map(p => (
                <label key={p.path} className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-stone-50 dark:hover:bg-stone-800/50">
                  <input type="checkbox" className="accent-[var(--color-brand)]" checked={selected.has(p.path)} onChange={() => toggle(p)} />
                  <span className="font-medium">{p.name}</span>
                  <span className="min-w-0 truncate font-mono text-xs text-stone-400">{shortPath(p.path)}</span>
                </label>
              ))}
              {extras.map(p => (
                <div key={p.path} className="flex items-center gap-3 px-4 py-2">
                  <span className="w-[13px]" />
                  <span className="font-medium">{p.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-stone-400">{shortPath(p.path)}</span>
                  <button className="text-xs text-stone-400 hover:text-red-600" onClick={() => toggle(p)}>Remove</button>
                </div>
              ))}
            </div>
          )}
          <button className="text-sm text-brand hover:underline" onClick={addProject}>+ Add a project from another folder</button>
        </div>
      )}
      {notice && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <span className="flex-1">{notice}</span>
          {mode === 'single' && notice.includes('Several projects') && <Button onClick={() => switchMode('multiple')}>Switch</Button>}
        </div>
      )}
    </div>
  );
}
