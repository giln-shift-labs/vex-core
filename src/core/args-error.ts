import { HttpError } from "../http/error.js";

/**
 * A value the engine refuses as an argument: a query builder's filter
 * operator, sort direction, limit or offset outside what it accepts.
 * The builders write those into SQL as text, so a value they do not
 * know is refused rather than written. It answers a call as a 400.
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
