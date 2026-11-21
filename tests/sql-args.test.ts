import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { UNRESTRICTED } from "../src/core/access.js";
import { ArgsError } from "../src/core/args-error.js";
import { Vex } from "../src/core/engine.js";
import type { StorageAdapter } from "../src/core/storage.js";
import type { TableSchema, VexUser } from "../src/core/types.js";

// The query builder writes a filter's operator, a sort direction, a
// limit, an offset and a groupBy aggregate into SQL as text. Typed callers cannot send
// anything else, but an operation's args arrive untyped, so each
// position refuses what it does not know instead of writing it
// (SHFT-2955). One test per position, through every builder that
// writes it: the main builder, distinct() and groupBy(); then the same
// refusals from an access-governed table, whose restricted reads
// apply them in JS.

const schema: TableSchema = {
  columns: {
    owner: { type: "string" },
    note: { type: "string" },
  },
};

let adapter: StorageAdapter;

beforeEach(async () => {
  adapter = sqliteAdapter(":memory:");
  await adapter.ensureTable("notes", schema);
  await adapter.insert("notes", { owner: "alice", note: "a1" });
  await adapter.insert("notes", { owner: "alice", note: "a2" });
  await adapter.insert("notes", { owner: "bob", note: "secret" });
});

afterEach(async () => {
  await adapter.close();
});

async function refused(read: () => Promise<unknown>, pattern: RegExp) {
  let caught: unknown;
  try {
    await read();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ArgsError);
  expect((caught as ArgsError).status).toBe(400);
  expect((caught as Error).message).toMatch(pattern);
}

describe("filter operator", () => {
  // A trailing OR would defeat every other filter in the clause.
  const injected = "= 'alice' OR 1 = 1 OR \"owner\" =" as any;

  test("an operator outside the allow-list is refused", async () => {
    await refused(
      () => adapter.query("notes").where("owner", injected, "x").all(),
      /operator/,
    );
    await refused(
      () => adapter.query("notes").where("owner", "LIKE" as any, "%").all(),
      /operator/,
    );
    await refused(
      () =>
        adapter
          .query("notes")
          .whereAny([[{ column: "owner", operator: injected, value: "x" }]])
          .count(),
      /operator/,
    );
    await refused(
      () =>
        adapter.query("notes").where("owner", injected, "x").distinct("note"),
      /operator/,
    );
    await refused(
      async () =>
        await adapter
          .query("notes")
          .groupBy("owner", { n: "count" })
          .having("n", injected, 0),
      /operator/,
    );
  });

  test("every allowed operator still reads", async () => {
    const counts = { "=": 2, "!=": 1, "<": 0, ">": 1, "<=": 2, ">=": 3 };
    for (const [op, n] of Object.entries(counts)) {
      expect(
        await adapter
          .query("notes")
          .where("owner", op as any, "alice")
          .count(),
      ).toBe(n);
    }
    expect(
      await adapter.query("notes").where("owner", "IN", ["bob"]).count(),
    ).toBe(1);
  });
});

describe("sort direction", () => {
  const injected = "ASC, (SELECT 1 FROM sqlite_master)" as any;

  test("a direction other than asc or desc is refused", async () => {
    await refused(
      () => adapter.query("notes").order("note", injected).all(),
      /direction/,
    );
    await refused(
      () => adapter.query("notes").order("note", "DESC" as any).all(),
      /direction/,
    );
    await refused(
      () => adapter.query("notes").order("note", injected).distinct("note"),
      /direction/,
    );
    await refused(
      async () =>
        await adapter
          .query("notes")
          .groupBy("owner", { n: "count" })
          .order("owner", injected),
      /direction/,
    );
  });

  test("asc and desc still sort", async () => {
    const asc = await adapter.query("notes").order("note", "asc").all<any>();
    const desc = await adapter.query("notes").order("note", "desc").all<any>();
    expect(asc.map((r) => r.note)).toEqual(["a1", "a2", "secret"]);
    expect(desc.map((r) => r.note)).toEqual(["secret", "a2", "a1"]);
  });
});

describe("limit", () => {
  // The finding's payload: a boolean-blind probe through a limit arg.
  const injected = "5 OR 1" as any;

  test("anything but a non-negative safe integer is refused", async () => {
    for (const bad of [injected, "5", -1, 1.5, NaN, 2 ** 53, {}]) {
      await refused(
        () => adapter.query("notes").limit(bad).all(),
        /limit must be/,
      );
    }
    await refused(
      () => adapter.query("notes").limit(injected).distinct("note"),
      /limit must be/,
    );
    await refused(
      async () =>
        await adapter
          .query("notes")
          .groupBy("owner", { n: "count" })
          .limit(injected),
      /limit must be/,
    );
  });

  test("a valid limit still windows, zero included", async () => {
    expect(await adapter.query("notes").limit(2).all()).toHaveLength(2);
    expect(await adapter.query("notes").limit(0).all()).toHaveLength(0);
    expect(
      await adapter.query("notes").order("owner").limit(1).distinct("owner"),
    ).toEqual(["alice"]);
    expect(
      await adapter.query("notes").groupBy("owner", { n: "count" }).limit(1),
    ).toHaveLength(1);
  });

  test("first() leaves the builder's limit as it was when it throws", async () => {
    const builder = adapter.query("notes").offset("x" as any);
    await refused(() => builder.first(), /offset must be/);
    builder.offset(0);
    expect(await builder.all()).toHaveLength(3);
  });
});

describe("offset", () => {
  const injected = "0 UNION SELECT name, sql, 1, 1 FROM sqlite_master" as any;

  test("anything but a non-negative safe integer is refused", async () => {
    for (const bad of [injected, "1", -1, 0.5, Infinity]) {
      await refused(
        () => adapter.query("notes").limit(10).offset(bad).all(),
        /offset must be/,
      );
      // Without a limit, the offset rides on LIMIT -1.
      await refused(
        () => adapter.query("notes").offset(bad).all(),
        /offset must be/,
      );
    }
    await refused(
      () => adapter.query("notes").offset(injected).distinct("note"),
      /offset must be/,
    );
  });

  test("a valid offset still skips, with or without a limit", async () => {
    const q = () => adapter.query("notes").order("note");
    expect((await q().offset(1).all<any>()).map((r) => r.note)).toEqual([
      "a2",
      "secret",
    ]);
    expect((await q().limit(1).offset(2).all<any>())[0].note).toBe("secret");
    expect(
      await adapter.query("notes").order("owner").offset(1).distinct("owner"),
    ).toEqual(["bob"]);
  });
});

describe("aggregate", () => {
  test("a function outside sum avg min max countDistinct is refused", async () => {
    for (const bad of [
      ["sum(1)) FROM sqlite_master --", "note"],
      ["SUM", "note"],
      "count(*)",
      ["max"],
      {},
    ]) {
      await refused(
        async () =>
          await adapter.query("notes").groupBy("owner", { v: bad as any }),
        /aggregate/,
      );
    }
  });

  test("every allowed aggregate still reads", async () => {
    const [alice] = await adapter
      .query("notes")
      .groupBy("owner", {
        n: "count",
        notes: ["countDistinct", "note"],
        first: ["min", "note"],
        last: ["max", "note"],
      })
      .order("owner", "asc")
      .limit(1);
    expect(alice).toEqual({
      owner: "alice",
      n: 2,
      notes: 2,
      first: "a1",
      last: "a2",
    });
  });
});

describe("an access-governed table", () => {
  const member: VexUser = { id: "alice", name: "Alice", isAdmin: false };
  const admin: VexUser = { id: "root", name: "Root", isAdmin: true };

  async function governed(): Promise<Vex> {
    const vex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api) => {
          api.setName("g");
          api.registerTable("notes", {
            ...schema,
            access: {
              prepare: (user) => (user?.isAdmin ? UNRESTRICTED : user?.id),
              row: (owner, row) => row.owner === owner,
            },
          });
          api.registerMutation("add", {
            args: { owner: "string", note: "string" },
            handler: async (ctx, args) => {
              await ctx.db.table("notes").insert(args);
            },
          });
          // Hands its args to the builder as they came, as the
          // reported call sites did.
          api.registerQuery("read", {
            args: { spec: "json" },
            handler: async (ctx, { spec }) => {
              let q = ctx.db.table("notes");
              if (spec.op) q = q.where("owner", spec.op, "alice");
              if (spec.dir) q = q.order("note", spec.dir);
              if ("limit" in spec) q = q.limit(spec.limit);
              if ("offset" in spec) q = q.offset(spec.offset);
              if (spec.terminal === "first") return q.first();
              if (spec.terminal === "distinct") return q.distinct("note");
              if (spec.terminal !== "groupBy") return q.all();
              let g = q.groupBy("owner", { v: spec.agg ?? "count" });
              if (spec.having) g = g.having("v", spec.having, 0);
              g = g.order("owner", spec.groupDir ?? "asc");
              if ("groupLimit" in spec) g = g.limit(spec.groupLimit);
              return g;
            },
          });
        },
      ],
    });
    await vex.mutate("g.add", { owner: "alice", note: "a1" });
    await vex.mutate("g.add", { owner: "bob", note: "secret" });
    return vex;
  }

  test("refuses each position alike for restricted and unrestricted callers", async () => {
    const vex = await governed();
    try {
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ op: "= 'alice' OR 1 = 1 OR \"owner\" =" }, /operator/],
        [{ dir: "DESC" }, /direction/],
        [{ limit: "5 OR 1" }, /limit must be/],
        [{ limit: "5" }, /limit must be/],
        [{ offset: "1" }, /offset must be/],
        [{ offset: "1", terminal: "first" }, /offset must be/],
        [{ limit: -1, terminal: "distinct" }, /limit must be/],
        [{ terminal: "groupBy", agg: ["SUM", "note"] }, /aggregate/],
        [{ terminal: "groupBy", having: "> 0 OR 1 =" }, /operator/],
        [{ terminal: "groupBy", groupDir: "DESC" }, /direction/],
        [{ terminal: "groupBy", groupLimit: "1" }, /limit must be/],
      ];
      for (const [spec, pattern] of cases) {
        for (const user of [member, admin]) {
          await refused(
            () => vex.query("g.read", { spec }, { user }),
            pattern,
          );
        }
      }
    } finally {
      await vex.close();
    }
  });

  test("a restricted caller's valid window still reads only their rows", async () => {
    const vex = await governed();
    try {
      expect(
        await vex.query(
          "g.read",
          { spec: { dir: "desc", limit: 5, offset: 0 } },
          { user: member },
        ),
      ).toEqual([expect.objectContaining({ owner: "alice", note: "a1" })]);
    } finally {
      await vex.close();
    }
  });
});
