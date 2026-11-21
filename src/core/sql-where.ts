/**
 * The SQL of the query builder's conditions, one builder for every
 * statement that carries them: the adapters' reads and writes, and a
 * raw read held to rows (`held-read.ts`), which must agree on what a
 * filter means to the letter.
 */

import {
  filter,
  filterGroups,
  filterOperator,
  identifier,
} from "./args-error.js";
import { serializeValue } from "./sql-value.js";
import type { Condition, Filter } from "./types.js";

/** A name as a quoted SQL identifier; see {@link identifier}. */
export function quoteIdent(name: string): string {
  return `"${identifier(name).replaceAll('"', '""')}"`;
}

/**
 * One condition's SQL, its parameters appended to `params`: a filter,
 * or an OR of AND groups (no group matches nothing, an empty group
 * every row).
 */
function conditionSql(condition: Condition, params: any[]): string {
  // filterSql refuses whatever is neither shape.
  if (
    condition === null ||
    typeof condition !== "object" ||
    !("any" in condition)
  ) {
    return filterSql(condition as Filter, params);
  }
  const any = filterGroups(condition.any);
  if (any.length === 0) return "0 = 1";
  const groups = any.map((group) =>
    group.length === 0
      ? "1 = 1"
      : `(${group.map((f) => filterSql(f, params)).join(" AND ")})`,
  );
  return `(${groups.join(" OR ")})`;
}

export function buildWhereClause(filters: readonly Condition[]): {
  sql: string;
  params: any[];
} {
  if (filters.length === 0) return { sql: "", params: [] };
  const params: any[] = [];
  const parts = filters.map((condition) => conditionSql(condition, params));
  return { sql: `WHERE ${parts.join(" AND ")}`, params };
}

/** One filter's SQL, its parameters appended to `params`. */
function filterSql(unchecked: Filter, params: any[]): string {
  const f = filter(unchecked);
  // Written into the SQL as text: refused unless it is one we know.
  const operator = filterOperator(f.operator);
  const column = quoteIdent(f.column);
  if (operator === "IN") {
    const values = (Array.isArray(f.value) ? f.value : [f.value]).map(
      serializeValue,
    );
    const nonNull = values.filter((item) => item !== null);
    const clauses: string[] = [];
    if (nonNull.length > 0) {
      clauses.push(`${column} IN (${nonNull.map(() => "?").join(", ")})`);
      params.push(...nonNull);
    }
    if (values.some((item) => item === null)) {
      clauses.push(`${column} IS NULL`);
    }
    return clauses.length > 0 ? `(${clauses.join(" OR ")})` : "0 = 1";
  }
  const value = serializeValue(f.value);
  if (value === null && operator === "=") return `${column} IS NULL`;
  if (value === null && operator === "!=") return `${column} IS NOT NULL`;
  params.push(value);
  return `${column} ${operator} ?`;
}
