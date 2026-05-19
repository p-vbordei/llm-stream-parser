# llm-stream-parser

[![ci](https://github.com/p-vbordei/llm-stream-parser/actions/workflows/ci.yml/badge.svg)](https://github.com/p-vbordei/llm-stream-parser/actions/workflows/ci.yml)

[![npm](https://img.shields.io/npm/v/%40p-vbordei%2Fllm-stream-parser.svg)](https://www.npmjs.com/package/@p-vbordei/llm-stream-parser)
[![downloads](https://img.shields.io/npm/dm/%40p-vbordei%2Fllm-stream-parser.svg)](https://www.npmjs.com/package/@p-vbordei/llm-stream-parser)
[![bundle](https://img.shields.io/bundlejs/size/%40p-vbordei%2Fllm-stream-parser)](https://bundlejs.com/?q=%40p-vbordei%2Fllm-stream-parser)

> Parse Server-Sent Events streams from OpenAI, Anthropic, and compatible LLM APIs. Incremental, transport-agnostic, zero dependencies.

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

Works with Node 20+, browsers, Bun, Deno. ESM + CJS.

## Why

Both OpenAI and Anthropic stream responses as SSE — but the framing and the payload shape differ:

- **OpenAI**: events have no `event:` line; `data:` lines contain JSON with `choices[0].delta.content`; stream terminates with `data: [DONE]`.
- **Anthropic**: events have an `event:` line (`message_start`, `content_block_delta`, etc.); the delta type lives inside the JSON.

Both vendors have official SDKs but pull in a lot of code. If you're calling these APIs from a Cloudflare Worker, a serverless function, or an edge runtime, you want a small SSE parser + thin shape adapters. That's this package.

## Recipes

### Stream into a chat UI (OpenAI)

```ts
import { streamText } from "@p-vbordei/llm-stream-parser";

async function chat(prompt: string, onToken: (t: string) => void) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      stream: true,
    }),
  });

  for await (const chunk of streamText(res.body!)) onToken(chunk);
}
```

### Re-emit as your own server-side SSE

```ts
import { iterateEvents } from "@p-vbordei/llm-stream-parser";

// Proxy an LLM stream to your client without exposing the API key
export async function GET(req: Request) {
  const upstream = await fetch(LLM_URL, { method: "POST", body: req.body });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      for await (const ev of iterateEvents(upstream.body!)) {
        controller.enqueue(encoder.encode(`event: ${ev.event ?? "message"}\ndata: ${ev.data}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
```

### Capture tool-call args from Anthropic input_json_delta

```ts
import { iterateEvents } from "@p-vbordei/llm-stream-parser";

let toolName = "";
let toolArgs = "";

for await (const ev of iterateEvents(res.body!)) {
  if (ev.event === "content_block_start") {
    const j = JSON.parse(ev.data);
    if (j.content_block.type === "tool_use") toolName = j.content_block.name;
  }
  if (ev.event === "content_block_delta") {
    const j = JSON.parse(ev.data);
    if (j.delta.type === "input_json_delta") toolArgs += j.delta.partial_json;
  }
}
const args = JSON.parse(toolArgs);
```

### Combine with markdown-streaming

```ts
import { streamText } from "@p-vbordei/llm-stream-parser";
import { MarkdownStreamer } from "markdown-streaming";

const md = new MarkdownStreamer();
for await (const chunk of streamText(res.body!)) {
  el.innerHTML = md.feed(chunk);
}
```

## API

### `streamText(input): AsyncIterable<string>`

Yields just the text deltas. Tries the Anthropic event shape first (`content_block_delta` → `delta.text_delta.text`), falls back to the OpenAI shape (`choices[0].delta.content`). Skips control events and the terminal `[DONE]`.

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

## Caveats

- **No reconnection logic.** If the SSE connection drops, you handle it. LLM APIs typically don't have a "resume from event ID" feature, so you'd re-send the prompt anyway.
- **JSON parsing happens at the extractor level.** If an LLM emits malformed JSON in a delta, the extractor returns `null` for that event rather than throwing.

## License

Apache-2.0 © Vlad Bordei
