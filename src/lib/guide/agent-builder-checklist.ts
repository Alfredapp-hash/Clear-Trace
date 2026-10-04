export interface BuilderChecklistItem {
  id: string;
  phase: string;
  label: string;
  description: string;
  docPath?: string;
  externalUrl?: string;
}

export const BUILDER_CHECKLIST: BuilderChecklistItem[] = [
  {
    id: "fork-template",
    phase: "Start",
    label: "Fork or clone the reference app",
    description:
      "Use GitHub Template (Generate) or clone Alfredapp-hash/Clear-Trace. This is the full working implementation.",
    externalUrl: "https://github.com/Alfredapp-hash/Clear-Trace/generate",
  },
  {
    id: "download-kit",
    phase: "Start",
    label: "Download agent kit (.zip) for your IDE",
    description:
      "Settings → Agent builder kit → pick Cursor / Claude Code / Windsurf → Download zip. Includes skills, rules, and MCP stub.",
  },
  {
    id: "install-deps",
    phase: "Start",
    label: "Install and run locally",
    description: "npm install && cp .env.example .env.local && npm run dev — demo discovery works without API keys.",
    docPath: ".env.example",
  },
  {
    id: "cursor-rules",
    phase: "Agent IDE",
    label: "Install Cursor rules + AGENTS.md",
    description:
      "From the kit zip: copy .cursor/rules/cleartrace.mdc and AGENTS.md to your project root.",
    docPath: ".cursor/rules/cleartrace.mdc",
  },
  {
    id: "skills-folder",
    phase: "Agent IDE",
    label: "Copy the 20-skill Markdown pack",
    description:
      "Copy skills/ from the zip into your repo. Each SKILL.md has YAML front matter and workflow steps.",
    docPath: "skills/",
  },
  {
    id: "bootstrap-prompt",
    phase: "Agent IDE",
    label: "Paste bootstrap task into your coding agent",
    description:
      "Open BOOTSTRAP.md from the kit and send it as the first agent message to scaffold Phase 0.",
    docPath: "BOOTSTRAP.md",
  },
  {
    id: "mcp-server",
    phase: "Integrations",
    label: "Configure ClearTrace MCP server (optional)",
    description:
      "Connect Cursor to your deployment via agent-builder/mcp-server. Create ct_live API key in Settings → Enterprise.",
    docPath: "agent-builder/mcp-server/README.md",
  },
  {
    id: "connectors",
    phase: "Integrations",
    label: "Add BYOK connectors",
    description: "SerpAPI or Google CSE for live SERP, local Ollama for private draft polish (Local-only AI), HIBP for breach intel, Gmail/SMTP for outbound.",
  },
  {
    id: "first-case",
    phase: "Validate",
    label: "Create a test case end-to-end",
    description:
      "Register → New case → add email claim → run demo discovery → Guide panel handoff → Run next Hermes step.",
  },
  {
    id: "tests-green",
    phase: "Validate",
    label: "Run npm test && npm run build",
    description: "The test suite covers API, Hermes, SSRF, SLA, broker sweep. Build must pass before shipping.",
  },
  {
    id: "deploy",
    phase: "Ship",
    label: "Deploy (Docker / self-host)",
    description: "docker compose up for app + worker-cron (set SESSION_SECRET, ENCRYPTION_KEY, WORKER_SECRET). Omit Stripe env for full Pro on self-host.",
    docPath: "docker-compose.yml",
  },
  {
    id: "enable-template",
    phase: "Ship",
    label: "Enable GitHub Template on your fork (optional)",
    description:
      "Repo Settings → check Template repository — lets others one-click Generate your version.",
    externalUrl: "https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository",
  },
];

export const CHECKLIST_STORAGE_KEY = "cleartrace-builder-checklist-v1";