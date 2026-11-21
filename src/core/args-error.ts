import { HttpError } from "../http/error.js";
import type { AggDef, Filter } from "./types.js";

/**
 * A value the engine refuses as an argument: a query builder's filter
 * operator, sort direction, limit, offset or aggregate outside what it
 * accepts. The builders write those into SQL as text, so a value they
 * do not know is refused rather than written. It answers a call as a
 * 400.
 */
export class ArgsError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = "ArgsError";
  }
}

/** A refused value, short enough to echo back in a message. */
function shownValue(value: unknown): string {
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
 * accept. The adapters run them where they write SQL; the access guard
 * runs them where it evaluates in JS instead, so a restricted caller
 * and an unrestricted one are refused alike.
 */

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
