import { describe, expect, it, vi } from "vitest";
import { enableWalMode } from "./wal";

function busy() {
  return Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
}

describe("enableWalMode", () => {
  it("retries while another process holds the lock (parallel build workers on a fresh DB)", () => {
    const pragma = vi
      .fn()
      .mockImplementationOnce(() => {
        throw busy();
      })
      .mockImplementationOnce(() => {
        throw busy();
      })
      .mockReturnValue("wal");
    const sleep = vi.fn();
    enableWalMode({ pragma }, { sleep });
    expect(pragma).toHaveBeenCalledTimes(3);
    expect(pragma).toHaveBeenCalledWith("journal_mode = WAL");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget", () => {
    const pragma = vi.fn(() => {
      throw busy();
    });
    expect(() => enableWalMode({ pragma }, { sleep: () => {}, attempts: 4 })).toThrow(/locked/);
    expect(pragma).toHaveBeenCalledTimes(4);
  });

  it("does not retry other errors", () => {
    const pragma = vi.fn(() => {
      throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    });
    expect(() => enableWalMode({ pragma }, { sleep: () => {} })).toThrow(/disk/);
    expect(pragma).toHaveBeenCalledTimes(1);
  });
});
