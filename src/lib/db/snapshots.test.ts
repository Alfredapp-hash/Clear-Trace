import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DEFAULT_SNAPSHOT_RETENTION_DAYS,
  pruneLocalSnapshots,
  snapshotDirs,
  snapshotRetentionDays,
} from "./snapshots";

const DAY = 24 * 60 * 60 * 1000;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleartrace-snapshots-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function file(name: string, ageDays: number, now: Date) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, "x");
  const t = new Date(now.getTime() - ageDays * DAY);
  fs.utimesSync(f, t, t);
}

describe("local snapshot retention", () => {
  it("deletes only pre-migrate / pre-restore snapshots older than the retention window", () => {
    const now = new Date("2026-10-05T00:00:00.000Z");
    file("pre-migrate-v0-20260101T000000Z.db", 31, now);
    file("pre-migrate-v1-20260101T000000Z.db.enc", 31, now);
    file("pre-restore-2026-09-01T00-00-00.000Z.db", 31, now);
    file("pre-restore-2026-10-01T00-00-00.000Z.db.enc", 4, now);
    file("cleartrace-2026-01-01T00-00-00.000Z.db.enc", 300, now);
    expect(pruneLocalSnapshots(dir, { now, retentionDays: 30 })).toBe(3);
    expect(fs.readdirSync(dir).sort()).toEqual([
      "cleartrace-2026-01-01T00-00-00.000Z.db.enc",
      "pre-restore-2026-10-01T00-00-00.000Z.db.enc",
    ]);
  });

  it("a missing directory prunes nothing", () => {
    expect(pruneLocalSnapshots(path.join(dir, "nope"))).toBe(0);
  });

  it("reads BACKUP_SNAPSHOT_RETENTION_DAYS and BACKUP_DIR", () => {
    expect(snapshotRetentionDays({})).toBe(DEFAULT_SNAPSHOT_RETENTION_DAYS);
    expect(snapshotRetentionDays({ BACKUP_SNAPSHOT_RETENTION_DAYS: "7" })).toBe(7);
    expect(snapshotRetentionDays({ BACKUP_SNAPSHOT_RETENTION_DAYS: "0" })).toBe(DEFAULT_SNAPSHOT_RETENTION_DAYS);
    expect(snapshotDirs("/data/cleartrace.db", {})).toEqual(["/data/backups"]);
    expect(snapshotDirs("/data/cleartrace.db", { BACKUP_DIR: "/offsite" })).toEqual(["/data/backups", "/offsite"]);
  });
});
