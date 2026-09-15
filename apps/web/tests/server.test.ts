import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";

import {
  allowedNetworks,
  ArenaState,
  createDemoServer,
  DemoConflictError,
  DemoInputError,
  main,
  MAX_REQUEST_BYTES,
  parseCanonicalJson,
  STATIC_FILES,
} from "../server.ts";

interface DuelPayload {
  compatible: boolean;
  expected_revision: number;
  mode: "binary" | "scalar";
  players: {
    a: { certainty_ppm: number; coverage_ppm: number; form: number };
    b: { certainty_ppm: number; coverage_ppm: number; form: number };
  };
  request_id: string;
  raw_history?: string;
}

function duelPayload(options: {
  revision?: number;
  requestId?: string;
  mode?: "binary" | "scalar";
  compatible?: boolean;
  confidenceB?: number;
} = {}): DuelPayload {
  return {
    compatible: options.compatible ?? true,
    expected_revision: options.revision ?? 0,
    mode: options.mode ?? "scalar",
    players: {
      a: { certainty_ppm: 800_000, coverage_ppm: 900_000, form: 700 },
      b: {
        certainty_ppm: options.confidenceB ?? 600_000,
        coverage_ppm: 750_000,
        form: 500,
      },
    },
    request_id: options.requestId ?? "1".repeat(32),
  };
}

describe("ArenaState", () => {
  test("default scalar duel is rated and zero-sum", () => {
    const result = new ArenaState().duel(duelPayload());
    assert.equal(result.rating_effect, "rated");
    assert.equal(result.players.a.applied_delta_milli, 14_623);
    assert.equal(result.players.b.applied_delta_milli, -14_623);
    assert.equal(result.calculation.k, 64);
    assert.equal(result.state.revision, 1);
  });

  test("binary uses its own stream", () => {
    const arena = new ArenaState();
    const scalar = arena.duel(duelPayload());
    const binary = arena.duel(duelPayload({ revision: 1, requestId: "2".repeat(32), mode: "binary" }));
    assert.equal(binary.players.a.applied_delta_milli, 19_200);
    assert.equal(
      binary.state.players.a.streams.scalar.rating_milli,
      scalar.state.players.a.streams.scalar.rating_milli,
    );
    assert.equal(binary.state.players.a.streams.binary.rating_milli, 1_219_200);
  });

  test("low confidence and incompatibility are exhibitions", () => {
    const low = new ArenaState().duel(duelPayload({ confidenceB: 499_999 }));
    assert.equal(low.rating_effect, "exhibition");
    assert.deepEqual(low.exhibition_reasons, ["low_confidence"]);
    assert.equal(low.players.a.applied_delta_milli, 0);
    assert.equal(low.players.a.rated_matches_after, 0);

    const incompatible = new ArenaState().duel(duelPayload({ compatible: false }));
    assert.equal(incompatible.rating_effect, "exhibition");
    assert.deepEqual(incompatible.exhibition_reasons, ["incompatible_context"]);
  });

  test("confidence boundary is inclusive", () => {
    assert.equal(new ArenaState().duel(duelPayload({ confidenceB: 500_000 })).rating_effect, "rated");
  });

  test("established preset uses K32", () => {
    const arena = new ArenaState();
    const reset = arena.reset({
      expected_revision: 0,
      preset: "established",
      request_id: "3".repeat(32),
    });
    const result = arena.duel(
      duelPayload({ revision: reset.state.revision, requestId: "4".repeat(32) }),
    );
    assert.equal(result.calculation.k, 32);
  });

  test("idempotent retry applies once", () => {
    const arena = new ArenaState();
    const payload = duelPayload();
    assert.deepEqual(arena.duel(payload), arena.duel(payload));
    assert.equal(arena.snapshot().revision, 1);
  });

  test("stale revisions and reused request IDs are rejected", () => {
    const arena = new ArenaState();
    arena.duel(duelPayload());
    assert.throws(
      () => arena.duel(duelPayload({ requestId: "2".repeat(32) })),
      (error: unknown) => error instanceof DemoConflictError && error.code === "stale_state",
    );
    assert.throws(
      () => arena.duel(duelPayload({ compatible: false })),
      (error: unknown) => error instanceof DemoConflictError && error.code === "request_id_reused",
    );
  });

  test("unknown and private fields are rejected", () => {
    const privatePayload = duelPayload();
    privatePayload.raw_history = "PRIVATE_CANARY";
    assert.throws(() => new ArenaState().duel(privatePayload), DemoInputError);
    const booleanForm = duelPayload() as unknown as { players: { a: { form: boolean } } };
    booleanForm.players.a.form = true;
    assert.throws(() => new ArenaState().duel(booleanForm), DemoInputError);
  });
});

describe("canonical request parser", () => {
  test("rejects duplicate keys, floats, unsafe integers, and non-ASCII strings", () => {
    for (const source of [
      '{"mode":"scalar","mode":"binary"}',
      '{"value":1.0}',
      '{"value":9007199254740992}',
      '{"value":"caf\\u00e9"}',
      '{"value":-0}',
    ]) {
      assert.throws(() => parseCanonicalJson(source));
    }
  });
});

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

describe("HTTP boundary", () => {
  const token = "T".repeat(43);
  const server = createDemoServer({
    host: "127.0.0.1",
    port: 0,
    allowedCidrs: ["127.0.0.0/8"],
    token,
  });
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  function request(
    method: string,
    path: string,
    options: {
      body?: string;
      token?: string;
      origin?: string;
      host?: string;
      contentType?: string;
    } = {},
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const body = options.body;
      const headers: Record<string, string | number> = { Host: options.host ?? "127.0.0.1:0" };
      if (options.token !== undefined) headers["X-Computer-Elo-Token"] = options.token;
      if (options.origin !== undefined) headers.Origin = options.origin;
      if (options.contentType !== undefined) headers["Content-Type"] = options.contentType;
      if (body !== undefined) headers["Content-Length"] = Buffer.byteLength(body);
      const request = httpRequest(
        { host: "127.0.0.1", port, method, path, headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }));
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  }

  test("serves the page with security headers", async () => {
    const result = await request("GET", "/");
    assert.equal(result.status, 200);
    assert.match(result.body.toString("utf8"), /Elo Ra Kings/);
    assert.match(String(result.headers["content-security-policy"]), /default-src 'none'/);
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  });

  test("serves transpiled browser TypeScript", async () => {
    const result = await request("GET", "/app.js");
    assert.equal(result.status, 200);
    assert.match(result.body.toString("utf8"), /computerEloRoomToken/);
    assert.doesNotMatch(result.body.toString("utf8"), /interface RoomState/);
  });

  test("requires a capability token and valid host", async () => {
    assert.equal((await request("GET", "/api/state")).status, 401);
    assert.equal((await request("GET", "/api/state", { token: "wrong" })).status, 401);
    assert.equal((await request("GET", "/api/state", { token })).status, 200);
    assert.equal((await request("GET", "/", { host: "evil.example" })).status, 403);
  });

  test("mutation requires same origin", async () => {
    const body = JSON.stringify(duelPayload());
    const denied = await request("POST", "/api/duel", {
      body,
      token,
      origin: "http://evil.example",
      contentType: "application/json",
    });
    assert.equal(denied.status, 403);
    const accepted = await request("POST", "/api/duel", {
      body,
      token,
      origin: "http://127.0.0.1:0",
      contentType: "application/json",
    });
    assert.equal(accepted.status, 200);
  });

  test("malformed, private, duplicate, and oversized requests do not leak", async () => {
    const common = {
      token,
      origin: "http://127.0.0.1:0",
      contentType: "application/json",
    };
    const privateResult = await request("POST", "/api/duel", {
      ...common,
      body: '{"raw_history":"PRIVATE_CANARY"}',
    });
    assert.equal(privateResult.status, 400);
    assert.doesNotMatch(privateResult.body.toString("utf8"), /PRIVATE_CANARY/);
    assert.equal((await request("POST", "/api/duel", {
      ...common,
      body: '{"mode":"scalar","mode":"binary"}',
    })).status, 400);
    assert.equal((await request("POST", "/api/duel", {
      ...common,
      body: "x".repeat(MAX_REQUEST_BYTES + 1),
    })).status, 400);
  });

  test("unknown routes and methods are closed", async () => {
    assert.equal((await request("GET", "/../README.md")).status, 404);
    assert.equal((await request("GET", "/%2e%2e/README.md")).status, 404);
    assert.equal((await request("OPTIONS", "/api/duel")).status, 405);
  });
});

describe("server configuration", () => {
  test("public and unrestricted CIDRs are rejected", () => {
    assert.throws(() => allowedNetworks(["0.0.0.0/0"]), DemoInputError);
    assert.throws(() => allowedNetworks(["8.8.8.0/24"]), DemoInputError);
    assert.equal(allowedNetworks(["192.168.4.0/24"]).length, 1);
  });

  test("wildcard binding is rejected before listen", async () => {
    assert.equal(await main(["--host", "0.0.0.0"]), 2);
  });
});
