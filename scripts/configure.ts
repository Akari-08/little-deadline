/**
 * Local settings CLI (until the settings UI exists).
 *   npm run configure -- show
 *   npm run configure -- address 192.168.1.123        (or taskpet-xxxxxx.local)
 *   npm run configure -- token                        (masked prompt; never echoed or logged)
 *   npm run configure -- clear-token
 *   npm run configure -- fps 5
 * Canvas LMS (coursework; unrelated to the Canvas 2D render surface):
 *   npm run configure -- canvas-url https://<school>.instructure.com
 *   npm run configure -- canvas-auth personal-token   (or oauth2)
 *   npm run configure -- canvas-token                 (masked prompt; personal access token)
 *   npm run configure -- clear-canvas-token
 *   npm run configure -- canvas-client-id <id>        (OAuth2 developer key ID from your school)
 *   npm run configure -- canvas-client-secret         (masked prompt)
 * Tokens/secrets are stored in the per-user secrets file, separate from settings, outside the repo.
 */
import { AppStorage } from '../src/host/storage.ts';
import { parseDeviceAddress } from '../src/device/address.ts';
import { checkDeviceToken } from '../src/device/token.ts';
import { parseCanvasBaseUrl } from '../src/canvas/base-url.ts';

const storage = new AppStorage();
const [command, value] = process.argv.slice(2);

function show(): void {
  const settings = storage.loadSettings();
  const { deviceTokenSet } = storage.describeSecrets();
  console.log(`Data folder:   ${storage.dir}`);
  console.log(`Address:       ${settings.device.address || '(not set)'}`);
  const parsed = settings.device.address ? parseDeviceAddress(settings.device.address) : null;
  if (parsed) console.log(`Connects to:   ${parsed.ok ? parsed.value.url : `invalid - ${parsed.error}`}`);
  console.log(`Device token:  ${deviceTokenSet ? 'set (hidden)' : '(not set)'}`);
  console.log(`Target FPS:    ${settings.streaming.targetFps}`);
  const canvas = settings.canvas;
  const secrets = storage.describeSecrets();
  console.log('');
  console.log('Canvas LMS (coursework)');
  console.log(`  Address:            ${canvas.baseUrl || '(not set)'}`);
  console.log(`  Sign-in method:     ${canvas.authMode}`);
  console.log(`  Access token:       ${secrets.canvasPersonalTokenSet ? 'set (hidden)' : '(not set)'}`);
  console.log(`  OAuth client ID:    ${canvas.oauthClientId || '(not set)'}`);
  console.log(`  OAuth client secret:${secrets.canvasClientSecretSet ? ' set (hidden)' : ' (not set)'}`);
  console.log(`  OAuth signed in:    ${secrets.canvasSignedIn ? 'yes' : 'no'}`);
  console.log(`  Window:             ${canvas.lookbackDays} days back, ${canvas.lookaheadDays} days ahead; refresh every ${canvas.refreshMinutes} min`);
  for (const warning of storage.warnings) console.warn(`Warning: ${warning}`);
}

/** Read a line without echoing it. Falls back to plain stdin when not a terminal. */
function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise(resolve => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', chunk => { data += chunk; });
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''));
    });
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let input = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish(); process.stdout.write('\n'); return resolve(input);
        }
        if (char === '\u0003') { finish(); process.stdout.write('\n'); return reject(new Error('Cancelled')); }
        if (char === '\u007f' || char === '\b') input = input.slice(0, -1);
        else if (char >= ' ') input += char;
      }
    };
    const finish = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); };
    stdin.on('data', onData);
  });
}

try {
  switch (command) {
    case undefined:
    case 'show':
      show();
      break;
    case 'address': {
      const parsed = parseDeviceAddress(value ?? '');
      if (!parsed.ok) throw new Error(parsed.error);
      storage.updateSettings(s => { s.device.address = value!.trim(); });
      console.log(`Address saved. Will connect to ${parsed.value.url}`);
      if (parsed.value.isMdns) console.log('If the .local name does not resolve on this PC, use the IP from the serial log instead.');
      break;
    }
    case 'token': {
      const token = (await readSecret('Paste the device token (input hidden): ')).trim();
      const problem = checkDeviceToken(token);
      if (problem) throw new Error(problem);
      storage.saveDeviceToken(token);
      console.log(`Device token saved to ${storage.secretsPath} (not shown).`);
      break;
    }
    case 'clear-token':
      storage.saveDeviceToken(null);
      console.log('Device token removed.');
      break;
    case 'fps': {
      const fps = Number(value);
      if (!Number.isFinite(fps) || fps <= 0) throw new Error('Usage: npm run configure -- fps 5');
      const saved = storage.updateSettings(s => { s.streaming.targetFps = fps; });
      console.log(`Target FPS saved: ${saved.streaming.targetFps}`);
      break;
    }
    case 'canvas-url': {
      const parsed = parseCanvasBaseUrl(value ?? '');
      if (!parsed.ok) throw new Error(parsed.error);
      storage.updateSettings(s => { s.canvas.baseUrl = parsed.origin; });
      console.log(`Canvas address saved: ${parsed.origin}`);
      break;
    }
    case 'canvas-auth': {
      if (value !== 'personal-token' && value !== 'oauth2') throw new Error('Usage: npm run configure -- canvas-auth personal-token|oauth2');
      storage.updateSettings(s => { s.canvas.authMode = value; });
      console.log(`Canvas sign-in method saved: ${value}`);
      break;
    }
    case 'canvas-token': {
      console.log('Create a token in Canvas: Account > Settings > Approved Integrations > New Access Token. It is shown only once.');
      const token = (await readSecret('Paste the Canvas access token (input hidden): ')).trim();
      storage.saveCanvasPersonalToken(token);
      console.log(`Canvas access token saved to ${storage.secretsPath} (not shown).`);
      break;
    }
    case 'clear-canvas-token':
      storage.saveCanvasPersonalToken(null);
      console.log('Canvas access token removed. (Revoke it in Canvas too if you no longer need it.)');
      break;
    case 'canvas-client-id': {
      const id = (value ?? '').trim();
      if (!/^[!-~]{1,200}$/.test(id)) throw new Error('Usage: npm run configure -- canvas-client-id <developer key client ID>');
      storage.updateSettings(s => { s.canvas.oauthClientId = id; });
      console.log(`Canvas OAuth client ID saved: ${id}`);
      break;
    }
    case 'canvas-client-secret': {
      const secret = (await readSecret('Paste the Canvas OAuth client secret (input hidden): ')).trim();
      storage.saveCanvasOAuthClientSecret(secret);
      console.log(`Canvas OAuth client secret saved to ${storage.secretsPath} (not shown).`);
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Use: show | address <addr> | token | clear-token | fps <n> | canvas-url <url> | canvas-auth personal-token|oauth2 | canvas-token | clear-canvas-token | canvas-client-id <id> | canvas-client-secret`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
