/**
 * "Sign in with Canvas" from the command line (until the settings UI exists).
 *
 *   npm run canvas-login                 sign in: opens your school's Canvas login page in your browser
 *   npm run canvas-login -- status       signed in? user id, token expiry (never token values)
 *   npm run canvas-login -- logout       revoke the token at Canvas (best effort) and forget it locally
 *   npm run canvas-login -- setup        what to ask your Canvas admins for (redirect URI, scopes)
 *
 * Sign-in options: --no-browser (just print the link), --force-login, --port <n>, --no-pkce, --no-scopes
 * Logout option:   --expire-sessions (also end your Canvas web sessions in the browser)
 *
 * TaskPet never asks for your school password: you log in on your institution's own page.
 * Requires an OAuth developer key issued by your institution; see docs/canvas-oauth-setup.md.
 */
import { AppStorage } from '../src/host/storage.ts';
import { DEFAULT_REDIRECT_PORT, DEFAULT_SCOPES, loadOAuthConfig, redirectUriFor, type OAuthConfigInput } from '../src/canvas/oauth/config.ts';
import { CanvasSignInError, startCanvasSignIn } from '../src/canvas/oauth/flow.ts';
import { describeSignIn, signOutOfCanvas } from '../src/canvas/oauth/oauth-auth.ts';
import { appStorageTokenStore } from '../src/canvas/oauth/token-store.ts';
import { openInBrowser } from '../src/canvas/oauth/browser.ts';

const storage = new AppStorage();
const store = appStorageTokenStore(storage);
const args = process.argv.slice(2);
const command = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'login';
const flag = (name: string) => args.includes(`--${name}`);

function portOption(): number {
  const index = args.indexOf('--port');
  const raw = index >= 0 ? args[index + 1] : process.env.TASKPET_CANVAS_OAUTH_PORT ?? String(new AppStorage().loadSettings().canvas.oauthRedirectPort);
  if (raw === undefined || raw === '') return DEFAULT_REDIRECT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a number from 1 to 65535');
  return port;
}

function overrides(): Omit<Partial<OAuthConfigInput>, 'baseUrl' | 'clientId' | 'clientSecret'> {
  return { redirectPort: portOption(), usePkce: !flag('no-pkce'), scopes: flag('no-scopes') ? [] : DEFAULT_SCOPES };
}

const SETUP_HELP = [
  'Sign in with Canvas needs an API developer key issued by your institution\'s Canvas admins.',
  'Students cannot create one themselves. See docs/canvas-oauth-setup.md for what to request, then:',
  '  npm run configure -- canvas-url https://canvas.example.edu',
  '  npm run configure -- canvas-auth oauth2',
  '  npm run configure -- canvas-client-id <developer key ID>',
  '  npm run configure -- canvas-client-secret        (hidden prompt; skip for a public-client key)',
  'Until then you can use a personal access token instead (npm run configure -- canvas-auth personal-token).',
].join('\n');

function printSetup(): void {
  const port = portOption();
  console.log('Ask your Canvas admins for an API developer key with:');
  console.log(`  Redirect URI:  ${redirectUriFor(port)}`);
  console.log('  Scopes (if they enforce scopes):');
  for (const scope of DEFAULT_SCOPES) console.log(`    ${scope}`);
  console.log('TaskPet is read-only: it never submits coursework or changes grades.');
  console.log('Full details: docs/canvas-oauth-setup.md');
}

function printStatus(): void {
  const settings = storage.loadSettings().canvas;
  const secrets = storage.describeSecrets();
  const status = describeSignIn(store);
  console.log(`Canvas address:   ${settings.baseUrl || '(not set)'}`);
  console.log(`Auth mode:        ${settings.authMode}`);
  console.log(`OAuth client ID:  ${settings.oauthClientId || '(not set - institution must issue a developer key)'}`);
  console.log(`Client secret:    ${secrets.canvasClientSecretSet ? 'set (hidden)' : '(not set)'}`);
  console.log(`Redirect URI:     ${redirectUriFor(portOption())}`);
  if (!status.signedIn) {
    console.log('Signed in:        no');
  } else {
    console.log(`Signed in:        yes${status.userId ? ` (Canvas user id ${status.userId})` : ''}`);
    const expiry = status.expiresAt ? new Date(status.expiresAt) : null;
    console.log(`Access token:     ${expiry ? `${status.accessTokenExpired ? 'expired' : 'valid until'} ${expiry.toLocaleString()}` : 'expiry unknown'}`
      + `${status.hasRefreshToken ? ' (renews automatically)' : ''}`);
  }
  for (const warning of storage.warnings) console.warn(`Warning: ${warning}`);
}

async function login(): Promise<void> {
  const settings = storage.loadSettings().canvas;
  const resolved = loadOAuthConfig(storage, overrides());
  if (!resolved.ok) {
    for (const problem of resolved.problems) console.error(`- ${problem}`);
    console.error('');
    throw new Error(SETUP_HELP);
  }
  if (settings.authMode !== 'oauth2') {
    console.warn('Note: Canvas auth mode is "personal-token". After signing in, switch with: npm run configure -- canvas-auth oauth2');
  }
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    const session = await startCanvasSignIn({
      config: resolved.config, store, signal: controller.signal, forceLogin: flag('force-login'),
    });
    console.log('Sign in on your school\'s Canvas page in your browser. TaskPet never sees your password.');
    console.log('If no browser opens, copy this link into your browser:');
    console.log(`\n  ${session.authorizeUrl}\n`);
    if (!flag('no-browser')) {
      const opened = await openInBrowser(session.authorizeUrl);
      if (!opened) console.log('(Could not open a browser automatically; use the link above.)');
    }
    console.log(`Waiting for Canvas to send you back to ${session.redirectUri} (Ctrl+C to cancel)...`);
    const result = await session.result;
    console.log(`Signed in to Canvas${result.userId ? ` as user id ${result.userId}` : ''}.`
      + (result.hasRefreshToken ? ' The sign-in renews automatically.' : ''));
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function logout(): Promise<void> {
  const wasSignedIn = describeSignIn(store).signedIn;
  if (!wasSignedIn) { console.log('Not signed in to Canvas.'); return; }
  const resolved = loadOAuthConfig(storage, overrides());
  if (!resolved.ok) {
    store.save(null);
    console.log('Removed the saved Canvas sign-in from this computer (could not contact Canvas: OAuth is not configured).');
    console.log('You can also remove TaskPet under Canvas > Account > Settings > Approved Integrations.');
    return;
  }
  const result = await signOutOfCanvas(resolved.config, store, { expireSessions: flag('expire-sessions') });
  console.log('Removed the saved Canvas sign-in from this computer.');
  console.log(result.revoked
    ? 'Canvas confirmed the access was revoked.'
    : 'Could not confirm revocation with Canvas; remove TaskPet under Canvas > Account > Settings > Approved Integrations if it is still listed.');
  if (result.forwardUrl) console.log(`To also sign out of your school's single sign-on, open: ${result.forwardUrl}`);
}

try {
  switch (command) {
    case 'login':
    case 'sign-in':
      await login();
      break;
    case 'status':
      printStatus();
      break;
    case 'logout':
    case 'sign-out':
      await logout();
      break;
    case 'setup':
    case 'redirect-uri':
      printSetup();
      break;
    default:
      throw new Error(`Unknown command "${command}". Use: login | status | logout | setup`);
  }
} catch (error) {
  if (error instanceof CanvasSignInError && error.code === 'cancelled') console.error('Sign-in cancelled. Nothing was saved.');
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
