import { expect, test, vi } from "vitest";
import { HttpError, postNdjson } from "./adapter.ts";

function ndjsonResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      // Split across chunks, including mid-line, the way a real socket delivers them.
      const text = lines.join("");
      controller.enqueue(encoder.encode(text.slice(0, 7)));
      controller.enqueue(encoder.encode(text.slice(7)));
      controller.close();
    },
  });
  return new Response(body, { status: 200,
                              headers: { "Content-Type": "application/x-ndjson" } });
}

test("heartbeats are ignored and the done event carries the payload", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([
    '{"type":"progress"}\n', '{"type":"progress"}\n',
    '{"type":"done","result":{"kind":"matchup"}}\n',
  ])));
  const reports: unknown[] = [];
  await expect(postNdjson("/api/team/matchup", {}, (r) => reports.push(r)))
    .resolves.toEqual({ kind: "matchup" });
  expect(reports).toEqual([]);
  vi.unstubAllGlobals();
});

test("a streamed error keeps the status the plain response would have carried", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([
    '{"type":"progress"}\n',
    '{"type":"error","status":429,"detail":{"error":{"code":"rate_limited"}}}\n',
  ])));
  await expect(postNdjson("/api/team/diagnose", {})).rejects.toMatchObject({
    status: 429,
  });
  await expect(postNdjson("/api/team/diagnose", {})).rejects.toBeInstanceOf(HttpError);
  vi.unstubAllGlobals();
});

test("a stream that ends without a done event is a transport failure", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse(['{"type":"progress"}\n'])));
  await expect(postNdjson("/api/qa", {})).rejects.toMatchObject({ status: 502 });
  vi.unstubAllGlobals();
});
