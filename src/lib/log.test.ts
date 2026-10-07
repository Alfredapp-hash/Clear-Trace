import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_FIELD_ALLOWLIST, log, redact, sanitizeFields } from "./log";

function capture() {
  const lines: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return {
    lines,
    parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    restore: () => {
      out.mockRestore();
      err.mockRestore();
    },
  };
}

const ORIGINAL_LEVEL = process.env.LOG_LEVEL;

describe("log", () => {
  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
  });
  afterEach(() => {
    if (ORIGINAL_LEVEL === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = ORIGINAL_LEVEL;
  });

  it("writes one JSON line with ts, level, event and allowlisted fields only", () => {
    const cap = capture();
    try {
      log.info("db.migration", {
        migration: "v2_ongoing_protection",
        durationMs: 12,
        email: "jane@example.com",
        name: "Jane Doe",
        query: "?q=secret",
        nested: { a: 1 },
      });
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0].endsWith("\n")).toBe(true);
    const [rec] = cap.parsed();
    expect(Object.keys(rec).sort()).toEqual(["durationMs", "event", "level", "migration", "ts"]);
    expect(rec.level).toBe("info");
    expect(rec.event).toBe("db.migration");
    expect(typeof rec.ts).toBe("string");
    expect(cap.lines[0]).not.toMatch(/jane|Doe|secret/i);
  });

  it("redacts email, phone, v2 ciphertext and bearer tokens in allowlisted string values", () => {
    const cap = capture();
    try {
      log.error("job.failed", {
        errorCode: "contact jane.doe+x@example.co.uk or (555) 123-4567 / +1 555 987 6543",
        routePath: "token Bearer abc.def-123_xyz= and v2:AAAA:BBBB:CCCC==",
        job: "sweep",
      });
    } finally {
      cap.restore();
    }
    const line = cap.lines[0];
    expect(line).not.toContain("jane.doe");
    expect(line).not.toContain("123-4567");
    expect(line).not.toContain("987 6543");
    expect(line).not.toContain("abc.def");
    expect(line).not.toContain("AAAA");
    const [rec] = cap.parsed();
    expect(rec.errorCode).toContain("[email]");
    expect(rec.errorCode).toContain("[phone]");
    expect(rec.routePath).toContain("Bearer [redacted]");
    expect(rec.routePath).toContain("[ciphertext]");
    expect(rec.job).toBe("sweep");
  });

  it("redact() leaves ordinary text, versions, dates and ids alone", () => {
    expect(redact("migration v2 took 12ms")).toBe("migration v2 took 12ms");
    expect(redact("1.4.0")).toBe("1.4.0");
    expect(redact("/api/cases/[id]/broker-sweep")).toBe("/api/cases/[id]/broker-sweep");
    expect(redact("2026-10-05")).toBe("2026-10-05");
    expect(redact("c0ffee12-3456-7890-abcd-ef0123456789")).toBe("c0ffee12-3456-7890-abcd-ef0123456789");
    expect(redact("")).toBe("");
  });

  it("keeps numeric counts only and scrubs count keys", () => {
    expect(
      sanitizeFields({ counts: { reencrypted: 2, failed: 0, bad: "x" as unknown as number, "a@b.io": 1 } }),
    ).toEqual({ counts: { reencrypted: 2, failed: 0, "[email]": 1 } });
    expect(sanitizeFields({ counts: "nope" as unknown as Record<string, number> })).toEqual({});
  });

  it("keeps a digest verbatim when it is an opaque id, drops anything else", () => {
    expect(sanitizeFields({ digest: "2638404126" })).toEqual({ digest: "2638404126" });
    expect(sanitizeFields({ digest: "x@y.com digest" })).toEqual({});
  });

  it("respects LOG_LEVEL (including silent)", () => {
    process.env.LOG_LEVEL = "warn";
    const cap = capture();
    try {
      log.debug("a");
      log.info("b");
      log.warn("c");
      log.error("d");
      process.env.LOG_LEVEL = "silent";
      log.error("e");
    } finally {
      cap.restore();
    }
    expect(cap.parsed().map((r) => r.event)).toEqual(["c", "d"]);
  });

  it("allowlist is exactly the documented contract", () => {
    expect([...LOG_FIELD_ALLOWLIST].sort()).toEqual(
      [
        "routePath",
        "routeType",
        "method",
        "status",
        "durationMs",
        "counts",
        "errorCode",
        "job",
        "version",
        "schemaVersion",
        "migration",
        "digest",
      ].sort(),
    );
  });
});
