#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.CLEARTRACE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const API_KEY = (process.env.CLEARTRACE_API_KEY ?? "").trim();

if (!API_KEY) {
  console.error("[cleartrace-mcp] CLEARTRACE_API_KEY is not set — authenticated tools will return 401.");
} else if (!API_KEY.startsWith("ct_live_")) {
  console.error("[cleartrace-mcp] CLEARTRACE_API_KEY should be a ClearTrace API key (ct_live_…).");
}

/** Every request carries `Authorization: Bearer ct_live_…`; callers cannot override it. */
function headers(extra = {}) {
  const h = { Accept: "application/json", "Content-Type": "application/json", ...extra };
  delete h.Authorization;
  delete h.authorization;
  if (API_KEY) h.Authorization = `Bearer ${API_KEY}`;
  return h;
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: headers(init.headers ?? {}),
    // Never forward the API key to a redirect target.
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Unexpected redirect (HTTP ${res.status}) — check CLEARTRACE_URL`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(data?.error ?? data?.message ?? `HTTP ${res.status}`);
  }
  return data;
}

function textResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

const server = new McpServer({
  name: "cleartrace",
  version: "0.1.0",
});

server.tool(
  "cleartrace_health",
  "Check ClearTrace deployment health",
  {},
  async () => textResult(await api("/api/health")),
);

server.tool(
  "cleartrace_list_cases",
  "List privacy cases for the authenticated organization",
  {},
  async () => textResult(await api("/api/cases")),
);

server.tool(
  "cleartrace_get_case",
  "Get a single case by ID",
  { caseId: z.string().describe("Case UUID") },
  async ({ caseId }) => textResult(await api(`/api/cases/${caseId}`)),
);

server.tool(
  "cleartrace_get_guide",
  "Get workflow guide and agent handoff packs for a case step",
  {
    caseId: z.string(),
    step: z.string().optional().describe("Skill id, e.g. discover-public-exposure"),
  },
  async ({ caseId, step }) => {
    const qs = step ? `?step=${encodeURIComponent(step)}` : "";
    return textResult(await api(`/api/cases/${caseId}/guide${qs}`));
  },
);

server.tool(
  "cleartrace_run_discovery",
  "Run public exposure discovery on a case",
  { caseId: z.string() },
  async ({ caseId }) =>
    textResult(await api(`/api/cases/${caseId}/discovery`, { method: "POST", body: "{}" })),
);

server.tool(
  "cleartrace_broker_sweep",
  "Sweep broker universe for case scope matches",
  { caseId: z.string() },
  async ({ caseId }) =>
    textResult(await api(`/api/cases/${caseId}/broker-sweep`, { method: "POST", body: "{}" })),
);

server.tool(
  "cleartrace_breach_scan",
  "Run HIBP breach intel scan (requires email claim)",
  { caseId: z.string() },
  async ({ caseId }) =>
    textResult(await api(`/api/cases/${caseId}/breach-scan`, { method: "POST", body: "{}" })),
);

server.tool(
  "cleartrace_run_next_step",
  "Run the next Hermes workflow step in-app",
  { caseId: z.string() },
  async ({ caseId }) =>
    textResult(await api(`/api/cases/${caseId}/run-next-step`, { method: "POST", body: "{}" })),
);

server.tool(
  "cleartrace_get_sla",
  "Get SLA deadlines for a case",
  { caseId: z.string() },
  async ({ caseId }) => textResult(await api(`/api/cases/${caseId}/sla`)),
);

const transport = new StdioServerTransport();
await server.connect(transport);