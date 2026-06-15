# llm-stream-parser — agent capsule

Incrementally parse OpenAI / Anthropic / compatible LLM SSE streams into events
and text deltas; parsers throw on malformed payloads.

- **Family:** lib
- **Public surface (`src/index.ts`):** the `SSEEvent` interface; the
  `SSEParser` class (the low-level incremental framer — `feed(chunk)` returns
  complete events as they arrive, `flush()` force-dispatches the trailing
  buffer at end-of-stream); `iterateEvents(input)` (async generator over a
  `ReadableStream<Uint8Array>` **or** `AsyncIterable<Uint8Array | string>`,
  yielding each `SSEEvent`); `streamText(input)` (async generator yielding only
  the text deltas, auto-detecting the Anthropic vs OpenAI payload shape); the
  provider extractors `openAIText(event)` and `anthropicText(event)`; and the
  `SSEPayloadError` error class.
- **Seams & fakes:** **none — pure library, no I/O seam.** Parsing is a pure,
  deterministic transform over a caller-supplied stream/string: no network, no
  filesystem, no clock, no keys, no randomness. `iterateEvents`/`streamText`
  *consume* a stream the caller hands them (e.g. `fetch().body`) — they never
  open one — so there is nothing to fake. Consequently there is **no `Fake<X>`**
  and **no `live-check`**. `SSEParser` is the deterministic contract of record;
  tests drive it directly with synthetic chunk streams.
- **Invariants:**
  - **What it parses.** Server-Sent Events framing (WHATWG/HTML5 dispatch rules:
    `event:` / `data:` / `id:` / `retry:` fields, `:`-comments and blank lines
    ignored, multi-line `data` joined with `\n`, one leading space stripped per
    value, `\n\n` / `\r\n\r\n` / `\r\r` event separators) — enough for both
    OpenAI- and Anthropic-style LLM streams. On top of framing it extracts text:
    **OpenAI** (`choices[0].delta.content`, terminated by the `data: [DONE]`
    sentinel) and **Anthropic** (`content_block_delta` → `delta.text_delta.text`;
    non-text deltas such as `input_json_delta` tool-call arguments yield `null`).
  - **Incremental partials are buffered, never thrown.** A chunk that does not
    yet complete an event (the blank-line separator hasn't arrived, or a
    multibyte char is split) is **held back** in the parser buffer and resolved
    when the rest arrives — output is identical regardless of chunk boundaries.
    Buffering an in-flight partial is correct, not a silent-empty.
  - **Parsers throw on malformed/truncated payloads (the core invariant).** Once
    an event has been fully framed — the separator landed, or `flush()` ran at
    end-of-input — its `data` is a *complete* value. If a (non-`[DONE]`) payload
    that is supposed to be JSON cannot be parsed, the extractor throws
    `SSEPayloadError`; it **never** silently returns `null`. A **truncated
    stream** (the connection drops mid-event, leaving an incomplete final JSON
    delta) therefore surfaces as a thrown `SSEPayloadError` at flush — a
    half-emitted tool-call/delta is an error, not an empty result. `[DONE]` and
    well-formed-but-textless events (role-only deltas, finish reasons, control
    events, tool-arg deltas) correctly return `null` — those are legitimate
    "no text here", not parse failures.
  - **SSE framing itself is lenient by spec.** The WHATWG SSE grammar accepts
    any line shape (unknown fields are ignored), so `SSEParser` does not reject
    framing; the throw guarantee lives at the JSON-payload layer, where
    structural validity is actually defined.
- **Depends on:** nothing — zero runtime dependencies, no sibling cubes. Uses
  only platform `ReadableStream` / `AsyncIterable` / `TextDecoder` web/JS
  primitives, so it runs unchanged on Bun, Node, browsers, and edge runtimes.
- **Commands:** `bun test` · `bunx tsc --noEmit`
- **Before editing:** `SSEParser` + the extractors are the deterministic
  contract of record — keep them pure (do **not** invent a network/store/clock
  seam; the stream is always caller-supplied). Preserve the SSE framing rules,
  the two provider shapes, and the `[DONE]` sentinel handling. Above all,
  preserve the parsers-throw guarantee: malformed/truncated **complete** payloads
  throw `SSEPayloadError`, while genuine in-flight partials stay buffered — do
  not regress either side of that line back into the original silent-`null`
  behaviour. Use extensionless local imports only.
