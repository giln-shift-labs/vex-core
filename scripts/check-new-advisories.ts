#!/usr/bin/env bun
/**
 * Fails a change that adds a critical or high advisory to bun.lock, and
 * warns on one that adds a moderate or low advisory.
 *
 * Only what the change adds counts. Advisories the base already carries
 * are the repo's backlog; blocking every
 * PR on them would turn CI red for changes that never touched a
 * dependency, each time an advisory is published.
 *
 * `bun audit` reads the lockfile alone, so both sides are audited the
 * same way: the bytes of bun.lock written into an empty directory. The
 * base comes from `git show <sha>:bun.lock`, with no checkout or install.
 *
 * Fails closed: no base sha, no base lockfile, or an audit that answers
 * with no JSON report (registry down, bun error) is a failure, never a
 * pass.
 *
 *   AUDIT_BASE_SHA=<sha> bun run security:advisories
 */

import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Advisory = {
  id: number;
  url: string;
  title: string;
  severity: string;
};

/** `bun audit --json`: package name → its advisories. */
export type AuditReport = Record<string, Advisory[]>;

export type Finding = Advisory & { package: string };

const BLOCKING_SEVERITIES = new Set(["critical", "high"]);

export const isBlocking = (finding: Finding) =>
  BLOCKING_SEVERITIES.has(finding.severity);

/** Advisories in `head` that `base` did not have, keyed by package and advisory id. */
export function newFindings(base: AuditReport, head: AuditReport): Finding[] {
  const known = new Set(
    Object.entries(base).flatMap(([name, advisories]) =>
      advisories.map((advisory) => `${name}#${advisory.id}`),
    ),
  );
  return Object.entries(head).flatMap(([name, advisories]) =>
    advisories
      .filter((advisory) => !known.has(`${name}#${advisory.id}`))
      .map((advisory) => ({ ...advisory, package: name })),
  );
}

function audit(lockfile: string, label: string): AuditReport {
  const dir = mkdtempSync(join(tmpdir(), "bun-audit-"));
  try {
    writeFileSync(join(dir, "bun.lock"), lockfile);
    writeFileSync(join(dir, "package.json"), "{}");
    const run = Bun.spawnSync(["bun", "audit", "--json"], { cwd: dir });
    // bun audit exits 1 whenever it finds anything, so the exit code
    // cannot tell "found advisories" from "failed": the JSON report can.
    try {
      return JSON.parse(run.stdout.toString()) as AuditReport;
    } catch {
      throw new Error(
        `bun audit gave no report for the ${label} lockfile (exit ${run.exitCode}): ${run.stderr.toString().trim()}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseLockfile(sha: string): string {
  const show = Bun.spawnSync(["git", "show", `${sha}:bun.lock`]);
  if (show.exitCode !== 0) {
    throw new Error(
      `No bun.lock at base ${sha}: ${show.stderr.toString().trim()}`,
    );
  }
  return show.stdout.toString();
}

const formatFinding = (f: Finding) =>
  `${f.severity} ${f.package}: ${f.title} (${f.url})`;

function main() {
  const base = process.env.AUDIT_BASE_SHA?.trim();
  if (!base || /^0+$/.test(base)) {
    throw new Error(
      "AUDIT_BASE_SHA is not set to the commit to compare against",
    );
  }

  const findings = newFindings(
    audit(baseLockfile(base), "base"),
    audit(readFileSync("bun.lock", "utf8"), "head"),
  );
  const blocking = findings.filter(isBlocking);
  const warnings = findings.filter((f) => !isBlocking(f));

  for (const f of blocking)
    console.log(
      `::error title=New ${f.severity} advisory::${formatFinding(f)}`,
    );
  for (const f of warnings)
    console.log(
      `::warning title=New ${f.severity} advisory::${formatFinding(f)}`,
    );

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary && findings.length > 0) {
    appendFileSync(
      summary,
      [
        "### Advisories this change adds",
        "",
        "| Severity | Package | Advisory | Blocks |",
        "|---|---|---|---|",
        ...findings.map(
          (f) =>
            `| ${f.severity} | \`${f.package}\` | [${f.title}](${f.url}) | ${isBlocking(f) ? "yes" : "no"} |`,
        ),
        "",
      ].join("\n"),
    );
  }

  console.log(
    findings.length === 0
      ? `No advisories added over ${base.slice(0, 12)}.`
      : `${blocking.length} blocking (critical/high), ${warnings.length} warning (moderate/low) added over ${base.slice(0, 12)}.`,
  );
  if (blocking.length > 0) process.exit(1);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`\n❌ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
