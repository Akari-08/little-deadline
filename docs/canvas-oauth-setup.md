# Sign in with Canvas (Canvas LMS OAuth2) — setup

"Canvas" here means **Canvas LMS** by Instructure (coursework), not the Canvas 2D
render surface.

TaskPet can show your Canvas LMS assignments. For more than one person to use it,
the [Canvas API Policy and OAuth docs](https://canvas.instructure.com/doc/api/file.oauth.html)
require OAuth2 ("Sign in with Canvas") with a **developer key issued by the
institution's Canvas admins**. Students cannot create developer keys. Until a key
is configured, Sign in with Canvas stays **unconfigured** and TaskPet says so. A
single user can use a personal access token instead.

**TaskPet never asks for, sees or stores your school password.** You log in on your
institution's own Canvas or single sign-on page in your normal browser. Canvas then
gives TaskPet an access token limited to the permissions below. You can revoke it at
any time under **Canvas → Account → Settings → Approved Integrations**.

## What to ask your Canvas admins for

Send them this request. It is the same for any institution.

> Please create a Canvas **API developer key** (Admin → Developer Keys → + Developer Key →
> **API Key**) for TaskPet, a read-only desktop companion app that runs on the
> student's own computer.
>
> - **Key name:** TaskPet (desktop)
> - **Redirect URIs:** `http://127.0.0.1:51735/oauth/callback` (exactly this, one line)
> - **Enforce scopes:** on, with only these scopes:
>   - `url:GET|/api/v1/planner/items`
>   - `url:GET|/api/v1/courses`
>   - `url:GET|/api/v1/users/:id`
> - **Allow include parameters:** not needed.
> - **Client type:** public client with PKCE if offered; otherwise a normal confidential key.
> - Please set the key to **ON** and send me the **Client ID** (the key's numeric ID),
>   plus the **client secret** ("Show Key") if it is a confidential key.
>
> TaskPet only reads planner items, the course list and the user's own profile. It never
> submits coursework, changes grades, or writes to Canvas.

### About the redirect URI

- After you log in, Canvas sends your browser back to a small one-time receiver that
  TaskPet runs **only on your own computer** (`127.0.0.1`, port 51735). It is not
  reachable from the network. It closes as soon as sign-in finishes, is cancelled,
  or times out after 5 minutes.
- Canvas compares the redirect URI with the key's **Redirect URIs** list (exact match).
  For older keys, it also accepts a lenient match on the legacy redirect URI's scheme
  and host. Register the exact value above so either rule works.
- If port 51735 is already taken on a computer, the admins can register a second URI
  with another port. You then use `--port <n>`, or `TASKPET_CANVAS_OAUTH_PORT`, when you
  sign in. The port must be exactly the one registered.
- Canvas's documentation mentions only `urn:ietf:wg:oauth:2.0:oob` for native apps.
  The canvas-lms source accepts any registered redirect URI, including loopback. Whether
  your institution's Canvas admin UI accepts an `http://127.0.0.1` URI is
  **unconfirmed**. If it refuses, tell the TaskPet maintainers. A copy-the-code (OOB)
  fallback is not implemented yet.

### About scopes

Since late 2025, new developer keys require scopes by default. Canvas then rejects
sign-in with `invalid_scope` if TaskPet asks for a scope the key does not include.
Canvas also answers **401** for any API call outside the key's scopes. If your
admins use an **unscoped** key, sign in with `--no-scopes`.

### About the client secret

A confidential developer key has a client secret. In a desktop app, every user has a
copy of that secret, so it **cannot be kept truly secret**. Anyone with access to a
user's computer could read it. It identifies the app, not the user. TaskPet keeps it in
the per-user secrets file (outside the repository, never logged), but this risk remains.
For this reason TaskPet always uses **PKCE** (S256): an intercepted authorization code is
useless without the one-time verifier. The canvas-lms source supports PKCE and
**public-client** keys that need no secret. That would be the better choice for a
desktop app, if your institution's admin UI offers it (**unconfirmed**). Public-client
tokens follow a shorter rolling refresh window in Canvas.

## Configure and sign in

```sh
npm run configure -- canvas-url https://canvas.example.edu
npm run configure -- canvas-auth oauth2
npm run configure -- canvas-client-id <developer key ID>
npm run configure -- canvas-client-secret     # hidden prompt; skip for a public-client key

npm run canvas-login                  # opens your school's Canvas login page in your browser
npm run canvas-login -- status        # signed in? user id and token expiry (never token values)
npm run canvas-login -- logout        # revoke at Canvas (best effort) and forget locally
npm run canvas-login -- setup         # prints the redirect URI and scopes to request
```

Sign-in options:

- `--no-browser` prints the link without opening a browser. The link is always printed.
- `--force-login` shows the login form even if you are already logged in to Canvas.
- `--port <n>` uses a different registered redirect port.
- `--no-pkce` turns off PKCE.
- `--no-scopes` is for unscoped keys.

Logout option:

- `--expire-sessions` also ends your Canvas web sessions in the browser.

## How tokens are handled

- Tokens, the client secret and the PKCE verifier stay in the host process. Tokens and
  the client secret are stored in the per-user secrets file. None of them are sent to
  the UI, the ESP32, logs or URLs. Tokens go only to the configured Canvas origin over
  HTTPS, as a `Bearer` header. The token endpoint never follows redirects.
- Canvas access tokens expire after about 1 hour. TaskPet renews the token
  automatically shortly before it expires, using the refresh token. Canvas does not
  return a new refresh token for confidential keys, so TaskPet keeps the old one.
- If Canvas refuses the refresh (`invalid_grant`, or the key was disabled), TaskPet
  forgets the tokens and shows "Your Canvas sign-in expired — sign in again".
  Network problems keep the tokens and retry later.
- Logout sends `DELETE /login/oauth2/token`, then forgets the tokens even if Canvas
  could not be reached.

## Verified facts and sources (checked 2026-11-13)

| Fact | Source |
| --- | --- |
| Multi-user apps MUST use OAuth2. Keys are issued by institution admins. Tokens are like passwords. Do not pass tokens in URLs. | [file.oauth](https://canvas.instructure.com/doc/api/file.oauth.html) |
| `GET /login/oauth2/auth`: `client_id`, `response_type=code`, `redirect_uri`, `state`, `scope` (space-separated, one parameter), `purpose`, `force_login=1`, `unique_id`, `prompt=none`. | [file.oauth_endpoints](https://canvas.instructure.com/doc/api/file.oauth_endpoints.html), [developerdocs](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth_endpoints) |
| `POST /login/oauth2/token`: the `authorization_code` and `refresh_token` grants need `client_id`, `client_secret` and `redirect_uri`. The refresh reply has no new `refresh_token`. The reply includes `access_token`, `token_type`, `user`, `refresh_token`, `expires_in` (3600). | same |
| `DELETE /login/oauth2/token` logs out. `expire_sessions=1` also ends web sessions. The reply may contain `forward_url` (SSO logout). | same |
| Tokens from keys issued after Oct 2015 expire after 1 hour. | [file.oauth](https://canvas.instructure.com/doc/api/file.oauth.html) |
| Scope format is `url:<VERB>\|<path>`. Calls outside the granted scopes get 401. | [developer keys](https://developerdocs.instructure.com/services/canvas/oauth2/file.developer_keys) |
| The exact scope strings come from the endpoint pages. | [planner](https://canvas.instructure.com/doc/api/planner.html), [courses](https://canvas.instructure.com/doc/api/courses.html), [users](https://canvas.instructure.com/doc/api/users.html) |
| PKCE (S256 only), public clients, exact-or-lenient redirect matching, and error codes (`invalid_grant` 400, `invalid_client` 401) are found only in the canvas-lms **source**, not in the official docs. | [canvas-lms](https://github.com/instructure/canvas-lms) (`lib/canvas/oauth/pkce.rb`, `app/models/developer_key.rb`, `lib/canvas/oauth/request_error.rb`) |
| Scopes are required by default for new keys (Nov 2025). Shown in search summaries only. | Instructure release/deploy notes |
