import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopEvent } from '../../../shared/src/desktop.ts';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const bridge: DesktopBridge = {
  getState: () => invoke('state:get'),
  onEvent: cb => {
    const listener = (_: unknown, e: DesktopEvent) => cb(e);
    ipcRenderer.on('desktop:event', listener);
    return () => ipcRenderer.removeListener('desktop:event', listener);
  },
  checkPrerequisites: () => invoke('setup:prereqs'),
  discoverTeams: () => invoke('setup:discover'),
  probeHub: url => invoke('setup:probe', url),
  createTeam: input => invoke('setup:createTeam', input),
  requestJoin: input => invoke('setup:requestJoin', input),
  pollJoin: () => invoke('setup:pollJoin'),
  joinWithToken: input => invoke('setup:joinWithToken', input),
  pickProjectFolder: () => invoke('setup:pickFolder'),
  updateSettings: patch => invoke('settings:update', patch),
  finishOnboarding: () => invoke('setup:finish'),
  testNotification: () => invoke('setup:testNotification'),
  leaveTeam: () => invoke('settings:leave'),
  openExternal: url => invoke('app:openExternal', url),
  myClaude: {
    list: () => invoke('myClaude:list'),
    send: input => invoke('myClaude:send', input),
    stop: id => invoke('myClaude:stop', id),
    remove: id => invoke('myClaude:remove', id),
  },
};

contextBridge.exposeInMainWorld('claudeLink', bridge);
