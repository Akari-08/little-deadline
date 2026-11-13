/**
 * Validation and mapping of Canvas LMS planner items (GET /api/v1/planner/items) to RemoteTask.
 *
 * Every field is treated as untrusted: invalid items are skipped and counted, never guessed.
 *
 * Fields confirmed in the official docs (https://canvas.instructure.com/doc/api/planner.html and
 * https://developerdocs.instructure.com/services/canvas/resources/planner, checked 2026-11-13):
 *   course_id, plannable_id, plannable_type, plannable, html_url, planner_override (object/null),
 *   submissions (`false` or an object with excused, graded, late, missing, needs_grading,
 *   with_feedback). Planner notes: plannable.title, plannable.todo_date.
 * Plannable objects: Assignment has name/due_at/points_possible (assignments.html), DiscussionTopic
 * has title (discussion_topics.html), CalendarEvent has title/start_at (calendar_events.html).
 * NOT in the docs, used only when present and valid: `context_name`, `plannable_date`,
 * `submissions.submitted`, and `plannable.todo_date` on non-note types.
 */
import type { RemoteTask, RemoteTaskStatus, TaskKind } from '../tasks/types.ts';

export interface PlannerMapOptions {
  /** Canvas origin; relative html_url values are resolved against it. */
  baseUrl: string;
  /** Course id → display name, used when an item has no valid `context_name`. */
  courseNames?: ReadonlyMap<string, string>;
}

export interface PlannerMapResult {
  tasks: RemoteTask[];
  /** Items that failed validation and were left out. */
  skipped: number;
  /** Items whose key repeated an earlier item (first occurrence kept). */
  duplicates: number;
}

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Canvas ids: non-negative integers or short id-like strings (e.g. sharded "1~23"). */
export function canvasId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === 'string' && /^[A-Za-z0-9_.~:-]{1,64}$/.test(value)) return value;
  return null;
}

/** Single-line display text without control characters, or null when empty/not a string. */
export function cleanText(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** ISO 8601 timestamp with any offset (or a date-only value) → ISO 8601 UTC; otherwise null. */
export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.test(value.trim())) {
    return null;
  }
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function plannerKind(type: string): TaskKind {
  switch (type) {
    case 'assignment': return 'assignment';
    case 'quiz': return 'quiz';
    case 'discussion_topic': return 'discussion';
    case 'calendar_event':
    case 'assessment_request': return 'event';
    case 'planner_note': return 'note';
    case 'wiki_page': return 'page';
    default: return 'other';
  }
}

/** Resolve html_url against the Canvas origin; drop it if it points anywhere else. */
export function safeCanvasUrl(value: unknown, baseUrl: string): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) return null;
  try {
    const origin = new URL(baseUrl).origin;
    const url = new URL(value.trim(), origin);
    if (url.origin !== origin || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function dueDate(item: Record<string, unknown>, plannable: Record<string, unknown>, kind: TaskKind): string | null {
  const candidates: unknown[] = [plannable.due_at, plannable.todo_date];
  if (kind === 'event') candidates.push(plannable.start_at);
  candidates.push(item.plannable_date);
  for (const candidate of candidates) {
    const normalized = normalizeTimestamp(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function remoteStatus(item: Record<string, unknown>): RemoteTaskStatus {
  const submissions = isObj(item.submissions) ? item.submissions : {};
  const override = isObj(item.planner_override) ? item.planner_override : {};
  return {
    submitted: submissions.submitted === true,
    markedDone: override.marked_complete === true,
    missing: submissions.missing === true,
    late: submissions.late === true,
    graded: submissions.graded === true,
    excused: submissions.excused === true,
  };
}

/** Map one raw planner item, or null when it is not a valid planner item. */
export function mapPlannerItem(raw: unknown, options: PlannerMapOptions): RemoteTask | null {
  if (!isObj(raw)) return null;
  const type = typeof raw.plannable_type === 'string' && /^[a-z_]{1,40}$/.test(raw.plannable_type) ? raw.plannable_type : null;
  const id = canvasId(raw.plannable_id);
  if (!type || !id) return null;
  const plannable = raw.plannable === undefined || raw.plannable === null ? {} : raw.plannable;
  if (!isObj(plannable)) return null;

  const kind = plannerKind(type);
  const title = cleanText(plannable.title) ?? cleanText(plannable.name) ?? `Untitled ${kind}`;
  const courseId = canvasId(raw.course_id);
  const course = courseId === null ? null : {
    id: courseId,
    name: cleanText(raw.context_name, 120) ?? options.courseNames?.get(courseId) ?? null,
  };
  const points = typeof plannable.points_possible === 'number' && Number.isFinite(plannable.points_possible) && plannable.points_possible >= 0
    ? plannable.points_possible : null;

  return {
    key: `${type}:${id}`,
    title,
    kind,
    course,
    dueAt: dueDate(raw, plannable, kind),
    url: safeCanvasUrl(raw.html_url, options.baseUrl),
    points,
    status: remoteStatus(raw),
  };
}

/** Validate, map and de-duplicate planner items, sorted by due date (undated last), then title. */
export function mapPlannerItems(rawItems: readonly unknown[], options: PlannerMapOptions): PlannerMapResult {
  const byKey = new Map<string, RemoteTask>();
  let skipped = 0, duplicates = 0;
  for (const raw of rawItems) {
    const task = mapPlannerItem(raw, options);
    if (!task) { skipped++; continue; }
    if (byKey.has(task.key)) { duplicates++; continue; }
    byKey.set(task.key, task);
  }
  const tasks = [...byKey.values()].sort((a, b) => {
    if (a.dueAt !== b.dueAt) {
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return a.dueAt < b.dueAt ? -1 : 1;
    }
    return a.title.localeCompare(b.title);
  });
  return { tasks, skipped, duplicates };
}

/** Course list (GET /api/v1/courses) → id → name. Invalid entries are ignored. */
export function courseNameMap(rawCourses: readonly unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const raw of rawCourses) {
    if (!isObj(raw)) continue;
    const id = canvasId(raw.id);
    const name = cleanText(raw.name, 120) ?? cleanText(raw.course_code, 120);
    if (id && name && !names.has(id)) names.set(id, name);
  }
  return names;
}

/** Fill in missing course names from a course map (returns new task objects). */
export function applyCourseNames(tasks: readonly RemoteTask[], names: ReadonlyMap<string, string>): RemoteTask[] {
  return tasks.map(task => task.course && task.course.name === null && names.has(task.course.id)
    ? { ...task, course: { id: task.course.id, name: names.get(task.course.id) ?? null } }
    : task);
}
