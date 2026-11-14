# Notifications

The local host checks your tasks from every provider (Local, Canvas LMS,
Notion) on startup, whenever tasks or sync status change, and every 30 seconds.
New notifications collect under the **bell** in the header. The most urgent
unread one also shows as a banner strip along the bottom of the 240×320 display
(amber for due soon, salmon for overdue).

## Kinds (all can be switched off in Settings → Notifications)

| Kind | When | Default |
|------|------|---------|
| Due soon | 24 h and 2 h before a task's due time, e.g. "Due tomorrow: Lab 4". One per reminder; a changed due date re-arms them. | on, 24 h + 2 h |
| Overdue / missing | Past due and not done, or Canvas marks it missing. Once per task and due time (ignored after 30 days overdue). | on |
| New task | A Canvas/Notion item appears that wasn't there before (future-dated or undated). The first sync of a provider is recorded silently, so you aren't flooded. | on |
| Due date moved | A Canvas/Notion item's due date changed (shows old → new). | on |
| Busy stretch | 3 or more open tasks due within 48 h. At most once per day. | on, threshold 3 |
| Morning digest | "Today: N due · this week: M", once per day after the digest hour, only if something is due within 7 days. | on, 8 am |
| Sync problem | Canvas or Notion needs sign-in again or its refresh failed. Repeats are held back for 6 h and marked read when it recovers. | on |
| Focus finished | A 25-minute focus session ends. | on |

If more than 3 notifications of one kind arrive in a single check, they collapse
into one summary, e.g. "5 tasks are overdue". Completing, removing or
rescheduling a task clears its pending reminders. The feed keeps at most 100
items, none older than 14 days. Each source (Local, Canvas, Notion) can be
turned off separately.

## Desktop notifications

Click **Enable desktop notifications** in Settings → Notifications and allow
them in the browser prompt. `127.0.0.1` and `localhost` count as secure
contexts, so this works without HTTPS. Pop-ups appear only while a Lil Deadline
tab is open, only for items that arrive after the tab loaded, and never during
quiet hours (default 10 pm–7 am). During quiet hours items still collect under
the bell. Use **Send a test** to check that pop-ups get through. The settings
card shows honestly whether permission is granted, denied or unsupported.

## Storage

The feed and preferences are ordinary app data in `notifications.json` in the
host data directory, with a versioned schema. A corrupt or missing file falls
back to defaults. It holds no credentials. Nothing is sent to Canvas, Notion or
any other service.

## Local API

`POST /api/notifications/<action>` (local clients, `X-Lil-Deadline: 1`, JSON):
`read` `{ ids?: string[], all?: boolean }`, `dismiss` `{ id }`, `clear` `{}`,
and `prefs` `{ ...partial preferences }`. The current feed is in
`/api/state` → `notifications`.
