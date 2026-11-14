# Canvas LMS task provider — plan and verified API facts

"Canvas" here means **Canvas LMS** (Instructure). It is unrelated to the Canvas 2D
render surface. Facts below were checked against official Instructure documentation
on 2026-11-13; re-verify before implementing. Instructure is moving its docs from
`canvas.instructure.com/doc/api/` to `developerdocs.instructure.com/services/canvas`.

## Design

In Lil Deadline, Canvas setup uses a **personal access token** (often called
an API key) as its only credential. Canvas API calls also need the institution's
HTTPS domain. Enter the school Canvas website address once in Settings; after
that, replacing a token requires only the token field. The address is preserved
when a token is replaced or cleared. The app cannot derive an institution
domain from the token itself. A Canvas OAuth developer key/client ID cannot be
used as a personal access token. Changing schools requires a token for the new
school, so an existing token is never sent to a different Canvas host.

Paste the personal token directly from Canvas on one line, including `~` if
present. Do not include quotes, chat formatting, or added backslashes. The app
removes surrounding whitespace and invisible paste formatting; spaces, line
breaks, or unsupported characters inside the token produce an error without
echoing the credential. A blank replacement keeps the saved token; **Clear
token** removes it explicitly.

- **Auth: per-user personal access tokens.** Each user creates a token in Canvas and enters
  it into their own local copy of TaskPet. A school-issued OAuth developer key is not
  available, so "Sign in with Canvas" (OAuth2 + PKCE) is parked in git history at `f64a89c`
  (restore command in `src/canvas/auth.ts`). Caveat: the Canvas API Policy expects OAuth
  for apps used by multiple people, and personal tokens carry the user's full Canvas
  permissions — recommend expiry dates and a small user group until OAuth is possible.
- Runs in the **host process only**. The Canvas token never reaches the UI bundle,
  the ESP32, logs, URLs or the repo. It lives in the local secret store next to
  (but separate from) the device token.
- Implements a `TaskProvider` interface shared with the Mock provider; the UI labels
  the source (Mock / Canvas LMS) and shows "unconfigured" until set up.
- **Read-only by default.** Checking a task locally changes only local state. It
  never submits coursework, changes grades, or writes to Canvas.
- Optional, explicit opt-in later: mirror local "done" to a Canvas **planner
  override** (`marked_complete`), which changes the student's planner display only.
  Never call the Submissions API or the to-do "ignore" endpoints.
- Keeps the last good snapshot on failure; shows its age; retries with backoff.

## Verified API facts

| Topic | Fact | Source |
| --- | --- | --- |
| Auth (single user) | Student generates a token at Profile → Approved Integrations → New Access Token; it is shown once. Send as `Authorization: Bearer <token>` (query-param tokens are discouraged). | [OAuth/tokens](https://canvas.instructure.com/doc/api/file.oauth.html) |
| Auth (distributed apps) | Apps used by many users **must** use OAuth2, which needs a developer key from an institution admin. Personal tokens are for the user's own use only. | same |
| Token restrictions | Institutions can limit personal token creation; tokens may have `expires_at`. | [Permission](https://developerdocs.instructure.com/services/canvas/permissions/details/file.permissions_users_manage_access_tokens), [Access tokens](https://developerdocs.instructure.com/services/canvas/resources/access_tokens) |
| Primary endpoint | `GET /api/v1/planner/items?start_date=&end_date=&per_page=` — all the user's courses by default; `filter=incomplete_items` available. Items have `plannable_type`, `plannable_id`, `plannable`, `course_id`, `html_url`, `submissions` (status flags), `planner_override`. | [Planner](https://canvas.instructure.com/doc/api/planner.html) |
| Alternatives | `GET /api/v1/users/self/todo`; `GET /api/v1/users/self/missing_submissions`; `GET /api/v1/courses/:id/assignments?include[]=submission&bucket=upcoming&order_by=due_at`. | [Users](https://canvas.instructure.com/doc/api/users.html), [Assignments](https://canvas.instructure.com/doc/api/assignments.html) |
| Stable IDs | Planner: `plannable_type` + `plannable_id`. Assignments: `course_id` + `id`. Avoid string IDs from `upcoming_events`. | above |
| Pagination | Follow the `Link` header `rel="next"` until absent; treat links as opaque. Default page size 10; maximum unspecified. | [Pagination](https://canvas.instructure.com/doc/api/file.pagination.html) |
| Throttling | `X-Request-Cost` on responses; `X-Rate-Limit-Remaining` when throttling applies; throttled requests get **429**. Sequential requests are rarely throttled; parallel ones cost more. | [Throttling](https://canvas.instructure.com/doc/api/file.throttling.html) |
| Timestamps | ISO 8601; documented as UTC but examples show offsets: parse any offset, store UTC, display local. | [API index](https://developerdocs.instructure.com/services/canvas) |
| Base URL | The school's own Canvas host over HTTPS, e.g. `https://<school>.instructure.com/api/v1/...`. | [API index](https://canvas.instructure.com/doc/api/index.html) |
| User-Agent | Instructure announced User-Agent enforcement for API requests (dates moved during 2026); always send a descriptive one. Exact enforcement **unconfirmed**. | [Release notes 2026-05-16](https://community.instructure.com/en/discussion/665887/canvas-release-notes-2026-05-16) |
| Planner overrides | `POST /api/v1/planner/overrides` (`plannable_type`, `plannable_id`, `marked_complete`, `dismissed`); `PUT`/`DELETE /api/v1/planner/overrides/:id`. Documented as planner display state; an explicit "does not affect grades" statement was **not found**. | [Planner](https://canvas.instructure.com/doc/api/planner.html) |

## Decisions

- Personal access tokens are allowed at the user's institution and are the active auth method.
- Read-only: nothing is written to Canvas. Items submitted, excused, or marked done in Canvas
  drop off the active list on the next refresh; checking off in TaskPet stays local.
