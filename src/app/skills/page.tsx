import { AppShell } from "@/components/AppShell";
import { Badge, Card, PageHeader, SectionTitle } from "@/components/ui";
import { getSession } from "@/lib/auth/session";
import {
  getSkillsByCategory,
  getWorkflowSkills,
  loadSkillRegistry,
  validateSkillRegistry,
} from "@/lib/skills/registry";
import { redirect } from "next/navigation";

function riskTone(level: string) {
  if (level === "low") return "success" as const;
  if (level === "medium") return "warning" as const;
  return "danger" as const;
}

const CATEGORY_LABELS: Record<string, string> = {
  workflow: "Workflow pipeline",
  operational: "Operational helpers",
  security: "Security",
  onboarding: "Onboarding",
};

function SkillCard({ skill }: { skill: ReturnType<typeof loadSkillRegistry>[number] }) {
  return (
    <Card key={skill.id} variant={skill.category === "workflow" ? "accent" : "default"}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {skill.workflowOrder != null && (
          <span className="font-mono text-[10px] text-slate-500">
            #{String(skill.workflowOrder).padStart(2, "0")}
          </span>
        )}
        <h2 className="text-lg font-medium text-slate-100">{skill.name}</h2>
        <Badge tone={riskTone(skill.riskLevel)}>{skill.riskLevel}</Badge>
      </div>
      <p className="text-sm leading-relaxed text-slate-400">{skill.summary}</p>
      <p className="mt-2 font-mono text-xs text-slate-600">
        {skill.id} · v{skill.version} · {skill.phase}
      </p>
      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {skill.automatable && <Badge tone="info">automatable</Badge>}
        {skill.implementedInApp && <Badge tone="success">in-app</Badge>}
        {skill.requiresAuthorization && <Badge tone="warning">auth required</Badge>}
        {skill.requiresHumanApproval && <Badge tone="warning">human approval</Badge>}
      </div>
      {skill.nextSkills.length > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          Next: {skill.nextSkills.map((s) => s.replaceAll("_", " ")).join(" → ")}
        </p>
      )}
      {skill.optionalConnectors.length > 0 && (
        <p className="mt-2 text-xs text-teal-400/70">
          Connectors: {skill.optionalConnectors.join(", ")}
        </p>
      )}
      <div className="mt-4">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Allowed tools
        </p>
        <div className="flex flex-wrap gap-1">
          {skill.allowedTools.slice(0, 6).map((tool) => (
            <span
              key={tool}
              className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-teal-300"
            >
              {tool}
            </span>
          ))}
          {skill.allowedTools.length > 6 && (
            <span className="text-[10px] text-slate-500">
              +{skill.allowedTools.length - 6}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

export default async function SkillsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const validation = validateSkillRegistry();
  const workflow = getWorkflowSkills();
  const operational = getSkillsByCategory("operational");
  const security = getSkillsByCategory("security");
  const onboarding = getSkillsByCategory("onboarding");
  const total = loadSkillRegistry().length;

  return (
    <AppShell userName={session.name} orgName={session.organizationName}>
      <PageHeader
        eyebrow="Hermes skill pack"
        title="Skill registry"
        description={`${total} portable Markdown skills — workflow graph, operational helpers, and security auditor. Markdown defines policy; typed tools execute bounded actions.`}
      />

      {!validation.valid && (
        <Card variant="danger" className="mb-6">
          <p className="text-sm text-rose-200">Registry validation errors:</p>
          <ul className="mt-2 list-disc pl-5 text-sm text-rose-300">
            {validation.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mb-8 flex flex-wrap gap-2">
        <Badge tone="info">{workflow.length} workflow</Badge>
        <Badge tone="info">{operational.length} operational</Badge>
        <Badge tone="info">{security.length} security</Badge>
        <Badge tone="info">{onboarding.length} onboarding</Badge>
      </div>

      <section className="mb-10">
        <SectionTitle subtitle="Primary case pipeline — Hermes routes by case status">
          {CATEGORY_LABELS.workflow}
        </SectionTitle>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {workflow.map((skill) => (
            <SkillCard key={skill.id} skill={skill} />
          ))}
        </div>
      </section>

      <section className="mb-10">
        <SectionTitle subtitle="Invoked from UI actions, batch jobs, or explicit user request">
          {CATEGORY_LABELS.operational}
        </SectionTitle>
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {operational.map((skill) => (
            <SkillCard key={skill.id} skill={skill} />
          ))}
        </div>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <SectionTitle>{CATEGORY_LABELS.security}</SectionTitle>
          <div className="mt-4 space-y-4">
            {security.map((skill) => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        </section>
        <section>
          <SectionTitle>{CATEGORY_LABELS.onboarding}</SectionTitle>
          <div className="mt-4 space-y-4">
            {onboarding.map((skill) => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}