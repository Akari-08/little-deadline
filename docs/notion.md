# Notion read-only tasks

Lil Deadline queries a Notion **data source**, using the official
[Query a data source API](https://developers.notion.com/reference/query-a-data-source).
It pins `Notion-Version: 2026-03-11`, as documented under
[API versioning](https://developers.notion.com/reference/versioning).

Create or use a Notion connection with read access, share the data source with
that connection, then save its token and data source UUID in Lil Deadline's
Settings. The token is stored only in the host's separate `secrets.json`.
The settings screen only receives a boolean indicating whether a token is saved.

The title property supplies the task name. Optional properties are `Due` (date),
`Category` (select), and `Done` (checkbox). Other properties are ignored. Page IDs
remain stable task IDs; links are not parsed to infer identity. These values
follow Notion's [page property schema](https://developers.notion.com/reference/page-property-values).

Import uses POST `/v1/data_sources/{id}/query`; that operation reads data. This
adapter never calls page-creation or update endpoints. Checking an imported task
updates only Lil Deadline's local state. A remote Done checkbox is displayed
as a remote completion and cannot be reopened locally.

Pagination follows opaque `next_cursor` values, deduplicates page IDs, caps the
query at 100 pages, and rejects incomplete snapshots. Each response is bounded
to 4 MiB. A 30-second overall timeout bounds a refresh. Rate-limited/server-error
requests retry up to three attempts; `Retry-After` values beyond ten seconds
defer to a later refresh instead of holding the UI open. This follows the
[Notion rate-limit guidance](https://developers.notion.com/reference/request-limits).

The provider refreshes approximately every 15 minutes, with bounded backoff for
failures. Authentication failures pause automatic refreshes. Failed refreshes
leave the persisted last successful task snapshot intact. The settings screen
and task footer report unconfigured, ready, error, or auth-required state honestly.

Automated tests use simulated API responses. No real Notion workspace was used
for validation, and remote writes are not implemented.
