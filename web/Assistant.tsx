import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { AppSnapshot } from '../src/host/application.ts';
import './assistant.css';

type Action = (path: string, body?: Record<string, unknown>) => Promise<boolean>;
type Status = 'thinking' | 'streaming' | 'done' | 'stopped' | 'error';
interface Exchange { id: string; question: string; answer: string; status: Status; note: string | null }

const STORAGE_KEY = 'lil-deadline.assistant.v1';
/** Server limits: ≤ 40 turns and ≤ 4000 chars per turn; keep the request body well under 64 KB. */
const MAX_TURN_CHARS = 4000, HISTORY_CHAR_BUDGET = 40_000, MAX_HISTORY_EXCHANGES = 12;

function loadConversation(): Exchange[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is Exchange => !!e && typeof e.id === 'string' && typeof e.question === 'string' && typeof e.answer === 'string')
      .map(e => ({ ...e, status: e.status === 'thinking' || e.status === 'streaming' ? 'stopped' : e.status, note: typeof e.note === 'string' ? e.note : null }));
  } catch { return []; }
}
function saveConversation(exchanges: Exchange[]): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(exchanges)); } catch { /* per-tab convenience only */ }
}

/** Completed exchanges (newest last) that fit the server's limits, then the new question. */
function buildHistory(exchanges: Exchange[], question: string) {
  const clip = (text: string) => text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS - 1)}…` : text;
  const usable = exchanges.filter(e => (e.status === 'done' || e.status === 'stopped') && e.answer.trim());
  const picked: { role: 'user' | 'assistant'; content: string }[][] = [];
  let budget = HISTORY_CHAR_BUDGET - question.length;
  for (let i = usable.length - 1; i >= 0 && picked.length < MAX_HISTORY_EXCHANGES; i--) {
    const pair = [{ role: 'user' as const, content: clip(usable[i]!.question) }, { role: 'assistant' as const, content: clip(usable[i]!.answer) }];
    const size = pair[0]!.content.length + pair[1]!.content.length;
    if (size > budget) break;
    budget -= size; picked.unshift(pair);
  }
  return [...picked.flat(), { role: 'user' as const, content: question }];
}

/** Minimal, safe markdown: paragraphs, "-"/"*"/"1." lists, **bold**, *italic*, `code`, http(s) links. No HTML injection. */
function inline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s)]+|\*[^*\s][^*]*\*)/g;
  let last = 0, match: RegExpExecArray | null, n = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0], k = `${key}-${n++}`;
    if (token.startsWith('**')) nodes.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) nodes.push(<code key={k}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('[')) { const [, label, href] = /^\[([^\]]+)\]\((.+)\)$/.exec(token) ?? []; nodes.push(<a key={k} href={href} target="_blank" rel="noreferrer">{label}</a>); }
    else if (token.startsWith('http')) nodes.push(<a key={k} href={token} target="_blank" rel="noreferrer">{token}</a>);
    else nodes.push(<em key={k}>{token.slice(1, -1)}</em>);
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null, paragraph: string[] = [];
  const flushParagraph = () => { if (paragraph.length) { const k = `p${blocks.length}`; blocks.push(<p key={k}>{inline(paragraph.join(' '), k)}</p>); paragraph = []; } };
  const flushList = () => {
    if (!list) return;
    const k = `l${blocks.length}`, items = list.items.map((item, i) => <li key={i}>{inline(item, `${k}-${i}`)}</li>);
    blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>); list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd(), bullet = /^\s*[-*•]\s+(.*)$/.exec(line), numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line), heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else if (!line.trim()) { flushParagraph(); flushList(); }
    else if (heading) { flushParagraph(); flushList(); const k = `h${blocks.length}`; blocks.push(<p key={k}><strong>{inline(heading[1]!, k)}</strong></p>); }
    else { flushList(); paragraph.push(line.trim()); }
  }
  flushParagraph(); flushList();
  return <>{blocks}</>;
}

/** Parse one SSE frame ("event: x\ndata: {...}"). */
function parseFrame(frame: string): { event: string; data: Record<string, unknown> } | null {
  let event = 'message', data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) as Record<string, unknown> }; } catch { return null; }
}

export function AssistantPage({ s, openSettings }: { s: AppSnapshot; openSettings: () => void }) {
  const [exchanges, setExchanges] = useState<Exchange[]>(loadConversation), [draft, setDraft] = useState('');
  const controller = useRef<AbortController | null>(null), list = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const busy = exchanges.some(e => e.status === 'thinking' || e.status === 'streaming');
  const configured = s.assistant.configured;

  useEffect(() => { saveConversation(exchanges); }, [exchanges]);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [exchanges]);
  useEffect(() => () => controller.current?.abort(), []);

  const update = (id: string, change: (e: Exchange) => Exchange) => setExchanges(all => all.map(e => e.id === id ? change(e) : e));

  async function ask(question: string, retryId?: string) {
    question = question.trim();
    if (!question || busy || !configured) return;
    if (question.length > MAX_TURN_CHARS) { setDraft(question); return; }
    const prior = exchanges.filter(e => e.id !== retryId);
    const id = retryId ?? crypto.randomUUID();
    const fresh: Exchange = { id, question, answer: '', status: 'thinking', note: null };
    setExchanges(retryId ? exchanges.map(e => e.id === retryId ? fresh : e) : [...exchanges, fresh]);
    setDraft('');
    const abort = new AbortController(); controller.current = abort;
    let finished = false;
    try {
      const response = await fetch('/api/assistant/chat', { method: 'POST', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', 'X-Lil-Deadline': '1' }, body: JSON.stringify({ messages: buildHistory(prior, question) }) });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? 'The local host could not reach the assistant.');
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value.replace(/\r\n/g, '\n');
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const frame = parseFrame(buffer.slice(0, cut)); buffer = buffer.slice(cut + 2);
          if (!frame) continue;
          if (frame.event === 'delta' && typeof frame.data.text === 'string') { const text = frame.data.text; update(id, e => ({ ...e, status: 'streaming', answer: e.answer + text })); }
          else if (frame.event === 'done') { finished = true; const note = typeof frame.data.note === 'string' ? frame.data.note : null; update(id, e => ({ ...e, status: frame.data.stopReason === 'aborted' ? 'stopped' : 'done', note })); }
          else if (frame.event === 'error') { finished = true; const note = typeof frame.data.message === 'string' ? frame.data.message : 'The assistant could not answer.'; update(id, e => ({ ...e, status: 'error', note })); }
        }
      }
      if (!finished) update(id, e => ({ ...e, status: e.answer ? 'stopped' : 'error', note: 'The connection closed before the answer finished.' }));
    } catch (error) {
      if (abort.signal.aborted) update(id, e => ({ ...e, status: e.answer ? 'stopped' : 'error', note: e.answer ? null : 'Stopped before an answer arrived.' }));
      else update(id, e => ({ ...e, status: 'error', note: error instanceof Error ? error.message : 'The local host is unavailable.' }));
    } finally {
      if (controller.current === abort) controller.current = null;
      input.current?.focus();
    }
  }

  function submit(e: FormEvent) { e.preventDefault(); void ask(draft); }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft); }
  }
  function clear() { controller.current?.abort(); setExchanges([]); setDraft(''); }

  const suggestions = s.assistant.suggestions;
  const chips = (compact: boolean) => <div className={`assistant-chips ${compact ? 'compact' : ''}`} aria-label="Suggested questions">
    {suggestions.map(q => <button key={q} type="button" disabled={busy || !configured} onClick={() => void ask(q)}>{q}</button>)}
  </div>;

  return <section className="assistant-card card">
    <div className="card-top"><div><span className="eyebrow">ASK SPROUT</span><h2>Your study assistant</h2></div>
      <div className="assistant-top-actions"><span className="pill lilac">{configured ? 'Claude · read-only' : 'not set up'}</span>
        <button type="button" className="text-button" onClick={clear} disabled={!exchanges.length}>Clear conversation</button></div></div>
    {!configured ? <div className="empty"><span className="assistant-avatar large">✦</span><h3>Sprout needs a Claude API key to chat.</h3>
      <p>Add your key in Settings. It stays in this computer’s private settings file and is never sent to the browser.</p>
      <button className="primary" onClick={openSettings}>Open Settings</button></div> : <>
      <div className="assistant-log" ref={list} aria-live="polite">
        {!exchanges.length ? <div className="assistant-welcome"><span className="assistant-avatar large">✦</span><h3>What would you like to know?</h3>
          <p>I can see your Canvas, Notion and local tasks. Try one of these:</p>{chips(false)}</div>
        : exchanges.map(e => <div key={e.id} className="assistant-exchange">
          <div className="assistant-msg user"><p>{e.question}</p></div>
          <div className={`assistant-msg bot ${e.status}`}><span className="assistant-avatar">✦</span><div>
            {e.status === 'thinking' ? <p className="assistant-thinking" role="status"><span/><span/><span/> Looking at your deadlines…</p> : <Markdown text={e.answer}/>}
            {e.status === 'streaming' && <span className="assistant-caret" aria-hidden="true"/>}
            {e.status === 'stopped' && !e.note && <p className="assistant-note">Stopped.</p>}
            {e.note && <p className={`assistant-note ${e.status === 'error' ? 'error' : ''}`}>{e.note}</p>}
            {e.status === 'error' && <button type="button" className="text-button" disabled={busy} onClick={() => void ask(e.question, e.id)}>Retry</button>}
          </div></div>
        </div>)}
      </div>
      {exchanges.length > 0 && <details className="assistant-more"><summary>Suggested questions</summary>{chips(true)}</details>}
      <form className="assistant-compose" onSubmit={submit}>
        <textarea ref={input} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKey} rows={2} maxLength={MAX_TURN_CHARS}
          placeholder="Ask about your deadlines, courses or week…" aria-label="Your question"/>
        {busy ? <button type="button" className="secondary" onClick={() => controller.current?.abort()}>■ Stop</button>
          : <button className="primary" disabled={!draft.trim()}>Send</button>}
      </form>
      <p className="fineprint">Enter to send · Shift+Enter for a new line. To answer, your question and your task list (titles, courses, due dates, links) are sent to Anthropic’s Claude API. Device tokens and other credentials are never sent. Sprout is read-only: it can’t change tasks, submit coursework or edit Canvas or Notion.</p>
    </>}
  </section>;
}

export function AssistantSettings({ s, action }: { s: AppSnapshot; action: Action }) {
  const [message, setMessage] = useState('');
  const saved = s.secrets.anthropicApiKeySet;
  if (s.assistant.keySource === 'app') {
    return <section className="card settings-card"><span className="integration-logo">✦</span><span className="pill green">ready</span>
      <h2>Study assistant (Claude)</h2><p>Ask Sprout is ready to chat — no API key needed. This app provides one.</p>
      <p className="fineprint">The app’s Claude key is configured on the host (in its private <code>.env</code>) and never reaches the browser. Questions and your task list are sent to Anthropic to generate answers. Model: {s.assistant.model}.</p>
    </section>;
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget, field = form.elements.namedItem('token') as HTMLInputElement;
    if (await action('/api/settings/assistant', { token: field.value })) { field.value = ''; setMessage('Claude API key saved on this computer.'); }
  }
  return <section className="card settings-card"><span className="integration-logo">✦</span><span className="pill lilac">{saved ? 'key saved' : 'unconfigured'}</span>
    <h2>Study assistant (Claude)</h2><p>Ask Sprout questions about your deadlines. Uses your own Anthropic API key.</p>
    <form onSubmit={e => void submit(e)}>
      <label>Claude API key<input name="token" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" required
        placeholder={saved ? 'Saved · enter a new key to replace' : 'sk-ant-…'} maxLength={512}/></label>
      <button className="primary">Save API key</button>
    </form>
    <div className="connection-actions"><button className="text-button" disabled={!saved} onClick={async () => { if (await action('/api/settings/assistant', { clearToken: true })) setMessage('Claude API key removed.'); }}>Remove key</button></div>
    {message && <p className="inline-note" role="status">{message}</p>}
    <p className="fineprint">Create a key at console.anthropic.com → API Keys. The key is stored only in the host’s private secrets file, never in the browser, logs or the repository. Questions and your task list are sent to Anthropic to generate answers; usage is billed to your Anthropic account. Model: {s.assistant.model}.</p>
  </section>;
}
