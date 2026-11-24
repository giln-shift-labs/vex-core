import { describe, expect, test } from "bun:test";
import {
  type Advisory,
  type AuditReport,
  isBlocking,
  newFindings,
} from "./check-new-advisories";

const advisory = (id: number, severity: string): Advisory => ({
  id,
  severity,
  title: `advisory ${id}`,
  url: `https://github.com/advisories/GHSA-${id}`,
});

describe("newFindings", () => {
  test("an advisory the base already had is not the change's", () => {
    const report: AuditReport = { axios: [advisory(1, "high")] };
    expect(newFindings(report, report)).toEqual([]);
  });

  test("an advisory only the head has is reported with its package", () => {
    const base: AuditReport = { axios: [advisory(1, "high")] };
    const head: AuditReport = {
      axios: [advisory(1, "high"), advisory(2, "critical")],
      qs: [advisory(3, "low")],
    };
    expect(
      newFindings(base, head).map((f) => [f.package, f.id, f.severity]),
    ).toEqual([
      ["axios", 2, "critical"],
      ["qs", 3, "low"],
    ]);
  });

  test("the same advisory id on a different package is new", () => {
    const base: AuditReport = { "react-router": [advisory(7, "high")] };
    const head: AuditReport = { "react-router-dom": [advisory(7, "high")] };
    expect(newFindings(base, head).map((f) => f.package)).toEqual([
      "react-router-dom",
    ]);
  });

  test("an advisory the change removes adds nothing", () => {
    const base: AuditReport = { axios: [advisory(1, "critical")] };
    expect(newFindings(base, {})).toEqual([]);
  });
});

describe("isBlocking", () => {
  test.each([
    ["critical", true],
    ["high", true],
    ["moderate", false],
    ["low", false],
  ])("%s blocks: %p", (severity, blocks) => {
    expect(isBlocking({ ...advisory(1, severity), package: "x" })).toBe(blocks);
  });
});

/** The script run as CI runs it, from the repo root. */
function run(env: Record<string, string>) {
  const proc = Bun.spawnSync(["bun", "scripts/check-new-advisories.ts"], {
    env: { ...process.env, ...env },
  });
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

describe("check-new-advisories fails closed", () => {
  test("with no base commit to compare against", () => {
    const { exitCode, stderr } = run({ AUDIT_BASE_SHA: "" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("AUDIT_BASE_SHA is not set");
  });

  test("with the all-zero sha a new branch's push carries", () => {
    const { exitCode, stderr } = run({ AUDIT_BASE_SHA: "0".repeat(40) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("AUDIT_BASE_SHA is not set");
  });

  test("when the base commit has no bun.lock", () => {
    const { exitCode, stderr } = run({ AUDIT_BASE_SHA: "1".repeat(40) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No bun.lock at base");
  });
});
