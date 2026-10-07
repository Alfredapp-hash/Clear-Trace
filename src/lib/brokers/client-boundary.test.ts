import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// The broker catalog (500+ entries) and zod must stay server-side: in a client bundle they
// bloat every page and zod's eval probe trips the production CSP (script-src without
// 'unsafe-eval'). Type-only imports are fine; they are erased at build time.
const FORBIDDEN = [/from\s+"zod"/, /from\s+"@\/lib\/brokers\/(universe|catalog-schema|playbooks|checklist)"/];

function clientFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return clientFiles(p);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
    const src = fs.readFileSync(p, "utf8");
    return /^\s*["']use client["']/.test(src) ? [p] : [];
  });
}

describe("client bundle boundary", () => {
  it("no client component value-imports the broker catalog or zod", () => {
    const offenders = clientFiles(path.join(process.cwd(), "src")).flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /^\s*import\s+(?!type\b)/.test(line) && FORBIDDEN.some((re) => re.test(line)))
        .map((line) => `${path.relative(process.cwd(), file)}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
