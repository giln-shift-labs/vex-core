import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { UNRESTRICTED } from "../src/core/access.js";
import { ArgsError } from "../src/core/args-error.js";
import { Vex } from "../src/core/engine.js";
import type { StorageAdapter } from "../src/core/storage.js";
import type { TableSchema, VexUser } from "../src/core/types.js";

// The query builder writes names, a filter's operator, a sort
// direction, a limit, an offset and a groupBy aggregate into SQL as
// text. Typed callers cannot send anything else, but an operation's
// args arrive untyped, so each position refuses what it does not know
// instead of writing it (SHFT-2955). One test per position, through
// every builder that writes it (the main builder, distinct() and
// groupBy()); then the same refusals from an access-governed table,
// whose restricted reads apply them in JS, from a subscription, whose
// reads are tracked, and for the shapes of filters, rows and holds.

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
              if ("select" in spec) q = q.select(spec.select);
              if (spec.op) q = q.where("owner", spec.op, "alice");
              if (spec.dir) q = q.order("note", spec.dir);
              if ("limit" in spec) q = q.limit(spec.limit);
              if ("offset" in spec) q = q.offset(spec.offset);
              if (spec.terminal === "first") return q.first();
              if (spec.terminal === "distinct") {
                return q.distinct(spec.col ?? "note");
              }
              if (spec.terminal !== "groupBy") return q.all();
              let g = q.groupBy(spec.groupCols ?? "owner", {
                v: spec.agg ?? "count",
              });
              if (spec.having) g = g.having("v", spec.having, 0);
              if ("havingCol" in spec) g = g.having(spec.havingCol, ">", 0);
              g = g.order(spec.groupOrder ?? "owner", spec.groupDir ?? "asc");
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
        // Names a restricted read without a narrowing looks up in JS.
        [{ select: {} }, /name/],
        [{ terminal: "distinct", col: "" }, /name/],
        [{ terminal: "groupBy", groupCols: [] }, /needs a column/],
        [{ terminal: "groupBy", groupCols: [{}] }, /name/],
        [{ terminal: "groupBy", havingCol: {} }, /name/],
        [{ terminal: "groupBy", groupOrder: 5 }, /name/],
        [{ terminal: "groupBy", groupOrder: "" }, /name/],
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

  test("a restricted HAVING compares values as SQL binds them", async () => {
    const vex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api) => {
          api.setName("h");
          api.registerTable("t", {
            columns: {
              owner: { type: "string" },
              on: { type: "boolean" },
              meta: { type: "json" },
            },
            access: {
              prepare: (user) => (user?.isAdmin ? UNRESTRICTED : user?.id),
              row: (owner, row) => row.owner === owner,
            },
          });
          api.registerMutation("add", {
            args: { row: "json" },
            handler: (ctx, { row }) => ctx.db.table("t").insert(row),
          });
          api.registerQuery("having", {
            args: { col: "string", value: "json" },
            handler: (ctx, { col, value }) =>
              ctx.db
                .table("t")
                .groupBy(["owner", col], { n: "count" })
                .having(col, "=", value)
                .order("owner"),
          });
        },
      ],
    });
    try {
      for (const [on, k] of [
        [true, 1],
        [false, 2],
      ] as const) {
        await vex.mutate("h.add", { row: { owner: "alice", on, meta: { k } } });
      }
      // A boolean binds as 1 or 0, an object as its JSON text.
      for (const [col, value] of [
        ["on", true],
        ["meta", { k: 1 }],
      ] as const) {
        const asMember = await vex.query(
          "h.having",
          { col, value },
          { user: member },
        );
        const asAdmin = await vex.query(
          "h.having",
          { col, value },
          { user: admin },
        );
        expect(asMember).toHaveLength(1);
        expect(asMember).toEqual(asAdmin);
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

describe("names", () => {
  test("a name that is not a non-empty string without NUL is refused", async () => {
    // Quoting holds only for a string: an object answers it with any text.
    const evil = { replaceAll: () => 'x" FROM sqlite_master --' } as any;
    // SQLite ends a statement at a NUL, cutting off what follows.
    for (const bad of [evil, "own\0er", "", null, 5, ["owner"], {}]) {
      await refused(() => adapter.query("notes").select(bad).all(), /name/);
      await refused(
        () => adapter.query("notes").where(bad, "=", 1).all(),
        /name/,
      );
      // No order column (null) is no ORDER BY: nothing is written.
      if (bad !== null) {
        await refused(() => adapter.query("notes").order(bad).all(), /name/);
      }
      await refused(() => adapter.query("notes").sum(bad), /name/);
      // groupBy takes a list of columns as well as one.
      await refused(
        async () =>
          await adapter
            .query("notes")
            .groupBy(Array.isArray(bad) ? [bad] : bad, { n: "count" }),
        /name/,
      );
      await refused(
        async () =>
          await adapter
            .query("notes")
            .groupBy("owner", { n: ["max", bad] }),
        /name|aggregate/,
      );
      await refused(() => adapter.query(bad).all(), /name/);
    }
  });

  test("a name holding quotes is still one quoted name", async () => {
    const name = 'x" FROM sqlite_master --';
    // SQLite reads a quoted name no column has as a string literal, so
    // the whole name comes back as the value and nothing else is read.
    const rows = await adapter.query("notes").select(name).all();
    expect(rows.map((row) => Object.values(row))).toEqual([
      [name],
      [name],
      [name],
    ]);
  });

  test("groupBy needs a column", async () => {
    await refused(
      async () => await adapter.query("notes").groupBy([], { n: "count" }),
      /needs a column/,
    );
  });
});

describe("conditions", () => {
  test("whereAny takes arrays of filter objects, nothing else", async () => {
    for (const bad of [null, "x", {}, [null], ["x"], [{}]]) {
      await refused(
        () =>
          adapter
            .query("notes")
            .whereAny(bad as any)
            .all(),
        /whereAny|filter/,
      );
    }
    for (const bad of [[[null]], [["x"]], [[[]]]]) {
      await refused(
        () =>
          adapter
            .query("notes")
            .whereAny(bad as any)
            .all(),
        /filter/,
      );
    }
  });
});

describe("writes", () => {
  async function engine(): Promise<Vex> {
    const vex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api) => {
          api.setName("w");
          api.registerTable("notes", schema);
          api.registerMutation("call", {
            args: { op: "string", a: "json", b: "json" },
            handler: async (ctx, { op, a, b }) =>
              (ctx.db.table("notes") as any)[op](a, b),
          });
        },
      ],
    });
    return vex;
  }

  test("a row, keys or data that is not an object is refused", async () => {
    const vex = await engine();
    try {
      const id = await vex.mutate("w.call", {
        op: "insert",
        a: { owner: "alice", note: "a1" },
      });
      for (const bad of [null, "owner", 5, ["owner"]]) {
        await refused(
          () => vex.mutate("w.call", { op: "insert", a: bad }),
          /insert\(row\) must be an object/,
        );
        await refused(
          () => vex.mutate("w.call", { op: "update", a: id, b: bad }),
          /update\(…, data\) must be an object/,
        );
        await refused(
          () => vex.mutate("w.call", { op: "upsert", a: bad, b: {} }),
          /upsert\(keys\) must be an object/,
        );
        await refused(
          () =>
            vex.mutate("w.call", { op: "upsert", a: { owner: "x" }, b: bad }),
          /upsert\(…, data\) must be an object/,
        );
      }
      // A filtered delete's column keys what it records.
      await refused(
        () =>
          vex.mutate("w.call", { op: "where", a: { toString: "x" }, b: "=" }),
        /name/,
      );
      for (const id of [null, { toString: "x" }]) {
        await refused(
          () => vex.mutate("w.call", { op: "update", a: id, b: {} }),
          /needs a row id/,
        );
      }
    } finally {
      await vex.close();
    }
  });

  test("an upsert with no key is refused rather than overwriting a row", async () => {
    const vex = await engine();
    try {
      await vex.mutate("w.call", {
        op: "insert",
        a: { owner: "alice", note: "a1" },
      });
      await refused(
        () =>
          vex.mutate("w.call", { op: "upsert", a: {}, b: { note: "gone" } }),
        /needs a key/,
      );
      expect(await vex.unsafeSql<any>("SELECT note FROM notes")).toEqual([
        { note: "a1" },
      ]);
    } finally {
      await vex.close();
    }
  });
});

describe("sqlOver", () => {
  test("a hold that is neither filters nor { where, reads } is refused", async () => {
    const vex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api) => {
          api.setName("o");
          api.registerTable("notes", schema);
          api.registerQuery("over", {
            args: { hold: "json" },
            reactive: false,
            handler: (ctx, { hold }) =>
              ctx.db.sqlOver({ notes: hold }, 'SELECT * FROM "notes"'),
          });
        },
      ],
    });
    try {
      for (const bad of [null, "x", 5, {}, { where: [] }, { reads: [] }]) {
        await refused(() => vex.query("o.over", { hold: bad }), /hold/);
      }
      for (const bad of [[null], [{ column: "owner", operator: "LIKE" }]]) {
        await refused(
          () => vex.query("o.over", { hold: bad }),
          /filter|operator/,
        );
      }
      expect(await vex.query("o.over", { hold: [] })).toEqual([]);
    } finally {
      await vex.close();
    }
  });
});

describe("groupBy aggregates", () => {
  test("aggregates that are not an object of definitions are refused", async () => {
    for (const bad of [null, "count", ["count"], 5]) {
      await refused(
        async () =>
          await adapter.query("notes").groupBy("owner", bad as any),
        /aggregates must be an object/,
      );
    }
  });
});

describe("internal tables", () => {
  test("ctx.db.table() refuses SQLite's tables and the storage's bookkeeping", async () => {
    const vex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api) => {
          api.setName("i");
          api.registerTable("notes", schema);
          api.registerQuery("read", {
            args: { table: "string" },
            reactive: false,
            handler: (ctx, { table }) => ctx.db.table(table).all(),
          });
          api.registerMutation("write", {
            args: { table: "string" },
            handler: (ctx, { table }) => ctx.db.table(table).count(),
          });
        },
      ],
    });
    try {
      for (const table of [
        "sqlite_master",
        "sqlite_schema",
        "SQLITE_MASTER",
        "sqlite_stat1",
        "sqlite_sequence",
        "__vex_sqlite_indexes",
        "__VEX_sqlite_indexes",
      ]) {
        await refused(() => vex.query("i.read", { table }), /is internal/);
        await refused(() => vex.mutate("i.write", { table }), /is internal/);
      }
      // An app's own tables, the engine's _spans and _jobs included, still read.
      expect(await vex.query("i.read", { table: "notes" })).toEqual([]);
      expect(await vex.query("i.read", { table: "_spans" })).toEqual([]);
      // So does the engine's own reader of a table by name.
      await refused(() => vex.readTable("sqlite_master"), /is internal/);
      await refused(
        () => vex.describeTable("__vex_sqlite_indexes"),
        /is internal/,
      );
      expect((await vex.readTable("notes")).total).toBe(0);
    } finally {
      await vex.close();
    }
  });

  test("no table is registered under a name it could not be read by", async () => {
    for (const name of ["__vex_cache", "__VEX_x", "sqlite_mine"]) {
      await expect(
        Vex.create({
          storage: sqliteAdapter(":memory:"),
          plugins: [
            (api) => {
              api.setName("r");
              api.registerTable(name, schema);
            },
          ],
        }),
      ).rejects.toThrow("reserved internal table name");
    }
  });
});

describe("subscriptions", () => {
  test("a tracked read refuses a malformed shape as a one-shot read does", async () => {
    const vex = await Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: [
        (api) => {
          api.setName("s");
          api.registerTable("notes", schema);
          api.registerQuery("read", {
            args: { any: "json", aggs: "json" },
            handler: (ctx, { any, aggs }) =>
              aggs === undefined
                ? ctx.db.table("notes").whereAny(any).all()
                : ctx.db
                    .table("notes")
                    .groupBy("owner", aggs)
                    .order("owner"),
          });
        },
      ],
    });
    try {
      // Subscriptions record what they read, reading the shape first.
      for (const any of [null, "x", {}]) {
        await refused(
          () => vex.subscribe("s.read", { any }, () => {}),
          /whereAny/,
        );
      }
      for (const aggs of [null, "count", ["count"]]) {
        await refused(
          () => vex.subscribe("s.read", { aggs }, () => {}),
          /aggregates must be an object/,
        );
      }
      // A filter is checked before it is recorded and filed.
      for (const column of [{ toString: "x" }, ""]) {
        await refused(
          () =>
            vex.subscribe(
              "s.read",
              { any: [[{ column, operator: "=", value: 1 }]] },
              () => {},
            ),
          /name/,
        );
      }
    } finally {
      await vex.close();
    }
  });
});
