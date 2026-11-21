import { HttpError } from "../http/error.js";
import type { AggDef, Filter } from "./types.js";

/**
 * A value the engine refuses as an argument to the query builder or a
 * table's writes: a name, operator, sort direction, limit, offset or
 * aggregate it does not know, or a filter, row or hold of the wrong
 * shape. The builders write names and keywords into SQL as text, so a
 * value they do not know is refused rather than written. It answers a
 * call as a 400.
 */
export class ArgsError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = "ArgsError";
  }
}

/** A refused value, short enough to echo back in a message. */
export function shownValue(value: unknown): string {
  let shown: string;
  try {
    shown = JSON.stringify(value) ?? String(value);
  } catch {
    shown = typeof value;
  }
  return shown.length > 40 ? `${shown.slice(0, 40)}…` : shown;
}

/*
 * The checks below are the one definition of what the builders
 * accept. The adapters run them where they write SQL, the engine where
 * it reads a value's shape before the adapters see it, and the access
 * guard where a restricted read evaluates in JS instead of SQL, so a
 * restricted caller and an unrestricted one are refused alike.
 */

/**
 * A table, column or alias name. It is quoted into the SQL, and the
 * quoting holds only for a string: anything else could answer the
 * quoting with any text. SQLite ends a statement at a NUL, so a name
 * holding one would cut the statement short; an empty name is no
 * name.
 */
export function identifier(name: unknown): string {
  if (typeof name === "string" && name !== "" && !name.includes("\0")) {
    return name;
  }
  throw new ArgsError(
    `A name must be a non-empty string without NUL; got ${shownValue(name)}`,
  );
}

/**
 * SQLite's own tables (`sqlite_*`) and the storage's bookkeeping
 * (`__vex_*`), which hold the schema, not an app's rows: no table is
 * registered under such a name, and none is read by one. Matched
 * without case, as SQLite matches table names.
 */
export function isInternalTable(name: string): boolean {
  return /^(sqlite_|__vex_)/i.test(name);
}

/** A table a caller may read by name (`ctx.db.table()`, `vex.readTable()`). */
export function readableTable(name: unknown): string {
  const table = identifier(name);
  if (isInternalTable(table)) {
    throw new ArgsError(`Table ${shownValue(table)} is internal`);
  }
  return table;
}

/** groupBy's columns, one or a list: at least one name. */
export function groupColumns(columns: unknown): string[] {
  const list = Array.isArray(columns) ? columns : [columns];
  if (list.length === 0) throw new ArgsError("groupBy needs a column");
  return list.map(identifier);
}

/**
 * A filter: an object naming a column and an operator the builders
 * know, and a value they bind as a parameter.
 */
export function checkedFilter(f: unknown): Filter {
  if (f === null || typeof f !== "object" || Array.isArray(f)) {
    throw new ArgsError(
      `A filter must be { column, operator, value }; got ${shownValue(f)}`,
    );
  }
  const { column, operator } = f as Filter;
  identifier(column);
  filterOperator(operator);
  return f as Filter;
}

/** whereAny's groups: an array of arrays of filters. */
export function filterGroups(groups: unknown): Filter[][] {
  if (Array.isArray(groups) && groups.every(Array.isArray)) {
    return groups as Filter[][];
  }
  throw new ArgsError(
    `whereAny takes an array of filter arrays; got ${shownValue(groups)}`,
  );
}

/**
 * Named entries: a write's columns and values, groupBy's aggregates.
 * Their keys become column names or aliases, so a string or an array
 * would name its characters' or elements' positions.
 */
export function plainObject(value: unknown, what: string): Record<string, any> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  throw new ArgsError(`${what} must be an object; got ${shownValue(value)}`);
}

const OPERATORS: ReadonlySet<unknown> = new Set<Filter["operator"]>([
  "=",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "IN",
]);

export function filterOperator(operator: unknown): Filter["operator"] {
  if (OPERATORS.has(operator)) return operator as Filter["operator"];
  throw new ArgsError(
    `A filter's operator must be one of ${[...OPERATORS].join(" ")}; got ${shownValue(operator)}`,
  );
}

const DIRECTIONS: Readonly<Record<string, "ASC" | "DESC">> = {
  asc: "ASC",
  desc: "DESC",
};

/** A sort direction as its SQL keyword. */
export function sortDirection(dir: unknown): "ASC" | "DESC" {
  if (typeof dir === "string" && Object.hasOwn(DIRECTIONS, dir)) {
    return DIRECTIONS[dir];
  }
  throw new ArgsError(
    `A sort direction must be "asc" or "desc"; got ${shownValue(dir)}`,
  );
}

export function rowCount(name: "limit" | "offset", n: unknown): number {
  if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
  throw new ArgsError(
    `${name} must be a non-negative safe integer; got ${shownValue(n)}`,
  );
}

const AGGREGATE_FUNCTIONS: ReadonlySet<unknown> = new Set([
  "sum",
  "avg",
  "min",
  "max",
  "countDistinct",
]);

/** A groupBy aggregate: `"count"` or `[sum|avg|min|max|countDistinct, column]`. */
export function aggregate(def: unknown): AggDef {
  if (def === "count") return def;
  if (
    Array.isArray(def) &&
    def.length === 2 &&
    AGGREGATE_FUNCTIONS.has(def[0]) &&
    typeof def[1] === "string"
  ) {
    return def as AggDef;
  }
  throw new ArgsError(
    `An aggregate must be "count" or [sum|avg|min|max|countDistinct, column]; got ${shownValue(def)}`,
  );
}
