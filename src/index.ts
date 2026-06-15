export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Incremental SSE parser. Feed it chunks of text (or `Uint8Array` via the
 * helper iterator below), and it returns complete events as they arrive.
 *
 * Implements the dispatch rules from the WHATWG/HTML5 Server-Sent Events spec
 * faithfully enough for OpenAI- and Anthropic-style streams.
 *
 * Incremental partials are **buffered**, not rejected: a chunk that does not
 * yet complete an event (no blank-line separator) is held back and resolved
 * when the rest arrives. Only fully-dispatched events leave the parser, so the
 * payload extractors below can treat each event's `data` as a complete value.
 */
export class SSEParser {
  private buffer = "";

  feed(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];
    let m: RegExpExecArray | null;
    const sep = /\r\n\r\n|\n\n|\r\r/g;
    let lastEnd = 0;
    while ((m = sep.exec(this.buffer)) !== null) {
      const raw = this.buffer.slice(lastEnd, m.index);
      const evt = this.parseEvent(raw);
      if (evt) events.push(evt);
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd > 0) this.buffer = this.buffer.slice(lastEnd);
    return events;
  }

  /** Force-dispatch anything still in the buffer (the stream is ending). */
  flush(): SSEEvent[] {
    if (!this.buffer) return [];
    const tail = this.buffer.replace(/[\r\n]+$/, "");
    this.buffer = "";
    const evt = this.parseEvent(tail);
    return evt ? [evt] : [];
  }

  private parseEvent(block: string): SSEEvent | null {
    if (!block) return null;
    const out: SSEEvent = { data: "" };
    const dataLines: string[] = [];
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(":")) continue;
      const idx = line.indexOf(":");
      const field = idx < 0 ? line : line.slice(0, idx);
      let value = idx < 0 ? "" : line.slice(idx + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") dataLines.push(value);
      else if (field === "event") out.event = value;
      else if (field === "id") out.id = value;
      else if (field === "retry") {
        const n = parseInt(value, 10);
        if (Number.isFinite(n)) out.retry = n;
      }
    }
    if (!dataLines.length && !out.event) return null;
    out.data = dataLines.join("\n");
    return out;
  }
}

/**
 * Consume any async iterable of `Uint8Array`/string chunks (e.g. `fetch().body`)
 * and yield SSE events as they parse.
 */
export async function* iterateEvents(
  input: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>,
): AsyncIterable<SSEEvent> {
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  const iter = isReadableStream(input) ? readableStreamToAsync(input) : input;
  for await (const chunk of iter) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (const e of parser.feed(text)) yield e;
  }
  for (const e of parser.flush()) yield e;
}

function isReadableStream(x: unknown): x is ReadableStream<Uint8Array> {
  return typeof x === "object" && x !== null && typeof (x as ReadableStream).getReader === "function";
}

async function* readableStreamToAsync<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/* ---- Errors ---- */

/**
 * Thrown when a fully-dispatched SSE event carries a `data:` payload that is
 * supposed to be JSON but cannot be parsed.
 *
 * By the time an event reaches an extractor it has already been framed in full
 * (the blank-line separator arrived, or the stream flushed at end-of-input), so
 * its `data` is a *complete* value — invalid JSON here is a structural error,
 * never an in-flight partial. Per the platform house rule, parsers throw on
 * unparseable input rather than silently returning an empty result. A truncated
 * stream therefore surfaces as this error: the final, half-emitted JSON delta
 * fails to parse and is reported, not swallowed.
 */
export class SSEPayloadError extends Error {
  /** The raw `data:` payload that failed to parse. */
  readonly data: string;
  constructor(message: string, data: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SSEPayloadError";
    this.data = data;
  }
}

/**
 * Parse an event's `data:` payload as JSON, throwing `SSEPayloadError` (never
 * silently returning null) when it is not valid JSON. Callers must filter out
 * non-JSON sentinels (e.g. OpenAI's terminal `[DONE]`) before calling this.
 */
function parsePayload(event: SSEEvent): unknown {
  try {
    return JSON.parse(event.data);
  } catch (cause) {
    throw new SSEPayloadError(
      `Unparseable SSE data payload (not valid JSON): ${JSON.stringify(event.data.slice(0, 120))}`,
      event.data,
      { cause },
    );
  }
}

/* ---- Provider-specific extractors ---- */

/**
 * Extract incremental text from an OpenAI-style chat completion stream event.
 *
 * Returns `null` for the terminal `[DONE]` sentinel and for well-formed events
 * that carry no text (e.g. a role-only delta or a finish-reason chunk).
 * **Throws** `SSEPayloadError` if the (non-sentinel) payload is not valid JSON —
 * a fully-framed event with broken JSON is malformed, not an in-flight partial.
 */
export function openAIText(event: SSEEvent): string | null {
  if (event.data === "[DONE]") return null;
  const j = parsePayload(event) as { choices?: Array<{ delta?: { content?: unknown } }> } | null;
  const content = j?.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : null;
}

/**
 * Extract incremental text from an Anthropic Messages API stream event.
 *
 * Returns the text payload of `content_block_delta` events whose delta is of
 * type `text_delta`. Returns `null` for control events and non-text deltas
 * (e.g. `input_json_delta` for tool-call arguments). **Throws**
 * `SSEPayloadError` if a `content_block_delta` event carries invalid JSON.
 */
export function anthropicText(event: SSEEvent): string | null {
  // Anthropic puts the event name in `event:`; data is JSON.
  if (event.event && event.event !== "content_block_delta") return null;
  // Tolerate the OpenAI-style `[DONE]` terminator as a sentinel (not malformed
  // JSON) so the combined `streamText` path can probe both shapes safely.
  if (event.data === "[DONE]") return null;
  const j = parsePayload(event) as
    | { type?: string; delta?: { type?: string; text?: unknown } }
    | null;
  if (j?.type === "content_block_delta" && j?.delta?.type === "text_delta") {
    return typeof j.delta.text === "string" ? j.delta.text : null;
  }
  return null;
}

/**
 * High-level helper: yield only the text deltas from an LLM stream. Tries the
 * Anthropic shape first, falls back to the OpenAI shape, and skips control
 * events. JSON-payload errors from the extractors propagate (a malformed or
 * truncated delta throws `SSEPayloadError` rather than being silently dropped).
 */
export async function* streamText(
  input: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  for await (const event of iterateEvents(input)) {
    const text = anthropicText(event) ?? openAIText(event);
    if (text) yield text;
  }
}
