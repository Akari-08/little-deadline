/**
 * Study assistant: a thin, read-only Claude wrapper over the app's task data.
 *
 * - The Anthropic API key comes only from the host secret store via `loadApiKey()`. It is never
 *   included in status(), the app snapshot, SSE output, logs or error messages.
 * - Each request sends a frozen (cacheable) system prompt, the prior conversation as plain text,
 *   and, in the latest user turn only, a freshly generated <app_state> block (context.ts).
 * - The assistant has no tools and cannot change tasks, Canvas or Notion.
 */
import Anthropic from '@anthropic-ai/sdk';
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

/** Bad request from the UI (validation) or a state the user must fix (no key). Safe to show. */
export class AssistantInputError extends Error {}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export interface ChatResult {
  /** Claude's stop reason, or 'aborted' when the client cancelled. */
  stopReason: string | null;
  /** User-facing note for unusual endings (refusal, cut off), else null. */
  note: string | null;
}

export const ASSISTANT_MODEL = 'claude-opus-5-5';
/**
 * Q&A over pre-bucketed, structured task data is light reasoning; `medium` (Opus 5.5's default,
 * set explicitly) keeps date matching and planning reliable without the latency of `high`.
 */
export const ASSISTANT_EFFORT = 'medium' as const;
export const MAX_TURNS = 40;
export const MAX_TURN_CHARS = 4000;
const MAX_CONCURRENT = 2;

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

/** Map any failure to a short user-facing message. Never includes credentials. */
export function describeAssistantError(error: unknown): string {
  if (error instanceof AssistantInputError) return error.message;
  if (error instanceof Anthropic.APIUserAbortError) return 'Stopped.';
  if (error instanceof Anthropic.AuthenticationError) return 'Claude API key was rejected — update it in Settings.';
  if (error instanceof Anthropic.PermissionDeniedError) return 'This Claude API key is not allowed to use this model. Check the key’s workspace in the Claude Console.';
  if (error instanceof Anthropic.NotFoundError) return 'The Claude model is not available to this API key.';
  if (error instanceof Anthropic.RateLimitError) return 'Claude is rate-limiting this API key. Wait a moment and try again.';
  if (error instanceof Anthropic.BadRequestError) return 'Claude could not process this request. Check your API key’s billing and limits in the Claude Console, or clear the conversation and retry.';
  if (error instanceof Anthropic.InternalServerError) return 'Claude is temporarily unavailable or overloaded. Try again shortly.';
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'Claude took too long to respond. Try again.';
  if (error instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check this computer’s internet connection.';
  if (error instanceof Anthropic.APIError) return `Claude API error${typeof error.status === 'number' ? ` (${error.status})` : ''}. Try again.`;
  return 'The assistant could not answer. Try again.';
}

function stopNote(stopReason: string | null): string | null {
  switch (stopReason) {
    case 'refusal': return 'Sprout can’t help with that request. Try rephrasing it.';
    case 'max_tokens': return 'This answer was cut off because it got too long. Ask a narrower follow-up.';
    case 'model_context_window_exceeded': return 'This conversation is too long. Clear it and start a new one.';
    default: return null;
  }
}

/** Build the Messages API request. Exported for tests; deterministic for a given context. */
export function buildRequest(turns: readonly ChatTurn[], context: AssistantContext): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  const history: Anthropic.Beta.BetaMessageParam[] = turns.slice(0, -1).map(t => ({ role: t.role, content: t.content }));
  const question = turns.at(-1)!.content;
  return {
    model: ASSISTANT_MODEL,
    max_tokens: 16_000,
    // Adaptive thinking is the only mode on Opus 5.5; depth is controlled with effort.
    thinking: { type: 'adaptive' },
    output_config: { effort: ASSISTANT_EFFORT },
    // Server-side refusal fallback (opt-in): reroutes a policy decline to the default fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // Frozen system prompt, cached. Volatile state goes in the latest user turn below.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [...history, { role: 'user', content: [
      { type: 'text', text: formatAssistantContext(context) },
      { type: 'text', text: question },
    ] }],
  };
}

export class Assistant {
  private readonly options: { loadApiKey: () => string | null; context: () => AssistantContext; createClient?: (apiKey: string) => Anthropic };
  private active = 0;

  constructor(options: { loadApiKey: () => string | null; context: () => AssistantContext; createClient?: (apiKey: string) => Anthropic }) {
    this.options = options;
  }

  status(): AssistantStatus {
    return { configured: !!this.options.loadApiKey(), model: ASSISTANT_MODEL, suggestions: SUGGESTED_QUESTIONS };
  }

  /**
   * Stream one answer. Calls `onText` with text deltas as they arrive. Resolves with the stop
   * reason (or 'aborted'); rejects with AssistantInputError for bad input/no key and with SDK
   * errors for API failures (use describeAssistantError for display).
   */
  async chat(rawTurns: unknown, onText: (delta: string) => void, signal?: AbortSignal): Promise<ChatResult> {
    const turns = validateChatMessages(rawTurns);
    const apiKey = this.options.loadApiKey();
    if (!apiKey) throw new AssistantInputError('Add your Claude API key in Settings to use the assistant.');
    if (this.active >= MAX_CONCURRENT) throw new AssistantInputError('Sprout is still answering another question. Try again in a moment.');
    this.active += 1;
    try {
      const client = this.options.createClient ? this.options.createClient(apiKey) : new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
      const stream = client.beta.messages.stream(buildRequest(turns, this.options.context()), { signal });
      stream.on('text', delta => { if (!signal?.aborted) onText(delta); });
      try {
        const message = await stream.finalMessage();
        return { stopReason: message.stop_reason, note: stopNote(message.stop_reason) };
      } catch (error) {
        if (error instanceof Anthropic.APIUserAbortError || signal?.aborted) return { stopReason: 'aborted', note: null };
        throw error;
      }
    } finally {
      this.active -= 1;
    }
  }
}
