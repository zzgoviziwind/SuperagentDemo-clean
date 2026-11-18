import { parse } from 'node:path';

export const repairFile = 'fixture-value.txt';
export const repairBefore = 'before\n';
export const repairAfter = 'after\n';
export const analysisFile = '合成输入.txt';

export function offlineEnvironment(cwd: string): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return {};
  const volume = parse(cwd).root;
  return {
    USERPROFILE: cwd,
    HOMEDRIVE: volume.replace(/\\$/, ''),
    HOMEPATH: cwd.slice(volume.length - 1),
    TEMP: cwd,
    TMP: cwd,
    PATH: '',
    LOGONSERVER: 'offline',
    USERDOMAIN: 'offline',
    USERNAME: 'offline',
  };
}
