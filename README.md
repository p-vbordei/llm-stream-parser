# llm-stream-parser

[![ci](https://github.com/p-vbordei/llm-stream-parser/actions/workflows/ci.yml/badge.svg)](https://github.com/p-vbordei/llm-stream-parser/actions/workflows/ci.yml)

[![npm](https://img.shields.io/npm/v/%40p-vbordei%2Fllm-stream-parser.svg)](https://www.npmjs.com/package/@p-vbordei/llm-stream-parser)
[![downloads](https://img.shields.io/npm/dm/%40p-vbordei%2Fllm-stream-parser.svg)](https://www.npmjs.com/package/@p-vbordei/llm-stream-parser)
[![bundle](https://img.shields.io/bundlejs/size/%40p-vbordei%2Fllm-stream-parser)](https://bundlejs.com/?q=%40p-vbordei%2Fllm-stream-parser)

Parse Server-Sent Events streams from OpenAI, Anthropic, and compatible LLM APIs. Incremental, transport-agnostic, zero dependencies.

```ts
import { streamText, iterateEvents } from "@p-vbordei/llm-stream-parser";

// Easy: just text deltas, auto-detecting OpenAI vs Anthropic shape
const res = await fetch(url, { method: "POST", body });
for await (const chunk of streamText(res.body!)) {
  process.stdout.write(chunk);
}

// Full control: see every raw SSE event
for await (const event of iterateEvents(res.body!)) {
  if (event.event === "content_block_start") { /* ... */ }
}
```

## Install

```sh
npm install @p-vbordei/llm-stream-parser
```

## API

### `streamText(input): AsyncIterable<string>`

Yields just the text deltas. Tries the Anthropic event shape first
(`content_block_delta` → `delta.text_delta.text`), falls back to the OpenAI shape
(`choices[0].delta.content`). Skips control events and the terminal `[DONE]`.

`input` can be:
- a `ReadableStream<Uint8Array>` (the `body` of a `fetch` response)
- an `AsyncIterable<Uint8Array | string>` (Node `Readable`, generators)

### `iterateEvents(input): AsyncIterable<SSEEvent>`

Yields each parsed SSE event:

```ts
type SSEEvent = {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
};
```

Use this when you need access to non-text events (tool-call deltas, usage, finish reason, etc.).

### `class SSEParser`

Low-level incremental parser if you're plumbing your own transport:

```ts
const p = new SSEParser();
for (const event of p.feed(chunk)) { /* ... */ }
for (const event of p.flush())     { /* end of stream */ }
```

### Provider extractors

- `openAIText(event)` — extract `choices[0].delta.content`. Returns `null` for non-text events and the `[DONE]` sentinel.
- `anthropicText(event)` — extract `content_block_delta` text. Returns `null` for non-text deltas (e.g. `input_json_delta` for tool calls) and control events.

## Notes

- Handles split chunks correctly — feed it bytes as they arrive, no need to buffer yourself.
- Handles `\n\n`, `\r\n\r\n`, and `\r\r` event separators (per spec).
- Strips one leading space from each field value (per spec).

## License

Apache-2.0 © Vlad Bordei
