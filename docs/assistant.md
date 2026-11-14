# Ask Sprout — Claude study assistant

Ask Sprout answers questions about your deadlines, courses and week. Example
questions: "Do I have a lab this week for CHEM?" or "What's my most urgent
assignment right now?" The local host calls the Claude API with the official
`@anthropic-ai/sdk`. The browser never talks to Anthropic directly and never
sees the API key.

## Setup

Users don't need their own key. The app supplies one app-wide Claude key:

1. Copy `.env.example` to `.env` in the repo root. `.env` is gitignored and never
   committed.
2. Set `ANTHROPIC_API_KEY=` to the app's key from
   [console.anthropic.com](https://console.anthropic.com/). The account behind it
   needs credits, because usage is billed there.
3. Start the app (`npm run dev` / `npm start`). The host reads `.env` at startup
   and keeps the key in memory. It never reaches the browser bundle (no `VITE_`
   prefix, and Vite is denied access to `.env`), logs, URLs or the `/api/state`
   snapshot. The UI only sees `assistant.keySource: "app"`.

Settings → Study assistant then just shows **ready**. If `.env` has no key,
or an invalid one, that card falls back to a masked field. A key saved there is
stored in the host's private `secrets.json`. The app-wide key always takes
precedence.

## What is sent to Anthropic

Every question is sent together with a context block built on the host
(`src/assistant/context.ts`). It contains:

- the current local date/time, time zone, and explicit this-week / next-week ranges;
- every task from all providers (Local, Canvas LMS, Notion): title, course, kind,
  due date, done/missing/late state, points and link. It is capped at 400 tasks,
  and the context says how many were left out;
- each provider's sync health and last snapshot time, so the assistant can say
  "Canvas isn't connected" or "this list may be stale" instead of guessing;
- the focus timer, current Spotify track and desk temperature/humidity, when available.

Device tokens, the device address and all other credentials are never sent.

"Calendar" data is whatever Canvas puts in the planner, including calendar
events. There is no separate calendar integration yet, and the assistant is told
to say so when asked about something that isn't in the data.

## Behaviour

- Model: `claude-opus-5-5`, adaptive thinking, effort `medium`, streamed.
- Server-side refusal fallback is enabled (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`). If the primary model declines a request,
  the API retries it on a fallback model within the same call.
- Read-only: it cannot add, complete or submit tasks, or change Canvas/Notion.
  Checking a task in Lil Deadline is still not a Canvas submission.
- Task titles are wrapped in tags and treated as untrusted data, not instructions.
- The conversation lives in the browser tab (sessionStorage); clearing it or
  closing the tab forgets it. The host stores no chat history.

## Local API

`POST /api/assistant/chat` (local clients only, `X-Lil-Deadline: 1`,
`Content-Type: application/json`, body ≤ 64 KB):

```json
{ "messages": [{ "role": "user", "content": "What's due this week?" }] }
```

Messages alternate user/assistant and start and end with `user`. There are at
most 40 messages, each at most 4000 characters. Bad input, or no saved key,
returns HTTP 400 with `{ "error": "..." }`. Otherwise the response is
`text/event-stream` with these events:

| event   | data                                  |
|---------|---------------------------------------|
| `open`  | `{}`                                  |
| `delta` | `{ "text": "..." }`                   |
| `done`  | `{ "stopReason": "...", "note": ... }`|
| `error` | `{ "message": "..." }`                |

Disconnecting aborts the upstream request. At most two requests run at once.

If the Claude account runs out of credits, chat shows "Ask Sprout is paused:
the Claude account behind this app is out of credits" until credits are added.

## Tests

`test/assistant.test.ts` uses an injected fake client, so the suite never calls
the real API and needs no key.
