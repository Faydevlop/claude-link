import type { DesktopBridge } from '../../shared/src/desktop.ts';
export type * from '../../shared/src/desktop.ts';

/** Present only inside the desktop app. */
export const desktop: DesktopBridge | undefined = (window as unknown as { claudeLink?: DesktopBridge }).claudeLink;
