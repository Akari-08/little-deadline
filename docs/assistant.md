# Ask Sprout — Claude study assistant

Ask Sprout answers questions about your deadlines, courses and week. Example
questions: "Do I have a lab this week for CHEM?" or "What's my most urgent
assignment right now?" The local host calls the Claude API with the official
`@anthropic-ai/sdk`. The browser never talks to Anthropic directly and never
sees the API key.

## Setup

1. Create an API key at [console.anthropic.com](https://console.anthropic.com/).
2. In Lil Deadline open **Settings → Ask Sprout**, paste the key into the masked
   field and save. It is written only to the host's private `secrets.json` (see
   the data directory in the README). It is never written to the repo, `.env`,
   logs, URLs or the `/api/state` snapshot; the UI only receives
   `anthropicApiKeySet: true/false`.
3. Open **Ask Sprout** in the sidebar. Tap a suggested question or type your own.

Use **Remove key** on the same card to delete it.

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

## Tests

`test/assistant.test.ts` uses an injected fake client, so the suite never calls
the real API and needs no key.
