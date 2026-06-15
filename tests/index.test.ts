import { describe, it, expect } from "bun:test";
import {
  SSEParser,
  iterateEvents,
  streamText,
  openAIText,
  anthropicText,
  SSEPayloadError,
} from "../src/index";

describe("SSEParser framing", () => {
  it("parses a single complete event", () => {
    const p = new SSEParser();
    const events = p.feed("event: ping\ndata: hello\n\n");
    expect(events).toEqual([{ event: "ping", data: "hello" }]);
  });

  it("buffers a split event then completes it (incremental partial — not an error)", () => {
    const p = new SSEParser();
    expect(p.feed("event: x\ndata: hel")).toEqual([]); // partial held back, no throw
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
    expect(p.feed("data:  hello\n\n")).toEqual([{ data: " hello" }]);
  });

  it("handles CRLF separator", () => {
    const p = new SSEParser();
    expect(p.feed("data: x\r\n\r\n")).toEqual([{ data: "x" }]);
  });

  it("flush emits a trailing complete event without separator", () => {
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

  it("works with Uint8Array chunks split mid-multibyte (incremental decode)", async () => {
    const enc = new TextEncoder();
    const full = enc.encode("data: héllo\n\n"); // é is 2 bytes
    async function* chunks() {
      yield full.slice(0, 8); // split mid-stream
      yield full.slice(8);
    }
    const result = [];
    for await (const e of iterateEvents(chunks())) result.push(e);
    expect(result).toEqual([{ data: "héllo" }]);
  });
});

describe("openAIText extractor", () => {
  it("pulls delta.content", () => {
    const ev = { data: JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }) };
    expect(openAIText(ev)).toBe("Hello");
  });
  it("returns null for the [DONE] sentinel", () => {
    expect(openAIText({ data: "[DONE]" })).toBeNull();
  });
  it("returns null for well-formed events without content", () => {
    expect(
      openAIText({ data: JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }) }),
    ).toBeNull();
  });
  it("THROWS on malformed JSON (parsers throw — never silent-null)", () => {
    expect(() => openAIText({ data: "not json" })).toThrow(SSEPayloadError);
  });
  it("THROWS on truncated JSON (a half-emitted delta at end-of-stream)", () => {
    expect(() => openAIText({ data: '{"choices":[{"delta":{"content":"Hel' })).toThrow(
      SSEPayloadError,
    );
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

  it("returns null for non-text deltas (e.g. input_json_delta tool args)", () => {
    const ev = {
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"x":' },
      }),
    };
    expect(anthropicText(ev)).toBeNull();
  });

  it("returns null for control events (no payload parse)", () => {
    const ev = { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) };
    expect(anthropicText(ev)).toBeNull();
  });

  it("tolerates the [DONE] sentinel for the combined streamText path", () => {
    expect(anthropicText({ data: "[DONE]" })).toBeNull();
  });

  it("THROWS on a content_block_delta carrying malformed JSON", () => {
    const ev = { event: "content_block_delta", data: "{not valid" };
    expect(() => anthropicText(ev)).toThrow(SSEPayloadError);
  });
});

describe("streamText (well-formed)", () => {
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

  it("yields text from an OpenAI-shaped stream (terminated by [DONE])", async () => {
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

describe("streamText (incremental vs malformed)", () => {
  it("buffers a delta split across chunk boundaries (partial — not thrown)", async () => {
    async function* chunks() {
      // The event is split mid-payload across two chunks; the parser must
      // buffer the first half and only emit once the blank-line separator lands.
      yield 'data: {"choices":[{"delta":{"content":"Hel';
      yield 'lo"}}]}\n\n';
      yield "data: [DONE]\n\n";
    }
    const out: string[] = [];
    for await (const t of streamText(chunks())) out.push(t);
    expect(out.join("")).toBe("Hello");
  });

  it("THROWS when a fully-framed event carries malformed JSON", async () => {
    async function* chunks() {
      yield 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
      yield "data: {definitely not json}\n\n"; // complete frame, broken payload
    }
    const fn = async () => {
      const out: string[] = [];
      for await (const t of streamText(chunks())) out.push(t);
    };
    await expect(fn()).rejects.toThrow(SSEPayloadError);
  });

  it("THROWS on a truncated stream (final delta cut off, flushed at end-of-input)", async () => {
    async function* chunks() {
      yield 'data: {"choices":[{"delta":{"content":"start"}}]}\n\n';
      // Connection drops mid-event: no trailing blank line. flush() force-
      // dispatches the partial frame; its JSON is incomplete → must throw.
      yield 'data: {"choices":[{"delta":{"content":"tail';
    }
    const fn = async () => {
      const out: string[] = [];
      for await (const t of streamText(chunks())) out.push(t);
    };
    await expect(fn()).rejects.toThrow(SSEPayloadError);
  });

  it("does NOT throw when a truncated tail is the [DONE] sentinel", async () => {
    async function* chunks() {
      yield 'data: {"choices":[{"delta":{"content":"done"}}]}\n\n';
      yield "data: [DONE]"; // no trailing newline; flushed as a complete sentinel
    }
    const out: string[] = [];
    for await (const t of streamText(chunks())) out.push(t);
    expect(out.join("")).toBe("done");
  });
});
