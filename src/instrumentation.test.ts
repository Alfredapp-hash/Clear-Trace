import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestError, register } from "./instrumentation";
import { APP_VERSION, LATEST_SCHEMA_VERSION } from "@/lib/version";

function captureStreams() {
  const lines: string[] = [];
  const spies = [process.stdout, process.stderr].map((stream) =>
    vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

const ORIGINAL = { level: process.env.LOG_LEVEL, runtime: process.env.NEXT_RUNTIME };

describe("instrumentation", () => {
  beforeEach(() => {
    process.env.LOG_LEVEL = "info";
  });
  afterEach(() => {
    for (const [key, value] of [
      ["LOG_LEVEL", ORIGINAL.level],
      ["NEXT_RUNTIME", ORIGINAL.runtime],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("onRequestError emits one JSON line with route + digest and no PII, path, query or headers", async () => {
    const err = Object.assign(new Error("Failed for jane.doe@example.com (Jane Doe) 555-123-4567"), {
      digest: "2638404126",
    });
    const cap = captureStreams();
    try {
      await onRequestError(
        err,
        {
          path: "/cases/abc?name=Jane+Doe&email=jane.doe%40example.com",
          method: "GET",
          headers: { cookie: "cleartrace_session=secret-token", authorization: "Bearer sk_live_123" },
        },
        {
          routerKind: "App Router",
          routePath: "/cases/[id]",
          routeType: "render",
          renderSource: "server-rendering",
          revalidateReason: undefined,
        },
      );
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    const line = cap.lines[0];
    const rec = JSON.parse(line);
    expect(Object.keys(rec).sort()).toEqual(["digest", "event", "level", "routePath", "routeType", "ts"]);
    expect(rec).toMatchObject({
      level: "error",
      event: "request.error",
      routePath: "/cases/[id]",
      routeType: "render",
      digest: "2638404126",
    });
    for (const leak of ["jane", "Jane", "Doe", "example.com", "555", "?", "name=", "cookie", "secret-token", "sk_live", "abc"]) {
      expect(line).not.toContain(leak);
    }
  });

  it("onRequestError tolerates non-Error values without a digest", async () => {
    const cap = captureStreams();
    try {
      await onRequestError("plain string", { path: "/x?y=1", method: "POST", headers: {} }, {
        routerKind: "App Router",
        routePath: "/api/cases",
        routeType: "route",
        revalidateReason: undefined,
      });
    } finally {
      cap.restore();
    }
    const rec = JSON.parse(cap.lines[0]);
    expect(rec).toMatchObject({ routePath: "/api/cases", routeType: "route" });
    expect(rec.digest).toBeUndefined();
  });

  it("register (nodejs) migrates the database and logs version + schema version", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const cap = captureStreams();
    try {
      await register();
    } finally {
      cap.restore();
    }
    const start = cap.lines.map((l) => JSON.parse(l)).find((r) => r.event === "server.start");
    expect(start).toMatchObject({ version: APP_VERSION, schemaVersion: LATEST_SCHEMA_VERSION });
  });

  it("register is a no-op outside the nodejs runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const cap = captureStreams();
    try {
      await register();
    } finally {
      cap.restore();
    }
    expect(cap.lines).toEqual([]);
  });
});
