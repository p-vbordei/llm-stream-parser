import { describe, it, expect } from "vitest";
import { SSEParser, iterateEvents, streamText, openAIText, anthropicText } from "../src/index.js";

describe("SSEParser basic", () => {
  it("parses a single complete event", () => {
    const p = new SSEParser();
    const events = p.feed("event: ping\ndata: hello\n\n");
    expect(events).toEqual([{ event: "ping", data: "hello" }]);
  });

  it("handles split chunks", () => {
    const p = new SSEParser();
    expect(p.feed("event: x\ndata: hel")).toEqual([]);
    expect(p.feed("lo\n\n")).toEqual([{ event: "x", data: "hello" }]);
  });

  it("multi-line data is joined with \\n", () => {
    const p = new SSEParser();
    const ev = p.feed("data: line 1\ndata: line 2\n\n");
    expect(ev).toEqual([{ data: "line 1\nline 2" }]);
  });

  it("ignores comments and blank lines inside event", () => {
    const p = new SSEParser();
    const ev = p.feed(": comment\nevent: x\ndata: ok\n\n");
    expect(ev).toEqual([{ event: "x", data: "ok" }]);
  });

  it("parses id and retry", () => {
    const p = new SSEParser();
    const ev = p.feed("id: 42\nretry: 1000\ndata: x\n\n");
    expect(ev[0]).toMatchObject({ id: "42", retry: 1000, data: "x" });
  });

  it("strips one leading space from value", () => {
    const p = new SSEParser();
    expect(p.feed("data:  hello\n\n")).toEqual([{ data: " hello" }]); // one space stripped, leaves one
  });

  it("handles CRLF separator", () => {
    const p = new SSEParser();
    expect(p.feed("data: x\r\n\r\n")).toEqual([{ data: "x" }]);
  });

  it("flush emits trailing event without separator", () => {
    const p = new SSEParser();
    expect(p.feed("data: x\n")).toEqual([]);
    expect(p.flush()).toEqual([{ data: "x" }]);
  });
});

describe("iterateEvents", () => {
  it("works with async iterable of strings", async () => {
    async function* chunks() {
      yield "event: ping\ndata: a\n\n";
      yield "data: b\n\n";
    }
    const result = [];
    for await (const e of iterateEvents(chunks())) result.push(e);
    expect(result).toEqual([{ event: "ping", data: "a" }, { data: "b" }]);
  });

  it("works with Uint8Array chunks", async () => {
    const enc = new TextEncoder();
    async function* chunks() {
      yield enc.encode("data: hello\n\n");
    }
    const result = [];
    for await (const e of iterateEvents(chunks())) result.push(e);
    expect(result).toEqual([{ data: "hello" }]);
  });
});

describe("openAIText extractor", () => {
  it("pulls delta.content", () => {
    const ev = { data: JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }) };
    expect(openAIText(ev)).toBe("Hello");
  });
  it("returns null for [DONE]", () => {
    expect(openAIText({ data: "[DONE]" })).toBeNull();
  });
  it("returns null for events without content", () => {
    expect(openAIText({ data: JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }) })).toBeNull();
  });
  it("returns null for invalid JSON", () => {
    expect(openAIText({ data: "not json" })).toBeNull();
  });
});

describe("anthropicText extractor", () => {
  it("pulls delta.text from content_block_delta", () => {
    const ev = {
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "World" },
      }),
    };
    expect(anthropicText(ev)).toBe("World");
  });

  it("returns null for non-text deltas (e.g. input_json_delta)", () => {
    const ev = {
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: "{\"x\":" },
      }),
    };
    expect(anthropicText(ev)).toBeNull();
  });

  it("returns null for non-delta events", () => {
    const ev = { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) };
    expect(anthropicText(ev)).toBeNull();
  });
});

describe("streamText", () => {
  it("yields text from an Anthropic-shaped stream", async () => {
    async function* chunks() {
      yield 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n';
      yield 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"World"}}\n\n';
      yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    }
    const out: string[] = [];
    for await (const t of streamText(chunks())) out.push(t);
    expect(out.join("")).toBe("Hello World");
  });

  it("yields text from an OpenAI-shaped stream", async () => {
    async function* chunks() {
      yield 'data: {"choices":[{"delta":{"content":"Foo"}}]}\n\n';
      yield 'data: {"choices":[{"delta":{"content":" bar"}}]}\n\n';
      yield "data: [DONE]\n\n";
    }
    const out: string[] = [];
    for await (const t of streamText(chunks())) out.push(t);
    expect(out.join("")).toBe("Foo bar");
  });
});
