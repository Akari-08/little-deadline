/**
 * Study assistant: a thin, read-only Gemini wrapper over the app's task data.
 *
 * - The Gemini API key is the app-wide key from the host environment (.env → GEMINI_API_KEY),
 *   handed in by the host. It is never included in status(), the app snapshot, SSE output, logs
 *   or error messages, and it never reaches browser code.
 * - Each request sends a fixed system instruction, the prior conversation as plain text, and, in
 *   the latest user turn only, a freshly generated <app_state> block (context.ts).
 * - The assistant has no tools and cannot change tasks, Canvas or Notion.
 */
import { ApiError, GoogleGenAI, type Content, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import type { TaskView } from '../tasks/store.ts';
import type { SyncStatus } from '../tasks/sync.ts';
import { formatAssistantContext } from './context.ts';
import { SUGGESTED_QUESTIONS, SYSTEM_PROMPT } from './prompt.ts';

export interface AssistantContext {
  /** Host wall-clock ms. */
  now: number;
  /** IANA zone of the host machine, e.g. "America/New_York". */
  timeZone: string;
  /** Tasks from every provider (mock, canvas, notion), merged; TaskView.provider says which. */
  tasks: TaskView[];
  providers: { canvas: SyncStatus; notion: SyncStatus };
  focus: { sessions: number; running: boolean; remainingMs: number; selectedTaskId: string | null };
  music: { connected: boolean; track: string | null; artist: string | null };
  environment: { temperatureC: number | null; humidityPct: number | null; source: string };
}

export interface AssistantStatus { configured: boolean; model: string; suggestions: readonly string[] }

/** Bad request from the UI (validation) or a state the operator must fix (no key). Safe to show. */
export class AssistantInputError extends Error {}
/** Gemini sent nothing within FIRST_CHUNK_TIMEOUT_MS. */
export class AssistantTimeoutError extends Error {}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export interface ChatResult {
  /** Gemini finish reason (e.g. STOP, MAX_TOKENS, SAFETY), 'BLOCKED', or 'aborted'. */
  stopReason: string | null;
  /** User-facing note for unusual endings (blocked, cut off), else null. */
  note: string | null;
}

/** The part of the Gemini client the assistant uses (lets tests inject a fake). */
export interface GeminiClient {
  models: { generateContentStream(params: GenerateContentParameters): Promise<AsyncIterable<GenerateContentResponse>> };
}

/**
 * Default model. `gemini-4-hydrogen` is Google's recommended fast, low-cost model for new projects
 * (verified against the official model list and a live call, 2026-11-13). Override with GEMINI_MODEL.
 */
export const DEFAULT_ASSISTANT_MODEL = 'gemini-4-hydrogen';
export const MAX_TURNS = 40;
export const MAX_TURN_CHARS = 4000;
export const FIRST_CHUNK_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 8192;
const MAX_CONCURRENT = 2;
const NO_KEY = 'Ask Sprout isn’t set up on this computer yet: add GEMINI_API_KEY to the app’s .env file and restart.';

/** Validate untrusted chat history from the UI. Throws AssistantInputError. */
export function validateChatMessages(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new AssistantInputError('Ask a question first.');
  if (raw.length > MAX_TURNS) throw new AssistantInputError('This conversation is too long. Clear it and start a new one.');
  const turns: ChatTurn[] = [];
  raw.forEach((item: unknown, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AssistantInputError('Invalid conversation.');
    const { role, content } = item as Record<string, unknown>;
    const expected = index % 2 === 0 ? 'user' : 'assistant';
    if (role !== expected) throw new AssistantInputError('Invalid conversation order.');
    if (typeof content !== 'string' || !content.trim()) throw new AssistantInputError('Messages cannot be empty.');
    if (content.length > MAX_TURN_CHARS) throw new AssistantInputError(`Keep each message under ${MAX_TURN_CHARS} characters.`);
    turns.push({ role: expected, content });
  });
  if (turns.at(-1)!.role !== 'user') throw new AssistantInputError('The last message must be your question.');
  return turns;
}

/** Map any failure to a short user-facing message. Never includes credentials or raw API text. */
export function describeAssistantError(error: unknown): string {
  if (error instanceof AssistantInputError) return error.message;
  if (error instanceof AssistantTimeoutError) return 'Gemini didn’t respond in time. Try again in a moment.';
  if (error instanceof ApiError) {
    const s = error.status;
    // An invalid key is reported as 400 INVALID_ARGUMENT with this reason; no distinct status exists.
    if (s === 400 && /API[_ ]KEY[_ ]INVALID|API key not valid/i.test(error.message)) return 'The Gemini API key was rejected. Check GEMINI_API_KEY in the app’s .env file.';
    if (s === 401 || s === 403) return 'This Gemini API key isn’t allowed to use the assistant model. Check the key in Google AI Studio.';
    if (s === 404) return 'The Gemini model isn’t available to this API key. Set GEMINI_MODEL in .env to a model the key can use.';
    if (s === 429) return 'Gemini’s usage limit for this API key was reached. Wait a moment and try again.';
    if (s === 400) return 'Gemini couldn’t process this request. Clear the conversation and try again.';
    if (s >= 500) return 'Gemini is temporarily unavailable or overloaded. Try again shortly.';
    return `Gemini API error (${s}). Try again.`;
  }
  if (error instanceof TypeError) return 'Could not reach the Gemini API. Check this computer’s internet connection.';
  return 'The assistant could not answer. Try again.';
}

function finishNote(reason: string | null): string | null {
  switch (reason) {
    case null: case 'STOP': case 'FINISH_REASON_UNSPECIFIED': return null;
    case 'MAX_TOKENS': return 'This answer was cut off because it got too long. Ask a narrower follow-up.';
    case 'BLOCKED': case 'SAFETY': case 'PROHIBITED_CONTENT': case 'BLOCKLIST': case 'SPII': case 'RECITATION':
      return 'Sprout can’t help with that request. Try rephrasing it.';
    default: return 'This answer ended early. Try asking again.';
  }
}

/** Build the generateContent request. Exported for tests; deterministic for a given context. */
export function buildRequest(turns: readonly ChatTurn[], context: AssistantContext, model = DEFAULT_ASSISTANT_MODEL): GenerateContentParameters {
  const history: Content[] = turns.slice(0, -1).map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] }));
  const question = turns.at(-1)!.content;
  return {
    model,
    contents: [...history, { role: 'user', parts: [{ text: formatAssistantContext(context) }, { text: question }] }],
    config: { systemInstruction: SYSTEM_PROMPT, maxOutputTokens: MAX_OUTPUT_TOKENS },
  };
}

/** Visible answer text in one streamed chunk (thought-summary parts are skipped). */
function chunkText(chunk: GenerateContentResponse): string {
  const parts = chunk.candidates?.[0]?.content?.parts ?? [];
  return parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
}

export class Assistant {
  private readonly options: { apiKey: string | null; model?: string; context: () => AssistantContext; createClient?: (apiKey: string) => GeminiClient; firstChunkTimeoutMs?: number };
  private active = 0;

  constructor(options: { apiKey: string | null; model?: string; context: () => AssistantContext; createClient?: (apiKey: string) => GeminiClient; firstChunkTimeoutMs?: number }) {
    this.options = options;
  }

  get model(): string { return this.options.model || DEFAULT_ASSISTANT_MODEL; }

  status(): AssistantStatus {
    return { configured: !!this.options.apiKey, model: this.model, suggestions: SUGGESTED_QUESTIONS };
  }

  /**
   * Stream one answer. Calls `onText` with text deltas as they arrive. Resolves with the finish
   * reason (or 'aborted'); rejects with AssistantInputError for bad input/no key, and with
   * AssistantTimeoutError / SDK errors for API failures (use describeAssistantError for display).
   */
  async chat(rawTurns: unknown, onText: (delta: string) => void, signal?: AbortSignal): Promise<ChatResult> {
    const turns = validateChatMessages(rawTurns);
    const apiKey = this.options.apiKey;
    if (!apiKey) throw new AssistantInputError(NO_KEY);
    if (this.active >= MAX_CONCURRENT) throw new AssistantInputError('Sprout is still answering another question. Try again in a moment.');
    this.active += 1;
    // One controller for client aborts and the first-chunk watchdog (some models can stall silently).
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let timedOut = false;
    const watchdog = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.firstChunkTimeoutMs ?? FIRST_CHUNK_TIMEOUT_MS);
    try {
      const client = this.options.createClient ? this.options.createClient(apiKey) : new GoogleGenAI({ apiKey });
      const request = buildRequest(turns, this.options.context(), this.model);
      request.config = { ...request.config, abortSignal: controller.signal };
      let finish: string | null = null;
      try {
        const stream = await client.models.generateContentStream(request);
        for await (const chunk of stream) {
          clearTimeout(watchdog);
          if (controller.signal.aborted) break;
          if (chunk.promptFeedback?.blockReason) finish = 'BLOCKED';
          const text = chunkText(chunk);
          if (text) onText(text);
          finish = chunk.candidates?.[0]?.finishReason ?? finish;
        }
      } catch (error) {
        if (timedOut) throw new AssistantTimeoutError('No response from Gemini.');
        if (signal?.aborted) return { stopReason: 'aborted', note: null };
        throw error;
      }
      if (timedOut) throw new AssistantTimeoutError('No response from Gemini.');
      if (signal?.aborted) return { stopReason: 'aborted', note: null };
      return { stopReason: finish, note: finishNote(finish) };
    } finally {
      clearTimeout(watchdog);
      signal?.removeEventListener('abort', onAbort);
      this.active -= 1;
    }
  }
}
