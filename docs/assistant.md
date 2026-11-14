# Ask Sprout — Gemini study assistant

Ask Sprout answers questions about your deadlines, courses and week. Example
questions: "Do I have a lab this week for CHEM?" or "What's my most urgent
assignment right now?" The local host calls Google's Gemini API with the
official `@google/genai` SDK. The browser never talks to Google directly and
never sees the API key.

## Setup (once per computer that runs the host)

Users don't need their own key. The app supplies one app-wide Gemini key:

1. Copy `.env.example` to `.env` in the repo root. `.env` is gitignored and
   never committed.
2. Set `GEMINI_API_KEY=` to the app's key from
   [Google AI Studio](https://aistudio.google.com/).
3. Optional: set `GEMINI_MODEL=` to override the default model, `gemini-4-hydrogen`.
4. Start the app (`npm run dev` / `npm start`). The host reads `.env` at startup
   and keeps the key in memory. It never reaches the browser bundle (no `VITE_`
   prefix, and Vite is denied access to `.env`), logs, URLs or the `/api/state`
   snapshot. The UI only sees `assistant.configured: true/false`.

Settings → Study assistant shows **ready**, or "not set up" if `.env` has no
valid key. There is no per-user key field.

## What is sent to Google

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

- Model: `gemini-4-hydrogen` by default (Google's recommended fast model for new
  projects), streamed. Override it with `GEMINI_MODEL`.
- If Gemini sends nothing within 45 s, the request is cancelled and the chat
  says "Gemini didn't respond in time". Some models can stall silently.
- Blocked or safety-stopped answers show "Sprout can't help with that request".
  Answers that hit the length limit say they were cut off.
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
most 40 messages, each at most 4000 characters. Bad input, or no key configured,
returns HTTP 400 with `{ "error": "..." }`. Otherwise the response is
`text/event-stream` with these events:

| event   | data                                  |
|---------|---------------------------------------|
| `open`  | `{}`                                  |
| `delta` | `{ "text": "..." }`                   |
| `done`  | `{ "stopReason": "...", "note": ... }`|
| `error` | `{ "message": "..." }`                |

`stopReason` is Gemini's finish reason (`STOP`, `MAX_TOKENS`, `SAFETY`, …),
`BLOCKED`, or `aborted`. Disconnecting aborts the upstream request. At most two
requests run at once.

## Tests

`test/assistant.test.ts` uses an injected fake Gemini client, so the suite never
calls the real API and needs no key.
