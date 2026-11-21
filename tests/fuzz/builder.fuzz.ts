/**
 * Fuzzes the query builder for SQL injection.
 *
 *   bun tests/fuzz/builder.fuzz.ts [randomCases] [seed]
 *
 * Every builder method, in every argument position, is fed hostile
 * values: through the engine as JSON args (what a caller can send) on
 * a plain table and an access-governed one, as a member and an admin,
 * and straight to the adapter with values JSON cannot carry. Each case
 * is judged by four oracles:
 *
 *   structure  a payload's marker appears in executed SQL outside a
 *              correctly quoted identifier (it became SQL code)
 *   integrity  the canary row or the schema changed
 *   leak       a result carries the canary's secret, or schema SQL
 *              (an internal table read through ctx.db.table())
 *   syntax     SQLite reported a syntax error: a value changed the
 *              statement's shape even if it did not run
 *
 * Exits 1 when any oracle fires.
 */

import { Database } from "bun:sqlite";
import { sqliteAdapter } from "../../src/adapters/sqlite.js";
import { UNRESTRICTED } from "../../src/core/access.js";
import { Vex } from "../../src/core/engine.js";
import type { VexUser } from "../../src/core/types.js";

const MARK = "ZQX";
const SECRET = "CANARYSECRET";

// --- SQL capture -------------------------------------------------------

let captured: string[] = [];
{
  const proto = Database.prototype as any;
  for (const method of ["prepare", "query"]) {
    const original = proto[method];
    proto[method] = function (sql: string, ...rest: unknown[]) {
      captured.push(sql);
      return original.call(this, sql, ...rest);
    };
  }
  for (const method of ["exec", "run"]) {
    const original = proto[method];
    proto[method] = function (sql: string, ...rest: unknown[]) {
      if (typeof sql === "string") captured.push(sql);
      return original.call(this, sql, ...rest);
    };
  }
}

/**
 * SQL text with every correctly quoted identifier and string literal
 * cut out, and whether a marker sat inside a string literal. What is
 * left is the statement's code.
 */
function codeOf(sql: string): { code: string; inLiteral: boolean } {
  let code = "";
  let inLiteral = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let body = "";
      for (;;) {
        if (j >= sql.length) {
          // Unterminated: the rest is code, as SQLite would refuse it.
          return { code: code + sql.slice(i), inLiteral };
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            body += c;
            j += 2;
            continue;
          }
          break;
        }
        body += sql[j];
        j++;
      }
      if (c === "'" && body.includes(MARK)) inLiteral = true;
      code += c === "'" ? "'?'" : '"?"';
      i = j + 1;
      continue;
    }
    if (c === "[") {
      const j = sql.indexOf("]", i);
      if (j < 0) return { code: code + sql.slice(i), inLiteral };
      code += "[?]";
      i = j + 1;
      continue;
    }
    code += c;
    i++;
  }
  return { code, inLiteral };
}

// --- payloads ----------------------------------------------------------

const breakouts = [
  `${MARK}`,
  `${MARK}"`,
  `${MARK}" OR 1=1 --`,
  `${MARK}"||(SELECT secret FROM canary)||"`,
  `${MARK}", (SELECT secret FROM canary) AS "x`,
  `${MARK}' OR '1'='1`,
  `${MARK}\` OR 1=1 --`,
  `${MARK}] OR 1=1 --`,
  `${MARK}" FROM canary --`,
  `${MARK}"; DROP TABLE canary; --`,
  `${MARK}/*`,
  `${MARK}*/ OR 1=1 /*`,
  `${MARK}\0" OR 1=1 --`,
  `${MARK}\u0000`,
  `${MARK}\n OR 1=1`,
  `${MARK}""`,
  `"${MARK}`,
  `""${MARK}"" OR 1=1 --`,
  `${MARK}\u201d OR 1=1 --`,
  `${MARK}\uff02 OR 1=1 --`,
  `${MARK} OR 1=1`,
  `1 OR ${MARK}=1`,
  `5 OR 1 ${MARK}`,
  `= '${MARK}' OR 1 = 1 OR "owner" =`,
  `ASC, (SELECT 1 FROM canary) ${MARK}`,
  `${MARK} UNION SELECT secret, secret, secret, secret FROM canary`,
  `sum(1)) FROM canary -- ${MARK}`,
  `${MARK}`.repeat(2000),
];

/** JSON-carriable values: what a caller can put in args. */
const jsonPayloads: unknown[] = [
  ...breakouts,
  "",
  "IN",
  "LIKE",
  "IS",
  "IS NOT",
  "NOT IN",
  "<>",
  "==",
  "GLOB",
  "MATCH",
  "DESC",
  "Asc",
  "count",
  "sum",
  "_id",
  "canary",
  "sqlite_master",
  "sqlite_schema",
  "SQLITE_MASTER",
  "sqlite_stat1",
  "__vex_sqlite_indexes",
  "__VEX_SQLITE_INDEXES",
  "main.canary",
  "notes",
  null,
  true,
  false,
  0,
  -1,
  1.5,
  1e308,
  -0,
  2 ** 53,
  "5",
  "1e3",
  [],
  [MARK],
  [`${MARK}" OR 1=1 --`, "note"],
  ["sum", `${MARK}" OR 1=1 --`],
  ["sum", "note", "extra"],
  [["sum", "note"]],
  {},
  { [MARK]: 1 },
  { any: [] },
  { toString: `${MARK}" OR 1=1 --` },
  { column: `${MARK}"`, operator: "=", value: 1 },
];

/** Values JSON cannot carry, for the adapter-level pass. */
const jsPayloads: unknown[] = [
  undefined,
  NaN,
  Infinity,
  -Infinity,
  10n,
  Symbol(MARK),
  () => `${MARK}" OR 1=1 --`,
  { toString: () => `${MARK}" OR 1=1 --` },
  { valueOf: () => 5, toString: () => `5 OR ${MARK}` },
  { replaceAll: () => `${MARK}" OR 1=1 --` },
  { [Symbol.toPrimitive]: () => `${MARK}" OR 1=1 --` },
  new String(`${MARK}" OR 1=1 --`),
  new Number(5),
  new Date(0),
  new Uint8Array([0x22, 0x20, 0x4f, 0x52]),
  Object.create(null),
];

// --- positions ---------------------------------------------------------

/** An op chain: [method, ...args]; HOLE marks the fuzzed argument. */
type Op = [string, ...unknown[]];
const HOLE = Symbol("hole");

/** Read positions, on a table named by the case. */
const readPositions: Record<string, Op[]> = {
  "where.column": [["where", HOLE, "=", "x"], ["all"]],
  "where.operator": [["where", "owner", HOLE, "x"], ["all"]],
  "where.value": [["where", "owner", "=", HOLE], ["all"]],
  "where.IN.value": [["where", "owner", "IN", HOLE], ["all"]],
  "whereAny.groups": [["whereAny", HOLE], ["all"]],
  "whereAny.column": [
    ["whereAny", [[{ column: HOLE, operator: "=", value: 1 }]]],
    ["all"],
  ],
  "whereAny.operator": [
    ["whereAny", [[{ column: "owner", operator: HOLE, value: 1 }]]],
    ["all"],
  ],
  "whereAny.value": [
    ["whereAny", [[{ column: "owner", operator: "=", value: HOLE }]]],
    ["all"],
  ],
  "select.column": [["select", HOLE], ["all"]],
  "select.second": [["select", "owner", HOLE], ["all"]],
  "order.column": [["order", HOLE, "asc"], ["all"]],
  "order.dir": [["order", "note", HOLE], ["all"]],
  limit: [["limit", HOLE], ["all"]],
  offset: [["offset", HOLE], ["all"]],
  "offset.first": [["offset", HOLE], ["first"]],
  "limit.distinct": [["limit", HOLE], ["distinct", "owner"]],
  "distinct.column": [["distinct", HOLE]],
  "countDistinct.column": [["countDistinct", HOLE]],
  "sum.column": [["sum", HOLE]],
  "avg.column": [["avg", HOLE]],
  "min.column": [["min", HOLE]],
  "max.column": [["max", HOLE]],
  "count.after.where": [["where", HOLE, HOLE, HOLE], ["count"]],
  "groupBy.columns": [["groupBy", HOLE, { n: "count" }], ["order", "n"]],
  "groupBy.aggs": [["groupBy", "owner", HOLE], ["order", "owner"]],
  "groupBy.alias": [["groupBy", "owner", { [MARK]: "count" }], ["order", "owner"]],
  "groupBy.aggDef": [["groupBy", "owner", { n: HOLE }], ["order", "owner"]],
  "groupBy.aggColumn": [
    ["groupBy", "owner", { n: ["max", HOLE] }],
    ["order", "owner"],
  ],
  "having.column": [
    ["groupBy", "owner", { n: "count" }],
    ["having", HOLE, ">", 0],
    ["order", "owner"],
  ],
  "having.operator": [
    ["groupBy", "owner", { n: "count" }],
    ["having", "n", HOLE, 0],
    ["order", "owner"],
  ],
  "having.value": [
    ["groupBy", "owner", { n: "count" }],
    ["having", "n", ">", HOLE],
    ["order", "owner"],
  ],
  "groupOrder.column": [["groupBy", "owner", { n: "count" }], ["order", HOLE]],
  "groupOrder.dir": [
    ["groupBy", "owner", { n: "count" }],
    ["order", "owner", HOLE],
  ],
  "groupLimit": [
    ["groupBy", "owner", { n: "count" }],
    ["order", "owner"],
    ["limit", HOLE],
  ],
};

/** Write positions, in a mutation (ctx.db.table is a MutationTable). */
const writePositions: Record<string, Op[]> = {
  "insert.row": [["insert", HOLE]],
  "insert.key": [["insertKey", HOLE]],
  "insert.value": [["insert", { owner: HOLE, note: "n" }]],
  "update.id": [["update", HOLE, { note: "u" }]],
  "update.data": [["update", "@id", HOLE]],
  "update.key": [["updateKey", HOLE]],
  "upsert.keys": [["upsert", HOLE, { note: "u" }]],
  "upsert.key": [["upsertKey", HOLE]],
  "upsert.data": [["upsert", { owner: "alice" }, HOLE]],
  "delete.id": [["delete", HOLE]],
  "delete.where.column": [["where", HOLE, "=", "nobody"], ["delete"]],
  "delete.where.operator": [["where", "owner", HOLE, "nobody"], ["delete"]],
  "delete.where.value": [["where", "owner", "=", HOLE], ["delete"]],
  "mutationRead.order.dir": [["order", "note", HOLE], ["all"]],
  "mutationRead.limit": [["limit", HOLE], ["all"]],
};

/** sqlOver positions: the statement is the app's, the hold is fuzzed. */
const overPositions: Record<string, unknown[]> = {
  "sqlOver.table": [HOLE, [], 'SELECT * FROM "notes"'],
  "sqlOver.filters": ["notes", HOLE, 'SELECT * FROM "notes"'],
  "sqlOver.filter.column": [
    "notes",
    [{ column: HOLE, operator: "=", value: 1 }],
    'SELECT * FROM "notes"',
  ],
  "sqlOver.filter.operator": [
    "notes",
    [{ column: "owner", operator: HOLE, value: 1 }],
    'SELECT * FROM "notes"',
  ],
  "sqlOver.reads": [
    "notes",
    { where: [], reads: [HOLE] },
    'SELECT * FROM "notes"',
  ],
  "sqlOver.param": ["notes", [], 'SELECT * FROM "notes" WHERE owner = ?', HOLE],
};

function fill(value: unknown, payload: unknown): unknown {
  if (value === HOLE) return payload;
  if (Array.isArray(value)) return value.map((v) => fill(v, payload));
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fill(v, payload)]),
    );
  }
  return value;
}

// --- the engine under test ---------------------------------------------

const READS = new Set([
  "where", "whereAny", "select", "order", "limit", "offset", "all", "first",
  "distinct", "count", "countDistinct", "sum", "avg", "min", "max", "groupBy",
  "having",
]);
const WRITES = new Set([...READS, "insert", "update", "upsert", "delete"]);

async function apply(start: any, ops: Op[], allowed: Set<string>, ids: string[]) {
  let x = start;
  for (const [method, ...args] of ops) {
    // A key fuzzed as a row's column name.
    if (method === "insertKey") {
      x = await x.insert({ owner: "k", [String(args[0])]: 1 });
      continue;
    }
    if (method === "updateKey") {
      x = await x.update(ids[0], { [String(args[0])]: 1 });
      continue;
    }
    if (method === "upsertKey") {
      x = await x.upsert({ [String(args[0])]: 1 }, { note: "u" });
      continue;
    }
    if (!allowed.has(method)) throw new Error(`fuzz: no method ${method}`);
    const real = args.map((a) => (a === "@id" ? ids[0] : a));
    x = x[method](...real);
  }
  return await x;
}

async function createEngine(): Promise<Vex> {
  const columns = {
    owner: { type: "string" as const, optional: true },
    note: { type: "string" as const, optional: true },
    n: { type: "number" as const, optional: true },
    data: { type: "json" as const, optional: true },
  };
  return Vex.create({
    storage: sqliteAdapter(":memory:"),
    plugins: [
      (api) => {
        api.setName("f");
        api.registerTable("notes", { columns });
        api.registerTable("gnotes", {
          columns,
          access: {
            prepare: (user) => (user?.isAdmin ? UNRESTRICTED : user?.id),
            row: (owner, row) => row.owner === owner,
            narrow: (owner) => ({
              where: [[{ column: "owner", operator: "=", value: owner }]],
              reads: ["owner"],
            }),
          },
        });
        api.registerTable("canary", {
          columns: { secret: { type: "string" } },
        });
        api.registerMutation("seed", {
          args: {},
          async handler(ctx) {
            for (const table of ["notes", "gnotes"]) {
              await ctx.db.table(table).insert({ owner: "alice", note: "a1", n: 1 });
              await ctx.db.table(table).insert({ owner: "bob", note: "b1", n: 2 });
            }
            await ctx.db.table("canary").insert({ secret: SECRET });
          },
        });
        api.registerQuery("read", {
          args: { table: "json", ops: "json" },
          reactive: false,
          handler: (ctx, args) =>
            apply(ctx.db.table(args.table), args.ops, READS, []),
        });
        api.registerQuery("over", {
          args: { hold: "json" },
          reactive: false,
          handler: (ctx, args) => {
            const [table, filters, sql, ...params] = args.hold;
            return ctx.db.sqlOver({ [table]: filters }, sql, ...params);
          },
        });
        api.registerMutation("write", {
          args: { table: "json", ops: "json" },
          async handler(ctx, args) {
            const ids = [
              (await ctx.db.table(args.table).where("owner", "=", "alice").first<any>())
                ?._id,
            ];
            return apply(ctx.db.table(args.table), args.ops, WRITES, ids);
          },
        });
      },
    ],
  });
}

// --- oracles -----------------------------------------------------------

interface Finding {
  oracle: "structure" | "integrity" | "leak" | "syntax";
  position: string;
  surface: string;
  payload: string;
  detail: string;
}

const findings: Finding[] = [];
const errorKinds = new Map<string, number>();
let cases = 0;

function show(value: unknown): string {
  try {
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "symbol") return String(value);
    if (typeof value === "function") return `[function]`;
    const s = JSON.stringify(value) ?? String(value);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

async function schemaOf(vex: Vex): Promise<string> {
  const rows = await vex.unsafeSql<any>(
    "SELECT type, name, sql FROM sqlite_master ORDER BY name",
  );
  const canary = await vex.unsafeSql<any>("SELECT secret FROM canary");
  return JSON.stringify([rows, canary]);
}

async function judge(
  vex: Vex,
  position: string,
  surface: string,
  payload: unknown,
  run: () => Promise<unknown>,
  readsCanaryByName = false,
) {
  cases++;
  const before = await schemaOf(vex);
  captured = [];
  let result: unknown;
  try {
    result = await run();
  } catch (err: any) {
    const name = err?.name ?? typeof err;
    const message = String(err?.message ?? err);
    const kind = `${name}: ${message.replace(/"[^"]*"|'[^']*'|\d+/g, "…").slice(0, 70)}`;
    errorKinds.set(kind, (errorKinds.get(kind) ?? 0) + 1);
    if (/syntax error|unrecognized token|incomplete input/i.test(message)) {
      findings.push({
        oracle: "syntax",
        position,
        surface,
        payload: show(payload),
        detail: `${message} :: ${captured.at(-1)?.slice(0, 200)}`,
      });
    }
  }
  const statements = captured;
  captured = [];
  for (const sql of statements) {
    if (!sql.includes(MARK)) continue;
    const { code, inLiteral } = codeOf(sql);
    if (code.includes(MARK) || inLiteral) {
      findings.push({
        oracle: "structure",
        position,
        surface,
        payload: show(payload),
        detail: sql.slice(0, 240),
      });
    }
  }
  if (!readsCanaryByName) {
    let text = "";
    try {
      text = JSON.stringify(result) ?? "";
    } catch {}
    if (text.includes(SECRET) || /CREATE (TABLE|INDEX)|idx_/.test(text)) {
      findings.push({
        oracle: "leak",
        position,
        surface,
        payload: show(payload),
        detail: text.slice(0, 200),
      });
    }
  }
  const after = await schemaOf(vex);
  if (after !== before) {
    findings.push({
      oracle: "integrity",
      position,
      surface,
      payload: show(payload),
      detail: "schema or canary changed",
    });
    return true;
  }
  return false;
}

// --- runs --------------------------------------------------------------

const member: VexUser = { id: "alice", name: "A", isAdmin: false };
const admin: VexUser = { id: "root", name: "R", isAdmin: true };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const randomCases = Number(process.argv[2] ?? 3000);
  const seed = Number(process.argv[3] ?? 2955);
  let vex = await createEngine();
  await vex.mutate("f.seed", {});
  const reset = async () => {
    await vex.close();
    vex = await createEngine();
    await vex.mutate("f.seed", {});
  };

  const tables = ["notes", "gnotes"];
  const users: Array<[string, VexUser | null]> = [
    ["none", null],
    ["member", member],
    ["admin", admin],
  ];

  // 1. Every read position x every JSON payload x table x caller.
  for (const [position, template] of Object.entries(readPositions)) {
    for (const payload of jsonPayloads) {
      for (const table of tables) {
        for (const [who, user] of users) {
          if (table === "notes" && who !== "none") continue;
          const ops = fill(template, payload) as Op[];
          const changed = await judge(vex, position, `query ${table} ${who}`, payload, () =>
            vex.query("f.read", { table, ops }, user ? { user } : undefined),
          );
          if (changed) await reset();
        }
      }
    }
  }

  // 2. The table name itself.
  for (const payload of jsonPayloads) {
    const changed = await judge(
      vex,
      "table.name",
      "query",
      payload,
      () => vex.query("f.read", { table: payload, ops: [["all"]] }),
      payload === "canary" || payload === "main.canary",
    );
    if (changed) await reset();
  }

  // 3. Every write position x payload, in a mutation.
  for (const [position, template] of Object.entries(writePositions)) {
    for (const payload of jsonPayloads) {
      for (const table of tables) {
        const ops = fill(template, payload) as Op[];
        const changed = await judge(vex, position, `mutation ${table}`, payload, () =>
          vex.mutate("f.write", { table, ops }),
        );
        if (changed) await reset();
      }
    }
  }

  // 4. sqlOver holds.
  for (const [position, template] of Object.entries(overPositions)) {
    for (const payload of jsonPayloads) {
      const hold = fill(template, payload);
      const changed = await judge(vex, position, "sqlOver", payload, () =>
        vex.query("f.over", { hold }),
      );
      if (changed) await reset();
    }
  }

  // 5. Adapter level, values JSON cannot carry.
  const adapter = sqliteAdapter(":memory:");
  await adapter.ensureTable("notes", {
    columns: {
      owner: { type: "string", optional: true },
      note: { type: "string", optional: true },
    },
  });
  await adapter.ensureTable("canary", { columns: { secret: { type: "string" } } });
  await adapter.insert("notes", { owner: "alice", note: "a1" });
  await adapter.insert("canary", { secret: SECRET });
  const adapterSchema = async () =>
    JSON.stringify([
      await adapter.rawQuery("SELECT name, sql FROM sqlite_master ORDER BY name"),
      await adapter.rawQuery("SELECT secret FROM canary"),
    ]);
  for (const [position, template] of Object.entries(readPositions)) {
    for (const payload of [...jsPayloads, ...breakouts.slice(0, 6)]) {
      cases++;
      const before = await adapterSchema();
      captured = [];
      let result: unknown;
      try {
        let x: any = adapter.query("notes");
        for (const [method, ...args] of template) {
          x = x[method](...args.map((a) => fill(a, payload)));
        }
        result = await x;
      } catch (err: any) {
        const kind = `${err?.name}: ${String(err?.message).replace(/"[^"]*"|'[^']*'|\d+/g, "…").slice(0, 70)}`;
        errorKinds.set(`[adapter] ${kind}`, (errorKinds.get(`[adapter] ${kind}`) ?? 0) + 1);
        if (/syntax error|unrecognized token|incomplete input/i.test(String(err?.message))) {
          findings.push({ oracle: "syntax", position, surface: "adapter", payload: show(payload), detail: `${err.message} :: ${captured.at(-1)?.slice(0, 200)}` });
        }
      }
      for (const sql of captured) {
        if (!sql.includes(MARK)) continue;
        const { code, inLiteral } = codeOf(sql);
        if (code.includes(MARK) || inLiteral) {
          findings.push({ oracle: "structure", position, surface: "adapter", payload: show(payload), detail: sql.slice(0, 240) });
        }
      }
      let text = "";
      try { text = JSON.stringify(result, (_, v) => (typeof v === "bigint" ? String(v) : v)) ?? ""; } catch {}
      if (text.includes(SECRET)) {
        findings.push({ oracle: "leak", position, surface: "adapter", payload: show(payload), detail: text.slice(0, 200) });
      }
      if ((await adapterSchema()) !== before) {
        findings.push({ oracle: "integrity", position, surface: "adapter", payload: show(payload), detail: "schema or canary changed" });
      }
    }
  }
  await adapter.close();

  // 6. Random chains: several holes at once, random payloads.
  const random = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];
  const allTemplates = Object.entries(readPositions);
  for (let i = 0; i < randomCases; i++) {
    const [p1, t1] = pick(allTemplates);
    const [p2, t2] = pick(allTemplates);
    const ops = [
      ...(fill(t1.slice(0, -1), pick(jsonPayloads)) as Op[]),
      ...(fill(t2, pick(jsonPayloads)) as Op[]),
    ];
    const table = pick(tables);
    const [who, user] = pick(users);
    const changed = await judge(vex, `${p1}+${p2}`, `random ${table} ${who}`, ops, () =>
      vex.query("f.read", { table, ops }, user ? { user } : undefined),
    );
    if (changed) await reset();
  }
  await vex.close();

  // --- report ---
  console.log(`cases: ${cases}`);
  console.log(`findings: ${findings.length}`);
  const byKey = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.oracle} @ ${f.position}`;
    byKey.set(key, [...(byKey.get(key) ?? []), f]);
  }
  for (const [key, list] of byKey) {
    console.log(`\n## ${key} (${list.length})`);
    for (const f of list.slice(0, 3)) {
      console.log(`  [${f.surface}] payload=${f.payload}\n    ${f.detail}`);
    }
  }
  console.log("\n## error kinds");
  for (const [kind, n] of [...errorKinds].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${kind}`);
  }
  process.exit(findings.length > 0 ? 1 : 0);
}

await main();
