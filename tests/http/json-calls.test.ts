/**
 * A call's body must say it is JSON (SHFT-2831).
 *
 * A browser sends a `text/plain`, urlencoded or multipart POST to
 * another origin without a CORS preflight, carrying whatever cookie it
 * holds for this one. `/query`, `/mutate` and `/action` parsed any body
 * as JSON, so such a request ran the call. Now:
 *   - a body whose Content-Type is not `application/json` is a 415, and
 *     no query, mutation or action runs
 *   - `application/json` with parameters, in any case, is a call
 *   - behind `bodyParser`, which has already read the body, the same
 *   - over a socket, the refused body is drained: the client reads the
 *     415 and the connection serves the next request
 *   - webhooks are not calls, and take whatever their sender sends
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../../src/adapters/sqlite.js";
import { Vex } from "../../src/core/engine.js";
import { bodyParser, createRouter, vexHandler } from "../../src/http/index.js";

let vex: Vex;
/** Every call the engine ran. */
const ran: string[] = [];

beforeAll(async () => {
  vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    plugins: [
      {
        name: "marks",
        tables: {},
        queries: {
          read: { args: {}, handler: async () => "read" },
        },
        mutations: {
          make: { args: {}, handler: async () => "made" },
        },
        actions: {
          run: { args: {}, handler: async () => "ran" },
        },
        webhooks: {
          hook: {
            path: "/hook",
            handler: async (_ctx, req) => ({ got: req.rawBody }),
          },
        },
      },
    ],
  });
  vex.use((_ctx, info, next) => {
    ran.push(`${info.type} ${info.name}`);
    return next();
  });
});

afterAll(async () => {
  await vex.close();
});

const CALLS = [
  ["query", "marks.read", "read"],
  ["mutate", "marks.make", "made"],
  ["action", "marks.run", "ran"],
] as const;

const NOT_JSON = { error: "Content-Type must be application/json" };

/** A call to `verb` whose body is `{ name }`, sent as `contentType`;
 *  none when null. The body is bytes, so nothing supplies a type. */
function call(verb: string, name: string, contentType: string | null) {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers["content-type"] = contentType;
  return new Request(`http://x/${verb}`, {
    method: "POST",
    headers,
    body: new TextEncoder().encode(JSON.stringify({ name })),
  });
}

describe("a call whose body does not say it is JSON", () => {
  test.each([
    ["text/plain"],
    ["text/plain;charset=UTF-8"],
    ["application/x-www-form-urlencoded"],
    ["multipart/form-data; boundary=x"],
    ["application/jsonp"],
    ["text/plain; application/json"],
    ["application/json-patch+json"],
    [""],
    [null],
  ])("sent as %p is a 415, and nothing runs", async (contentType) => {
    const app = vexHandler(vex);
    ran.length = 0;
    for (const [verb, name] of CALLS) {
      const res = await app.handle(call(verb, name, contentType));
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual(NOT_JSON);
    }
    expect(ran).toEqual([]);
  });

  test("is refused before its name is looked at", async () => {
    const app = vexHandler(vex);
    const res = await app.handle(
      new Request("http://x/mutate", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{",
      }),
    );
    expect(res.status).toBe(415);
  });

  test("behind bodyParser, which has read it already, is a 415 too", async () => {
    const app = createRouter().use(bodyParser()).mount("/vex", vexHandler(vex));
    ran.length = 0;
    const res = await app.handle(
      new Request("http://x/vex/mutate", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ name: "marks.make" }),
      }),
    );
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual(NOT_JSON);
    expect(ran).toEqual([]);
  });
});

describe("a call whose body says it is JSON", () => {
  test.each([
    ["application/json"],
    ["application/json; charset=utf-8"],
    ["Application/JSON;charset=UTF-8"],
    ["  application/json  "],
  ])("sent as %p runs", async (contentType) => {
    const app = vexHandler(vex);
    for (const [verb, name, answer] of CALLS) {
      const res = await app.handle(call(verb, name, contentType));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: answer });
    }
  });
});

describe("webhooks", () => {
  test("take whatever their sender sends", async () => {
    const app = vexHandler(vex);
    const res = await app.handle(
      new Request("http://x/webhook/hook", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: "a=1" });
  });
});

describe("over a socket", () => {
  test("a page's text/plain POST is refused, drained, and the connection serves the next call", async () => {
    const app = vexHandler(vex);
    const server = Bun.serve({ port: 0, fetch: (req) => app.handle(req) });
    try {
      const url = `http://127.0.0.1:${server.port}/action`;
      ran.length = 0;
      // What a form or a no-cors fetch on another origin sends.
      const refused = await fetch(url, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ name: "marks.run", pad: "x".repeat(4096) }),
      });
      expect(refused.status).toBe(415);
      expect(refused.headers.get("connection")).not.toBe("close");
      expect(await refused.json()).toEqual(NOT_JSON);
      expect(ran).toEqual([]);

      const next = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "marks.run" }),
      });
      expect(await next.json()).toEqual({ data: "ran" });
      expect(ran).toEqual(["action marks.run"]);
    } finally {
      server.stop(true);
    }
  });
});
