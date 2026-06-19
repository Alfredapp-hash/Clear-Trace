import { describe, expect, it, vi, beforeEach } from "vitest";
import { isOptionalEmailSendEnabled } from "./email-send";

vi.mock("./service", () => ({
  getAgentDefaults: vi.fn(),
  resolveEmailConnector: vi.fn(),
  getOrgConnector: vi.fn(),
}));

vi.mock("./connection/http", () => ({
  connectorFetch: vi.fn(),
}));

import { getAgentDefaults, resolveEmailConnector } from "./service";

describe("optional email send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is disabled when emailAutoSend is false", async () => {
    vi.mocked(getAgentDefaults).mockResolvedValue({ emailAutoSend: false });
    vi.mocked(resolveEmailConnector).mockResolvedValue("resend");
    expect(await isOptionalEmailSendEnabled("org-1")).toBe(false);
  });

  it("is enabled for resend when opted in", async () => {
    vi.mocked(getAgentDefaults).mockResolvedValue({ emailAutoSend: true });
    vi.mocked(resolveEmailConnector).mockResolvedValue("resend");
    expect(await isOptionalEmailSendEnabled("org-1")).toBe(true);
  });

  it("is enabled for smtp when opted in", async () => {
    vi.mocked(getAgentDefaults).mockResolvedValue({ emailAutoSend: true });
    vi.mocked(resolveEmailConnector).mockResolvedValue("smtp");
    expect(await isOptionalEmailSendEnabled("org-1")).toBe(true);
  });

  it("is disabled for gmail even when opted in", async () => {
    vi.mocked(getAgentDefaults).mockResolvedValue({ emailAutoSend: true });
    vi.mocked(resolveEmailConnector).mockResolvedValue("gmail");
    expect(await isOptionalEmailSendEnabled("org-1")).toBe(false);
  });
});