import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppSnapshot } from '../src/host/application.ts';
import { NOTIFICATION_KINDS, NOTIFICATION_KIND_LABELS, SOURCE_LABELS, type NotificationItem } from '../src/notifications/rules.ts';
import './notifications.css';

type Action = (path: string, body?: Record<string, unknown>) => Promise<boolean>;
type Permission = NotificationPermission | 'unsupported';

const SHOWN_KEY = 'lil-deadline:desktop-notified';
const permissionNow = (): Permission => typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';

function readShown(): string[] {
  try { const v = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; }
  catch { return []; }
}
function rememberShown(id: string): void {
  try { localStorage.setItem(SHOWN_KEY, JSON.stringify([...readShown().filter(x => x !== id), id].slice(-200))); } catch { /* per-tab ref still dedupes */ }
}

function ago(createdAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - createdAt) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function BellIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Z"/><path d="M10 21h4"/></svg>;
}

/** Header bell: unread badge, dropdown feed, and OS/browser notifications for new items. */
export function NotificationBell({ s, action }: { s: AppSnapshot; action: Action }) {
  const n = s.notifications;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  // Only items created after this tab loaded may pop up; older ones are already in the feed.
  const baseline = useRef(s.serverNow), shown = useRef(new Set<string>());

  useEffect(() => {
    if (permissionNow() !== 'granted' || !n.prefs.desktop || n.quiet) return;
    const already = new Set(readShown());
    for (const item of [...n.items].reverse()) {
      if (item.read || !item.popup || item.createdAt <= baseline.current || shown.current.has(item.id) || already.has(item.id)) continue;
      shown.current.add(item.id); rememberShown(item.id);
      try {
        const popup = new Notification(item.title, { body: item.body, tag: item.id });
        popup.onclick = () => { window.focus(); setOpen(true); popup.close(); };
      } catch { /* some browsers only allow pop-ups from a service worker */ }
    }
  }, [n.items, n.prefs.desktop, n.quiet]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    const click = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', key); window.addEventListener('mousedown', click);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mousedown', click); };
  }, [open]);

  const markRead = (item: NotificationItem) => { if (!item.read) void action('/api/notifications/read', { ids: [item.id] }); };
  return <div className="notif-root" ref={root}>
    <button ref={button} className={`notif-bell ${n.unread ? 'has-unread' : ''}`} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Notifications, ${n.unread} unread`} onClick={() => setOpen(o => !o)}>
      <BellIcon/>{n.unread > 0 && <span className="notif-badge" aria-hidden="true">{n.unread > 99 ? '99+' : n.unread}</span>}
    </button>
    {open && <div className="notif-panel" role="dialog" aria-label="Notifications">
      <div className="notif-head"><strong>Little reminders</strong>
        <div><button className="text-button" disabled={!n.unread} onClick={() => void action('/api/notifications/read', { all: true })}>Mark all read</button>
          <button className="text-button" disabled={!n.items.length} onClick={() => void action('/api/notifications/clear')}>Clear</button></div></div>
      {n.quiet && <p className="notif-quiet">Quiet hours · pop-ups paused, reminders still collect here.</p>}
      {!n.items.length ? <p className="notif-empty">Nothing waiting. New deadlines and reminders will show up here.</p> :
        <ul className="notif-list">{n.items.map(item => <li key={item.id} className={`notif-item kind-${item.kind} ${item.read ? 'read' : ''}`}>
          <button className="notif-body" onClick={() => markRead(item)} aria-label={`${item.read ? '' : 'Unread. '}${item.title}. ${item.body}`}>
            <span className="notif-dot" aria-hidden="true"/>
            <span><strong>{item.title}</strong><span>{item.body}</span>
              <em>{NOTIFICATION_KIND_LABELS[item.kind].label}{item.provider && item.provider !== 'mock' ? ` · ${SOURCE_LABELS[item.provider]}` : ''} · {ago(item.createdAt, s.serverNow)}</em></span>
          </button>
          <div className="notif-actions">
            {item.url && <a className="icon-button" href={item.url} target="_blank" rel="noreferrer" aria-label={`Open ${item.taskTitle ?? item.title}`} onClick={() => markRead(item)}>↗</a>}
            <button className="icon-button" aria-label={`Dismiss ${item.title}`} onClick={() => void action('/api/notifications/dismiss', { id: item.id })}>×</button>
          </div>
        </li>)}</ul>}
      <p className="notif-foot">Reminders are computed on this computer from your synced tasks. Nothing is sent to Canvas or Notion.</p>
    </div>}
  </div>;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });

/** Settings card: per-rule toggles, lead times, quiet hours, desktop-notification permission. */
export function NotificationSettings({ s, action }: { s: AppSnapshot; action: Action }) {
  const prefs = s.notifications.prefs;
  const [permission, setPermission] = useState<Permission>(permissionNow);
  const [note, setNote] = useState('');
  const patch = (body: Record<string, unknown>) => void action('/api/notifications/prefs', body);

  async function enableDesktop() {
    if (permission === 'unsupported') return;
    try { setPermission(await Notification.requestPermission()); } catch { setPermission(permissionNow()); }
  }
  function test() {
    try { new Notification('Lil Deadline', { body: 'Desktop reminders are on. Sprout will nudge you before deadlines.', tag: 'lil-deadline-test' }); setNote(''); }
    catch { setNote('This browser blocked the test pop-up.'); }
  }
  async function saveTiming(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const leads = [form.get('lead1'), form.get('lead2')].map(v => String(v ?? '').trim()).filter(Boolean).map(Number);
    if (await action('/api/notifications/prefs', {
      leadTimesHours: leads, digestHour: Number(form.get('digestHour')), crunchThreshold: Number(form.get('crunch')),
      // Disabled selects are not submitted; keep the stored quiet hours then.
      ...(form.has('quietStart') ? { quietHours: { startHour: Number(form.get('quietStart')), endHour: Number(form.get('quietEnd')) } } : {}),
    })) setNote('Reminder timing saved.');
  }
  const permissionText = permission === 'granted' ? 'Desktop pop-ups allowed in this browser.' : permission === 'denied'
    ? 'Pop-ups are blocked for this site. Allow notifications in your browser’s site settings to turn them on.'
    : permission === 'unsupported' ? 'This browser does not support desktop notifications. Reminders still appear under the bell.'
    : 'Desktop pop-ups are not enabled yet.';

  return <section className="card settings-card notif-settings">
    <BellIcon/><span className="pill lilac">{s.notifications.unread} unread</span>
    <h2>Little reminders</h2>
    <p>Gentle nudges before deadlines, plus a heads-up when something changes. Computed locally from your tasks.</p>
    <div className="notif-permission">
      <span className={`notif-perm-dot perm-${permission}`}/><span>{permissionText}</span>
      {permission === 'default' && <button className="secondary" onClick={() => void enableDesktop()}>Enable desktop notifications</button>}
      {permission === 'granted' && <button className="text-button" onClick={test}>Send a test</button>}
    </div>
    <label className="notif-toggle"><input type="checkbox" checked={prefs.desktop} onChange={e => patch({ desktop: e.target.checked })}/> Show desktop pop-ups</label>
    <fieldset className="notif-fieldset"><legend>Remind me about</legend>
      {NOTIFICATION_KINDS.map(kind => <label key={kind} className="notif-toggle"><input type="checkbox" checked={prefs.enabled[kind]} onChange={e => patch({ enabled: { [kind]: e.target.checked } })}/>
        <span><strong>{NOTIFICATION_KIND_LABELS[kind].label}</strong><small>{NOTIFICATION_KIND_LABELS[kind].hint}</small></span></label>)}
    </fieldset>
    <fieldset className="notif-fieldset notif-sources"><legend>From</legend>
      {(['mock', 'canvas', 'notion'] as const).map(source => <label key={source} className="notif-toggle"><input type="checkbox" checked={prefs.sources[source]} onChange={e => patch({ sources: { [source]: e.target.checked } })}/> {source === 'mock' ? 'Local / Mock tasks' : SOURCE_LABELS[source]}</label>)}
    </fieldset>
    <form className="notif-timing" onSubmit={e => void saveTiming(e)} key={JSON.stringify(prefs)}>
      <div className="form-row">
        <label>First reminder (hours before)<input name="lead1" type="number" min={0.25} max={168} step={0.25} required defaultValue={prefs.leadTimesHours[0]}/></label>
        <label>Second reminder <span className="muted">(optional)</span><input name="lead2" type="number" min={0.25} max={168} step={0.25} defaultValue={prefs.leadTimesHours[1] ?? ''}/></label>
      </div>
      <div className="form-row">
        <label>Daily digest after<select name="digestHour" defaultValue={prefs.digestHour}>{HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></label>
        <label>Busy-stretch warning at<select name="crunch" defaultValue={prefs.crunchThreshold}>{Array.from({ length: 19 }, (_, i) => i + 2).map(v => <option key={v} value={v}>{v} deadlines / 48 h</option>)}</select></label>
      </div>
      <label className="notif-toggle"><input type="checkbox" checked={prefs.quietHours.enabled} onChange={e => patch({ quietHours: { enabled: e.target.checked } })}/> Quiet hours (no pop-ups)</label>
      <div className="form-row">
        <label>From<select name="quietStart" defaultValue={prefs.quietHours.startHour} disabled={!prefs.quietHours.enabled}>{HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></label>
        <label>Until<select name="quietEnd" defaultValue={prefs.quietHours.endHour} disabled={!prefs.quietHours.enabled}>{HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></label>
      </div>
      <button className="primary">Save reminder timing</button>
    </form>
    {note && <p className="inline-note" role="status">{note}</p>}
    <p className="fineprint">The most urgent deadline also appears as a banner on the desk screen. Times use this computer’s time zone. Keep a tab open for desktop pop-ups.</p>
  </section>;
}
