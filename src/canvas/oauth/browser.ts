/**
 * Open a URL in the user's default browser without a shell.
 *
 * The program and URL are passed as an argument array (no `cmd /c start`, no `sh -c`), so
 * characters such as `&`, `|` or quotes in the URL cannot be interpreted as commands. Only
 * http(s) URLs without control characters or spaces are accepted. Callers should ALWAYS also
 * show the URL so the user can paste it if no browser opens.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';

export interface BrowserCommand {
  command: string;
  args: string[];
}

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => {
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'spawn', listener: () => void): unknown;
  unref(): void;
};

export function isOpenableUrl(url: string): boolean {
  if (/[\s\x00-\x1f\x7f"<>^`{|}]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand {
  if (!isOpenableUrl(url)) throw new Error('Refusing to open a non-web address in the browser.');
  switch (platform) {
    case 'win32':
      // url.dll's FileProtocolHandler hands the URL to the default browser; no cmd.exe involved.
      return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
    case 'darwin':
      return { command: 'open', args: [url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
}

/** Resolves true if the opener process started; false if it could not (the URL should be shown anyway). */
export function openInBrowser(
  url: string,
  opts: { platform?: NodeJS.Platform; spawn?: SpawnLike } = {},
): Promise<boolean> {
  let cmd: BrowserCommand;
  try {
    cmd = browserCommand(url, opts.platform);
  } catch {
    return Promise.resolve(false);
  }
  const spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnLike);
  return new Promise(resolve => {
    try {
      const child = spawnFn(cmd.command, cmd.args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}
