import { useState, type ReactNode } from 'react';
import type { Task } from './api.ts';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export const ROLE_LABEL: Record<string, string> = {
  lead: 'Team lead', qa: 'QA', frontend: 'Frontend', backend: 'Backend', ai: 'AI', other: 'Other',
};

export function Button({ kind = 'secondary', className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  return <button {...p} className={cx(
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed',
    kind === 'primary' && 'bg-brand text-white hover:bg-brand-dark',
    kind === 'secondary' && 'border border-stone-300 bg-white hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800',
    kind === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
    kind === 'ghost' && 'hover:bg-stone-200/60 dark:hover:bg-stone-800',
    className)} />;
}

export const inputCls = 'w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 dark:border-stone-700 dark:bg-stone-900';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900', className)}>{children}</div>;
}

export function Dot({ on }: { on: boolean }) {
  return <span title={on ? 'Agent online' : 'Offline'} className={cx('inline-block size-2 shrink-0 rounded-full', on ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-stone-600')} />;
}

const STATUS_STYLE: Record<string, string> = {
  pending_approval: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  queued: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
  running: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  rejected: 'bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-400',
  failed: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  open: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300',
  in_progress: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  blocked: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  working: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  idle: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
};

export function Badge({ value }: { value: string }) {
  return <span className={cx('rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', STATUS_STYLE[value] ?? STATUS_STYLE.queued)}>{value.replace('_', ' ')}</span>;
}

export function ModeTag({ mode }: { mode: Task['mode'] }) {
  const label = mode === 'read' ? 'question' : mode === 'fix' ? 'fix' : 'assignment';
  return <span className="rounded border border-stone-300 px-1.5 text-[11px] uppercase tracking-wide text-stone-500 dark:border-stone-700">{label}</span>;
}

export function Diff({ diff }: { diff: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-lg bg-stone-950 p-3 text-xs leading-relaxed text-stone-200">
      {diff.split('\n').map((l, i) => (
        <div key={i} className={cx(
          l.startsWith('+') && !l.startsWith('+++') && 'text-emerald-400',
          l.startsWith('-') && !l.startsWith('---') && 'text-red-400',
          l.startsWith('@@') && 'text-sky-400')}>{l || ' '}</div>
      ))}
    </pre>
  );
}

export function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-lg bg-stone-950 p-3 font-mono text-xs text-stone-100">
      <code className="flex-1 break-all">{text}</code>
      <button className="shrink-0 text-stone-400 hover:text-white" onClick={() => {
        navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
      }}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-stone-500">{children}</div>;
}
