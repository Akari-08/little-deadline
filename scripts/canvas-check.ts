/**
 * One-shot Canvas LMS check (Canvas LMS = coursework, not the Canvas 2D render surface).
 *   npm run canvas-check            (or: node scripts/canvas-check.ts)
 * Uses the saved Canvas address and personal access token (npm run configure -- canvas-url / canvas-token),
 * refreshes the planner once (read-only GET requests) and prints a summary. Never prints the token.
 * Exits non-zero when Canvas is not set up or the refresh fails.
 */
import { AppStorage } from '../src/host/storage.ts';
import { createCanvasAuth } from '../src/canvas/create-auth.ts';
import { CanvasTaskProvider } from '../src/canvas/provider.ts';
import type { RemoteTask } from '../src/tasks/types.ts';

const storage = new AppStorage();
const settings = storage.loadSettings();
for (const warning of storage.warnings) console.warn(`Warning: ${warning}`);

const provider = new CanvasTaskProvider({
  loadSettings: () => storage.loadSettings().canvas,
  createAuth: () => createCanvasAuth(storage),
});

const initial = provider.status();
if (initial.health === 'unconfigured') {
  console.error(initial.message ?? 'Canvas LMS is not set up.');
  process.exit(1);
}

console.log(`Checking Canvas LMS at ${settings.canvas.baseUrl} (read-only; ${settings.canvas.lookbackDays} days back, ${settings.canvas.lookaheadDays} days ahead)...`);

const flags = (task: RemoteTask): string => {
  const s = task.status;
  const out = [s.markedDone && 'done', s.submitted && 'submitted', s.graded && 'graded', s.missing && 'MISSING', s.late && 'late', s.excused && 'excused'];
  return out.filter(Boolean).join(', ');
};

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

try {
  const snapshot = await provider.refresh(AbortSignal.timeout(120_000));
  const status = provider.status();
  const now = Date.now();
  const tasks = snapshot.tasks;
  const upcoming = tasks.filter(t => t.dueAt !== null && Date.parse(t.dueAt) >= now);
  console.log(`Status:  ${status.health}${status.message ? ` - ${status.message}` : ''}`);
  console.log(`Items:   ${tasks.length} total, ${tasks.filter(t => t.status.markedDone).length} marked done in Canvas, ` +
    `${tasks.filter(t => t.status.submitted).length} submitted, ${tasks.filter(t => t.status.missing).length} missing, ` +
    `${upcoming.length} upcoming, ${tasks.filter(t => t.dueAt === null).length} undated`);
  if (upcoming.length) {
    console.log('\nNext up:');
    for (const task of upcoming.slice(0, 10)) {
      const course = task.course ? (task.course.name ?? `course ${task.course.id}`) : '-';
      const extra = flags(task);
      console.log(`  ${when(task.dueAt!)}  [${task.kind}] ${task.title}  (${course})${extra ? `  {${extra}}` : ''}`);
    }
  } else {
    console.log('\nNothing due in the window.');
  }
  console.log('\nNote: TaskPet only reads Canvas. Checking tasks off in TaskPet never submits work or changes anything in Canvas.');
} catch (error) {
  const status = provider.status();
  console.error(status.message ?? (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
