import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BRAND } from '../src/branding.ts';
import type { AppSnapshot } from '../src/host/application.ts';
import type { TaskView } from '../src/tasks/store.ts';
import { mood, remainingTime } from '../src/pet/state.ts';
import { renderFace, quantizeSurface } from '../src/render/face.ts';
import { DISPLAY_SLIDES, DISPLAY_SLIDE_LABELS } from '../src/pet/slides.ts';
import { CanvasImageLoader } from './canvas-image.ts';
import { NotificationBell, NotificationSettings } from './Notifications.tsx';
import { AssistantPage, AssistantSettings } from './Assistant.tsx';

type Action = (path: string, body?: Record<string, unknown>) => Promise<boolean>;
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    leaf: <><path d="M20 3C10 2 3 6 5 14c8 3 14-3 15-11Z"/><path d="m4 21 11-12"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    camera: <><rect x="3" y="6" width="18" height="14" rx="3"/><path d="m8 6 2-3h4l2 3"/><circle cx="12" cy="13" r="4"/></>,
    settings: <><circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
    heart: <path d="M20 5a5 5 0 0 0-8 1 5 5 0 0 0-8-1c-4 5 4 11 8 15 4-4 12-10 8-15Z"/>,
    edit: <><path d="m4 16 12-12 4 4L8 20H4v-4Z"/><path d="m13 7 4 4"/></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>,
    monitor: <><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></>,
    chat: <><path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8M8 12h5"/></>,
    bell: <><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Z"/><path d="M10 21h4"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.leaf}</svg>;
}
function Ring({ done, total }: { done: number; total: number }) {
  return <svg className="progress-ring" viewBox="0 0 56 56" aria-label={`${done} of ${total} tasks complete`}><circle cx="28" cy="28" r="23" fill="none" stroke="#343a40" strokeWidth="4"/><circle cx="28" cy="28" r="23" fill="none" stroke="currentColor" strokeWidth="4" strokeDasharray={`${total ? done / total * 144.5 : 0} 144.5`} strokeLinecap="round" transform="rotate(-90 28 28)"/><text x="28" y="32" textAnchor="middle" fill="currentColor" fontSize="12">{total ? Math.round(done / total * 100) : 0}%</text></svg>;
}
function Face({ snapshot, now, action }: { snapshot: AppSnapshot; now: number; action: Action }) {
  const canvas = useRef<HTMLCanvasElement>(null), current = useRef({ snapshot, now });
  const owner = useRef(crypto.randomUUID()), [exact, setExact] = useState(true), [transportError, setTransportError] = useState('');
  current.current = { snapshot, now };
  useEffect(() => {
    const ctx = canvas.current!.getContext('2d', { alpha: false, willReadFrequently: true })!;
    const artwork = new CanvasImageLoader(), spotifyLogo = new CanvasImageLoader();
    let alive = true, animation = 0, sending = false, lastUpload = 0, lastDraw = 0;
    const render = (time: number) => {
      if (!alive) return;
      const { snapshot: s, now: clock } = current.current;
      if (time - lastDraw >= 32) {
        const task = s.tasks.find(t => t.id === s.companion.selectedId) ?? s.tasks.find(t => !t.done);
        const sensors = s.diagnostics.sensors;
        renderFace(ctx, { companion: s.companion, task: task?.title ?? null, done: s.progress.done, total: s.progress.total,
          status: s.diagnostics.live ? 'DESK COMPANION' : 'PREVIEW MODE', tasks: s.tasks.map(t => ({ title: t.title, done: t.done })),
          music: { connected: s.spotify.connected, playback: s.spotify.playback, track: s.spotify.track, artist: s.spotify.artist, volume: s.spotify.volume },
          sensors: { source: s.diagnostics.live ? sensors.source : 'unavailable', imu: sensors.imu.status, environment: sensors.environment.status,
            temperatureC: sensors.environment.status === 'live' || sensors.environment.status === 'simulated' ? sensors.latest?.environment.temperatureC ?? null : null,
            humidityPct: sensors.environment.humidity === 'live' || sensors.environment.humidity === 'simulated' ? sensors.latest?.environment.humidityPct ?? null : null,
            rssiDbm: sensors.rssi.status === 'live' || sensors.rssi.status === 'simulated' ? sensors.rssi.dbm : null },
          alert: s.notifications.banner }, clock,
          { artwork: artwork.update(s.spotify.connected ? s.spotify.artworkUrl : null, time), spotifyLogo: spotifyLogo.update('/spotify-logo.svg', time) });
        if (exact) quantizeSurface(ctx); lastDraw = time;
      }
      if (!document.hidden && s.diagnostics.connection.phase === 'ready' && !sending && time - lastUpload >= 200) {
        sending = true; lastUpload = time;
        const pixels = ctx.getImageData(0, 0, 240, 320).data;
        void fetch('/api/frame', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Lil-Deadline': '1', 'X-Renderer-Id': owner.current }, body: pixels.buffer, signal: AbortSignal.timeout(3000) })
          .then(r => { if (alive) setTransportError(r.status === 409 ? 'Another tab is sharing its preview.' : r.ok ? '' : 'Display upload paused. Retrying…'); })
          .catch(() => { if (alive) setTransportError('Local host unavailable. Display may be frozen.'); }).finally(() => { sending = false; });
      }
      animation = requestAnimationFrame(render);
    };
    animation = requestAnimationFrame(render);
    return () => { alive = false; cancelAnimationFrame(animation); artwork.dispose(); spotifyLogo.dispose(); };
  }, [exact]);
  const feeling = mood(snapshot.companion, now);
  return <section className="pet-card card">
    <div className="card-top"><span className="eyebrow">YOUR LITTLE COMPANION</span><span className="pill lilac">Level {1 + Math.floor(snapshot.companion.pet.xp / 100)}</span></div>
    <div className="device-stage"><span className="stage-star s1">✦</span><span className="stage-star s2">✧</span><div className="device-shell"><div className="device-speaker"/><canvas ref={canvas} width="240" height="320" aria-label="Sprout, your live 240 by 320 pixel companion"/><div className="device-chin"><span/><b>lil deadline</b><span/></div></div></div>
    <div className="pet-title"><h2>{BRAND.petName}</h2><span className="pill green">● {feeling}</span></div>
    <div className="slide-controls"><button aria-label="Previous display slide" onClick={() => void action('/api/display/slide', { direction: 'previous' })}>←</button><span>{DISPLAY_SLIDE_LABELS[snapshot.companion.displaySlide]} · {DISPLAY_SLIDES.indexOf(snapshot.companion.displaySlide) + 1}/{DISPLAY_SLIDES.length}</span><button aria-label="Next display slide" onClick={() => void action('/api/display/slide', { direction: 'next' })}>→</button></div>
    <p className="pet-caption">{feeling === 'celebrating' ? 'A little win deserves a little happy dance.' : 'Growing alongside you, one little win at a time.'}</p>
    <div className="pet-interactions"><button className="icon-button" aria-label="Play left with Sprout" onClick={() => void action('/api/pet', { direction: 'left' })}>←</button><button className="pet-button" onClick={() => void action('/api/pet')}><Icon name="heart" size={17}/> Say hello to {BRAND.petName}<kbd>H</kbd></button><button className="icon-button" aria-label="Play right with Sprout" onClick={() => void action('/api/pet', { direction: 'right' })}>→</button></div>
    <div className="preview-note"><label><input type="checkbox" checked={exact} onChange={e => setExact(e.target.checked)}/> RGB565 preview</label><span>240 × 320</span></div>
    {transportError && <p className="inline-note" role="status">{transportError}</p>}
  </section>;
}
function TaskEditor({ task, close, action }: { task: TaskView | null; close: () => void; action: Action }) {
  const [saving, setSaving] = useState(false);
  const date = task?.dueAt ? new Date(Date.parse(task.dueAt) - new Date(task.dueAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget); setSaving(true);
    const due = String(form.get('dueAt') ?? '');
    if (await action(task ? '/api/tasks/edit' : '/api/tasks/add', { id: task?.id, title: form.get('title'), course: form.get('course'), priority: form.get('priority'), dueAt: due ? new Date(due).toISOString() : null })) close();
    setSaving(false);
  }
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} onCancel={close}><form onSubmit={e => void submit(e)}><div className="card-top"><h2>{task ? 'A little adjustment' : 'Make room for a little win'}</h2><button type="button" className="icon-button" aria-label="Close task editor" onClick={close}>×</button></div><p className="muted">Saved on this computer · Mock / local tasks</p>
    <label>Task name<input name="title" defaultValue={task?.title} autoFocus required maxLength={300} placeholder="What would you like to work on?"/></label>
    <label>Course or category<input name="course" defaultValue={task?.course ?? ''} maxLength={120} placeholder="e.g. Design studio"/></label>
    <div className="form-row"><label>Due date <span className="muted">(optional)</span><input type="datetime-local" name="dueAt" defaultValue={date}/></label><label>Priority<select name="priority" defaultValue={task?.priority ?? 'normal'}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label></div>
    <div className="form-actions"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : task ? 'Save changes' : 'Add task'}</button></div></form></dialog>;
}
function Tasks({ s, action }: { s: AppSnapshot; action: Action }) {
  const [filter, setFilter] = useState('all'), [category, setCategory] = useState(''), [editor, setEditor] = useState<TaskView | null | undefined>(undefined);
  const visible = s.tasks.filter(t => (filter === 'all' || (filter === 'done' ? t.done : !t.done)) && (!category || t.course === category));
  useEffect(() => { setCategory(''); }, [s.companion.provider]);
  const source = s.companion.provider;
  const status = source === 'mock' ? null : s.providers[source];
  return <section className="tasks-card card"><div className="card-top"><div><span className="eyebrow">ONE THING AT A TIME</span><h2>Your little deadlines <span className="count">{s.progress.remaining}</span></h2></div><button className="primary small" onClick={() => setEditor(null)} disabled={source !== 'mock'}><Icon name="plus" size={16}/> Add task</button></div>
    <div className="task-toolbar"><div className="segmented" aria-label="Task status filter">{['all', 'active', 'done'].map(f => <button key={f} className={filter === f ? 'selected' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'All tasks' : f === 'active' ? 'To do' : 'Completed'}</button>)}</div><select aria-label="Filter by category" value={category} onChange={e => setCategory(e.target.value)}><option value="">All categories</option>{[...new Set(s.tasks.map(t => t.course).filter(Boolean))].map(c => <option key={c} value={c!}>{c}</option>)}</select></div>
    <div className="task-list">{!visible.length ? <div className="empty"><Icon name="leaf" size={32}/><h3>{status?.provider.health === 'unconfigured' ? 'Your tasks can grow here.' : 'A little breathing room.'}</h3><p>{status?.provider.health === 'unconfigured' ? 'Connect this provider in Settings, or choose local tasks below.' : 'No tasks in this view. Add one or try another filter.'}</p></div> : visible.map(t => <div className={`task-row ${t.done ? 'done' : ''} ${s.companion.selectedId === t.id ? 'focused' : ''}`} key={t.id}>
      <button className="task-check" aria-label={`${t.done ? 'Reopen' : 'Complete'} ${t.title}`} aria-pressed={t.done} disabled={t.doneReason !== null && t.doneReason !== 'checked-in-taskpet'} onClick={() => void action('/api/tasks/complete', { id: t.id, completed: !t.done })}>{t.done && <Icon name="check" size={15}/>}</button>
      <button className="task-content" onClick={() => void action('/api/select', { id: t.id })} title="Select for your companion and focus session"><strong>{t.title}</strong><span>{t.course && <em>{t.course}</em>}{t.dueAt && <span className={!t.done && Date.parse(t.dueAt) < s.serverNow ? 'overdue' : ''}>{new Date(t.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}{t.priority === 'high' && <span className="priority">↑ High</span>}{!t.course && !t.dueAt && <span>Room to go at your pace</span>}</span></button>
      {t.editable && <div className="row-actions"><button className="icon-button" aria-label={`Edit ${t.title}`} onClick={() => setEditor(t)}><Icon name="edit" size={15}/></button><button className="icon-button" aria-label={`Delete ${t.title}`} onClick={() => void action('/api/tasks/delete', { id: t.id })}><Icon name="trash" size={15}/></button></div>}
      {!t.editable && t.url && /^https?:\/\//.test(t.url) && <a className="icon-button" href={t.url} target="_blank" rel="noreferrer" aria-label={`Open ${t.title}`}><Icon name="arrow" size={16}/></a>}
    </div>)}</div>
    <div className="task-footer"><span className="source-dot"/><select aria-label="Task provider" value={source} onChange={e => void action('/api/provider', { provider: e.target.value })}><option value="mock">Mock / local tasks · demo starter set</option><option value="canvas">Canvas LMS · read-only import</option><option value="notion">Notion · read-only import</option></select>{source !== 'mock' && <button className="text-button" disabled={status?.refreshing} onClick={() => void action(`/api/sync/${source}`)}>{status?.refreshing ? 'Refreshing…' : 'Refresh'}</button>}</div>
    {status && <p className="inline-note">{status.provider.health} · {status.provider.message} {status.snapshot && `Last snapshot: ${new Date(status.snapshot.fetchedAt).toLocaleString()}.`} Checking a task here only changes local progress.</p>}
    {editor !== undefined && <TaskEditor task={editor} close={() => setEditor(undefined)} action={action}/>}
  </section>;
}
function Focus({ s, now, action }: { s: AppSnapshot; now: number; action: Action }) {
  const left = Math.ceil(remainingTime(s.companion, now) / 1000), running = s.companion.timer.startedAt !== null;
  const task = s.tasks.find(t => t.id === s.companion.selectedId) ?? s.tasks.find(t => !t.done);
  return <section className="focus-card card"><div><span className="eyebrow"><Icon name="clock" size={15}/> A LITTLE FOCUS</span><h2>Find your flow.</h2><p>{task?.title ?? 'Pick one small thing. You’ve got this.'}</p><span className="muted">{s.companion.timer.sessions} sessions completed · 25 minutes at a time</span></div><div className="focus-controls"><span className="timer" aria-label="Focus time remaining">{String(Math.floor(left / 60)).padStart(2, '0')}<i>:</i>{String(left % 60).padStart(2, '0')}</span><div><button className="lavender" onClick={() => void action('/api/timer', { action: running ? 'pause' : 'start' })}>{running ? 'Ⅱ Pause' : '▷ Start focus'}</button><button className="text-button" onClick={() => void action('/api/timer', { action: 'reset' })}>Reset</button></div></div></section>;
}
function Music({ s, action, openSettings }: { s: AppSnapshot; action: Action; openSettings: () => void }) {
  const player = s.spotify, cv = s.cvMusic;
  const enabled = player.connected;
  const control = (command: string, value?: number) => void action('/api/spotify/control', { command, value });
  return <section className="music-card card"><div className="card-top"><div><span className="eyebrow">MUSIC FOR LITTLE MOMENTS</span><h2>Spotify player</h2></div><span className="pill green">{enabled ? player.playback : 'not linked'}</span></div>
    <div className="music-track"><span className="music-note">♫</span><div><strong>{player.track ?? (enabled ? 'Nothing playing yet' : 'Make a little soundtrack')}</strong><span>{player.artist ?? (enabled ? player.device ?? 'Open Spotify on a device' : 'Connect your Spotify account in Settings')}</span></div></div>
    <a className="spotify-attribution" href={player.trackUrl ?? 'https://open.spotify.com/'} target="_blank" rel="noreferrer"><img src="/spotify-logo.svg" width="84" alt="Spotify"/><span>{player.trackUrl ? 'Open track ↗' : 'Open Spotify ↗'}</span></a>
    <div className="music-buttons"><button aria-label="Previous track" disabled={!enabled} onClick={() => control('previous')}>⏮</button><button className="music-play" aria-label={player.playback === 'playing' ? 'Pause music' : 'Play music'} disabled={!enabled} onClick={() => control('toggle')}>{player.playback === 'playing' ? 'Ⅱ' : '▶'}</button><button aria-label="Next track" disabled={!enabled} onClick={() => control('next')}>⏭</button><button aria-label="Volume down" disabled={!enabled || player.volume == null} onClick={() => control('volume', Math.max(0, (player.volume ?? 0) - 5))}>−</button><span className="music-volume">{player.volume == null ? '—' : `${Math.round(player.volume)}%`}</span><button aria-label="Volume up" disabled={!enabled || player.volume == null} onClick={() => control('volume', Math.min(100, (player.volume ?? 0) + 5))}>+</button></div>
    {!enabled && <button className="text-button" onClick={openSettings}>Set up Spotify →</button>}
    {player.message && <p className="inline-note">{player.message}</p>}
    <div className="music-cv"><div><strong>Hand gestures · ESP32 camera</strong><span>Two fingers left/right: display slides · fist: play/pause · rotate: skip · circle: volume · wave: greet</span></div><button className="secondary" onClick={() => void action(cv.phase === 'live' || cv.phase === 'starting' ? '/api/cv/stop' : '/api/cv/start')}>{cv.phase === 'live' || cv.phase === 'starting' ? 'Stop gestures' : 'Start gestures'}</button></div>
    <p className="fineprint">{cv.message}{cv.lastGesture && ` Last: ${cv.lastGesture.replace(/_/g, ' ')}.`} ESP32 frames are processed locally without recording.</p>
  </section>;
}
function Settings({ s, action }: { s: AppSnapshot; action: Action }) {
  const [message, setMessage] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>, path: string) {
    e.preventDefault(); const form = e.currentTarget, values = Object.fromEntries(new FormData(form));
    if (await action(path, values)) { (form.elements.namedItem('token') as HTMLInputElement).value = ''; setMessage('Settings saved on this computer.'); }
  }
  return <div className="settings-grid"><section className="card settings-card"><Icon name="monitor"/><h2>Your desk companion</h2><p>Connect the screen on your trusted local Wi-Fi. Preview mode is always available.</p><form onSubmit={e => void submit(e, '/api/settings/device')}>
    <label>Device address<input name="address" defaultValue={s.settings.device.address} placeholder="ws://192.168.1.123:81/" maxLength={300}/></label><label>Private device token<input name="token" type="password" autoComplete="new-password" placeholder={s.secrets.deviceTokenSet ? 'Saved · leave blank to keep' : '32–128 characters'} maxLength={128}/></label><button className="primary">Save device settings</button></form>
    <div className="connection-actions"><button className="secondary" onClick={() => void action('/api/device/connect')}>{s.diagnostics.connection.phase === 'halted' ? 'Retry connection' : 'Connect / Retry'}</button><button className="text-button" onClick={() => void action('/api/device/disconnect')}>Disconnect</button><button className="text-button" onClick={() => void action('/api/settings/device', { address: s.settings.device.address, clearToken: true })}>Clear token</button></div><p className="inline-note">{s.diagnostics.connection.phase} {s.diagnostics.connection.lastFailure && `· ${s.diagnostics.connection.lastFailure.message}`}</p><p className="fineprint">Device traffic is unencrypted and intended for trusted local Wi-Fi. Your token stays in the host’s private settings file.</p></section>
    <section className="card settings-card"><span className="integration-logo">C</span><span className="pill lilac">{s.providers.canvas.provider.health}</span><h2>Canvas LMS</h2><p>Import your coursework with a personal Canvas API token. The import is read-only.</p>
      {s.settings.canvas.baseUrl && <p className="fineprint">School: <strong>{s.settings.canvas.baseUrl}</strong></p>}
      <form onSubmit={e => void submit(e, '/api/settings/canvas')}>
        {!s.settings.canvas.baseUrl && <label>School Canvas address · needed once<input name="baseUrl" type="url" required placeholder="https://school.instructure.com"/></label>}
        <label>Personal Canvas API token<input name="token" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" required={!s.secrets.canvasPersonalTokenSet} placeholder={s.secrets.canvasPersonalTokenSet ? 'Saved · enter a new token to replace' : 'Paste your personal access token'}/></label>
        <p className="fineprint">Paste only the token, on one line. Keep the ~ character if present; do not add quotes or backslashes.</p>
        <button className="primary">Save API token</button>
      </form>
      {s.settings.canvas.baseUrl && <details className="canvas-change-school"><summary>Change school Canvas address</summary><form onSubmit={e => void submit(e, '/api/settings/canvas')}><label>New school Canvas address<input name="baseUrl" type="url" required defaultValue={s.settings.canvas.baseUrl}/></label><label>API token for this school<input name="token" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" required/></label><button className="secondary">Save school and token</button></form></details>}
      <div className="connection-actions"><button className="secondary" disabled={s.providers.canvas.refreshing || !s.settings.canvas.baseUrl || !s.secrets.canvasPersonalTokenSet} onClick={() => void action('/api/sync/canvas')}>Refresh tasks</button><button className="text-button" disabled={!s.secrets.canvasPersonalTokenSet} onClick={() => void action('/api/settings/canvas', { clearToken: true })}>Clear token</button></div>
      <p className="inline-note">{s.providers.canvas.provider.message}</p><p className="fineprint">Create a personal access token in Canvas Account → Settings → Approved Integrations. A developer key/client ID alone will not work. Your school's address is needed once; afterward only the token is needed. Local completion never submits coursework or changes grades.</p></section>
    <section className="card settings-card"><span className="integration-logo">N</span><span className="pill lilac">{s.providers.notion.provider.health}</span><h2>Notion</h2><p>Import a shared task data source. Your progress here stays local.</p><form onSubmit={e => void submit(e, '/api/settings/notion')}><label>Data source ID<input name="dataSourceId" defaultValue={s.companion.notion.dataSourceId} placeholder="Data source UUID"/></label><label>Connection token<input name="token" type="password" autoComplete="new-password" placeholder={s.secrets.notionTokenSet ? 'Saved · leave blank to keep' : 'Notion connection token'}/></label><button className="primary">Save Notion settings</button></form><div className="connection-actions"><button className="secondary" disabled={s.providers.notion.refreshing} onClick={() => void action('/api/sync/notion')}>Refresh tasks</button><button className="text-button" onClick={() => void action('/api/settings/notion', { dataSourceId: s.companion.notion.dataSourceId, clearToken: true })}>Clear token</button></div><p className="fineprint">Share the data source with your connection. Uses its title plus optional Due (date), Category (select), and Done (checkbox) properties. Remote writes are disabled.</p></section>
    <section className="card settings-card"><span className="integration-logo">♫</span><span className="pill lilac">{s.spotify.connected ? 'linked' : 'unconfigured'}</span><h2>Spotify music</h2><p>Register this exact redirect URI in your Spotify developer app:</p><code className="redirect-uri">{`${location.origin.replace('localhost', '127.0.0.1')}/api/spotify/callback`}</code><p className="fineprint">Open Lil Deadline at 127.0.0.1 for account linking. Enter your app’s Client ID, then authorize playback controls.</p>
      <form onSubmit={e => { e.preventDefault(); const value = String(new FormData(e.currentTarget).get('clientId') ?? ''); void action('/api/settings/spotify', { clientId: value }); }}><label>Spotify Client ID<input name="clientId" defaultValue={s.settings.spotify.clientId} maxLength={32} pattern="[a-fA-F0-9]{32}" placeholder="32-character Client ID"/></label><button className="primary">Save Client ID</button></form>
      <div className="connection-actions"><button className="secondary" disabled={!s.spotify.configured} onClick={async () => { try { const response = await fetch('/api/spotify/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lil-Deadline': '1' }, body: '{}'}); const data = await response.json(); if (!response.ok) throw new Error(data.error); window.location.assign(data.url); } catch { setMessage('Could not start Spotify linking. Check the Client ID and local host.'); } }}>{s.spotify.connected ? 'Reconnect Spotify' : 'Link Spotify account'}</button><button className="text-button" disabled={!s.spotify.connected} onClick={() => void action('/api/spotify/disconnect')}>Disconnect Spotify</button></div><p className="fineprint">Spotify Premium and an active playback device are required. The app uses PKCE and stores access tokens only in the local host secret file. No client secret is needed.</p></section>
    <NotificationSettings s={s} action={action}/>
    <AssistantSettings s={s} action={action}/>
    <section className="card settings-card"><Icon name="leaf"/><h2>A fresh little start</h2><p>Reset the Mock provider to four demo tasks. Canvas and Notion snapshots are retained.</p><button className="secondary" onClick={() => void action('/api/tasks/reset')}>Restore demo tasks</button><p className="fineprint">Mouse controls are available throughout. Press H to greet Sprout, ← / → to play, and Space to start or pause focus. Shortcuts stay inactive while typing.</p></section>
    {message && <p role="status">{message}</p>}
  </div>;
}
function Camera({ s, action }: { s: AppSnapshot; action: Action }) {
  const [viewing, setViewing] = useState(false), [attempt, setAttempt] = useState(0), [failed, setFailed] = useState(false);
  const configured = !!s.settings.device.address && s.secrets.deviceTokenSet;
  const gesturesOn = s.cvMusic.phase === 'live' || s.cvMusic.phase === 'starting';
  const resolution = s.camera.width && s.camera.height ? `${s.camera.width} × ${s.camera.height} native` : 'ESP32 camera';
  return <section className="camera-card card">
    <div className="card-top"><div><span className="eyebrow">A WINDOW TO YOUR DESK</span><h2>Companion camera</h2></div><span className="pill lilac">{resolution}</span></div>
    <div className="camera-view">{viewing && !failed ? <>
      <img key={attempt} src={`/api/camera/stream?view=${attempt}`} alt="Live ESP32 camera feed" onError={() => setFailed(true)}/>
      {s.camera.phase === 'loading' && <span className="camera-loading">Opening camera…</span>}
    </> : <div className="empty"><Icon name="camera" size={42}/><h3>{failed ? 'The camera needs a moment.' : 'Your desk, from a little closer.'}</h3><p>{failed ? s.camera.phase === 'error' ? s.camera.message : 'Could not open the camera. Check settings or close the viewer in another tab.' : 'Turn on the ESP32 camera when you’d like a look around.'}</p></div>}</div>
    <div className="connection-actions">
      <button className="primary" disabled={!configured} onClick={() => { setFailed(false); setAttempt(a => a + 1); setViewing(true); }}>{failed ? 'Retry camera' : viewing ? 'Reconnect camera' : 'Open camera'}</button>
      <button className="secondary" disabled={!viewing} onClick={() => setViewing(false)}>Stop viewing</button>
      <button className="secondary" disabled={!configured && !gesturesOn} onClick={() => void action(gesturesOn ? '/api/cv/stop' : '/api/cv/start')}>{gesturesOn ? 'Stop gestures' : 'Start gestures'}</button>
      <span className="muted">{s.camera.message}{s.camera.phase === 'live' && s.camera.deliveredFps !== null && ` · ${s.camera.deliveredFps.toFixed(1)} fps`}</span>
    </div>
    <p className="fineprint">{s.cvMusic.message} Two fingers left/right: slides · fist: play/pause · rotate: skip · circle: volume · wave: greet.</p>
    <p className="fineprint">Preview and gestures share one ESP32 feed. Stopping the preview leaves active gestures running. Video scales smoothly to fit; the badge shows captured pixels. No recording or facial recognition.</p>
    {s.camera.width !== null && s.camera.width < 800 && <p className="inline-note">The camera is sending {s.camera.width} × {s.camera.height}. Install the updated ESP firmware for 800 × 600 capture.</p>}
    {!configured && <p className="inline-note">Add your device address and token in Settings to use the camera.</p>}
  </section>;
}
function Diagnostics({ s }: { s: AppSnapshot }) {
  const d = s.diagnostics, st = d.stream, sensors = d.sensors;
  const val = (v: number | null | undefined, unit: string) => v == null ? 'Unavailable' : `${v.toFixed(1)} ${unit}`;
  return <details className="diagnostics"><summary><Icon name="monitor" size={15}/> Behind the little screen <span>Diagnostics</span></summary><div className="diagnostic-grid">{[
    ['Connection', d.connection.phase], ['Source', sensors.source === 'simulated' ? 'SIMULATED device' : d.live ? 'Physical link' : 'Preview / unavailable'], ['Target / delivered', `5 / ${st.deliveredFps?.toFixed(1) ?? '—'} fps`], ['ACK latency', val(st.ackLatencyMs?.last, 'ms')], ['Device draw', val(st.drawMs?.last, 'ms')], ['Last ACK', val(st.lastAckAgeMs, 'ms ago')], ['Telemetry receipt age', val(sensors.receiptAgeMs, 'ms')], ['Wi-Fi signal', `${val(sensors.rssi.dbm, 'dBm')} · ${sensors.rssi.status}`], ['IMU', `${sensors.imu.status} · ${val(sensors.imu.deviceAgeMs, 'ms sample age')}`], ['Environment', `${sensors.environment.status} · ${val(sensors.environment.deviceAgeMs, 'ms sample age')}`], ['Temperature', val(sensors.latest?.environment.temperatureC, '°C')], ['Pressure (absolute)', val(sensors.latest?.environment.pressureHpa, 'hPa')], ['Humidity', val(sensors.latest?.environment.humidityPct, '%')], ['Button', sensors.button.status], ['Renderer', s.render.fresh ? 'Recent complete render' : 'No recent render'], ['Frames ACKed / failed', `${st.framesAcked} / ${st.framesFailed}`],
  ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><p>External sensors and the physical button are not connected; unavailable readings are expected. An ACK confirms a driver write, not an optical screen check. Keep the dashboard visible to stream its canvas.</p>{(d.connection.lastFailure || st.lastError) && <p className="error">{d.connection.lastFailure?.message ?? st.lastError}</p>}</details>;
}
export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null), [error, setError] = useState(''), [online, setOnline] = useState(false), [page, setPage] = useState('dashboard'), [now, setNow] = useState(Date.now());
  const offset = useRef(0), mounted = useRef(true);
  function receive(s: AppSnapshot) { offset.current = s.serverNow - Date.now(); setSnapshot(s); setOnline(true); }
  useEffect(() => {
    const spotifyResult = new URLSearchParams(window.location.search).get('spotify');
    if (spotifyResult === 'error') setError('Spotify sign-in did not finish. Retry from Settings and check the registered redirect URI.');
    if (spotifyResult === 'connected' || spotifyResult === 'error') setPage('settings');
    if (spotifyResult) history.replaceState(null, '', '/');
    mounted.current = true; let timer: ReturnType<typeof setTimeout>, stopped = false;
    const poll = async () => {
      try { const r = await fetch('/api/state', { signal: AbortSignal.timeout(4000) }); if (!r.ok) throw new Error(); const s = await r.json() as AppSnapshot; if (!stopped) receive(s); }
      catch { if (!stopped) setOnline(false); }
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    void poll(); const clock = setInterval(() => setNow(Date.now() + offset.current), 50);
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); clearInterval(clock); };
  }, []);
  const action: Action = async (path, body = {}) => {
    try { const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lil-Deadline': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) }); const data = await r.json(); if (!r.ok) throw new Error(data.error ?? 'Could not save change.'); if (mounted.current) { receive(data as AppSnapshot); setError(''); } return true; }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'The local host is unavailable.'); return false; }
  };
  const actions = useRef({ action, snapshot }); actions.current = { action, snapshot };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.target as HTMLElement).closest('input,textarea,select,button,a,[contenteditable],dialog') || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      if (['h', 'H', 'ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); void actions.current.action('/api/pet', { direction: e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : 'center' }); }
      if (e.code === 'Space' && actions.current.snapshot) { e.preventDefault(); void actions.current.action('/api/timer', { action: actions.current.snapshot.companion.timer.startedAt === null ? 'start' : 'pause' }); }
      if (e.key === '[' || e.key === ']' || e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); void actions.current.action('/api/display/slide', { direction: e.key === '[' || e.key === 'PageUp' ? 'previous' : 'next' }); }
    }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const s = snapshot, live = !!s?.diagnostics.live && online, ack = s?.diagnostics.stream.lastAckAgeMs;
  const streaming = live && s?.render.fresh && ack != null && ack < 2000;
  return <><header className="site-header"><a href="#" className="brand" onClick={e => { e.preventDefault(); setPage('dashboard'); }}><span className="brand-icon"><Icon name="leaf" size={24}/></span>{BRAND.name}<span className="brand-tag">a softer kind of productivity</span></a><div className="header-right">{s && <NotificationBell s={s} action={action}/>}<span className={`connection-badge ${streaming ? 'connected' : ''}`}><span/>{!online && s ? 'Host disconnected' : streaming ? s?.diagnostics.sensors.source === 'simulated' ? 'Simulated display' : 'Display live' : live ? 'Display may be frozen' : 'Preview mode'}</span><button className="avatar" onClick={() => setPage('settings')} aria-label="Open local settings">LD</button></div></header>
    <div className="app-layout"><nav className="sidebar" aria-label="Main navigation">{[['dashboard', 'grid', 'Your day'], ['assistant', 'chat', 'Ask Sprout'], ['camera', 'camera', 'Camera'], ['settings', 'settings', 'Settings']].map(([id, icon, label]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id!)} aria-current={page === id ? 'page' : undefined}><Icon name={icon!}/><span>{label}</span></button>)}<div className="sidebar-bottom"><Icon name="leaf"/><span>little by little</span></div></nav>
    <main><div className="page-heading"><div><div className="eyebrow">YOUR OWN LITTLE CORNER</div><h1>{page === 'dashboard' ? 'Good things grow slowly.' : page === 'assistant' ? 'Ask me anything.' : page === 'camera' ? 'A little perspective.' : 'Make yourself at home.'}</h1><p>{page === 'dashboard' ? 'Settle in, take a breath, and give one small thing your attention.' : page === 'assistant' ? 'Questions about your deadlines, courses and week, answered from your synced tasks.' : page === 'camera' ? 'A live view from your companion’s corner of the world.' : 'Your companion, your connections, your pace.'}</p></div><span className="today-date">{new Date(now).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span></div>
      {error && <div className="alert" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {!online && <div className="alert" role="status">{s ? 'The local host is disconnected. Changes and display streaming will resume when it returns.' : 'Connecting to your local companion…'}</div>}
      {!s ? <div className="loading-card card"><Icon name="leaf" size={40}/><h2>Finding your little corner…</h2><p>Start the local host with npm run dev.</p></div> : <>
        <div hidden={page !== 'dashboard'}><div className="stats-row"><div className="stat card"><Ring done={s.progress.done} total={s.progress.total}/><div><span>Today’s little wins</span><strong>{s.progress.done}<small> / {s.progress.total} tasks</small></strong></div><span className="stat-note">Every bit counts.</span></div><div className="stat card"><span className="stat-icon lavender-icon"><Icon name="clock" size={23}/></span><div><span>Time well spent</span><strong>{s.companion.timer.sessions * 25}<small> min focused</small></strong></div></div><div className="stat card"><span className="stat-icon peach-icon"><Icon name="heart" size={23}/></span><div><span>A growing friendship</span><strong>{s.companion.pet.xp}<small> sprout points</small></strong></div></div></div>
        <div className="dashboard-grid"><Face snapshot={s} now={now} action={action}/><div className="right-column"><Tasks s={s} action={action}/><Focus s={s} now={now} action={action}/><Music s={s} action={action} openSettings={() => setPage('settings')}/><div className="gentle-note"><span>✦</span><p>You don’t have to do it all today.<br/><strong>Just the next little thing.</strong></p><span>✧</span></div></div></div></div>
        {page === 'assistant' && <AssistantPage s={s} openSettings={() => setPage('settings')}/>}
        {page === 'camera' && <Camera s={s} action={action}/>}{page === 'settings' && <Settings s={s} action={action}/>}<Diagnostics s={s}/>
      </>}<footer>{BRAND.tagline}<span>Made for your desk, at your pace.</span></footer></main></div></>;
}
