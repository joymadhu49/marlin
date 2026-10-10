import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

export function dataHome(platform = process.platform, env = process.env, home = homedir()) {
  if (env.MARLIN_HOME) return env.MARLIN_HOME;
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'Marlin');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Marlin');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'Marlin');
}

export function chromiumTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && ['x64', 'arm64', 'ia32'].includes(arch)) {
    return { bucket: { x64: 'Win_x64', arm64: 'Win_Arm64', ia32: 'Win' }[arch], archive: 'chrome-win.zip', directory: 'chrome-win', executable: ['chrome-win', 'chrome.exe'] };
  }
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
    return { bucket: arch === 'arm64' ? 'Mac_Arm' : 'Mac', archive: 'chrome-mac.zip', directory: 'chrome-mac', executable: ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'] };
  }
  throw new Error(`Chromium downloads are not supported on ${platform}/${arch}. Set MARLIN_CHROMIUM to a compatible Chromium executable.`);
}
