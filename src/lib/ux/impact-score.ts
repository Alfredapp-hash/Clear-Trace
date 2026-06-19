import { matchBrokerByHost } from "@/lib/brokers/universe";

export interface ImpactAssessment {
  score: number;
  label: "low" | "medium" | "high" | "critical";
  factors: string[];
}

export function assessExposureImpact(params: {
  url: string;
  riskLevel?: string | null;
  informationSummary?: string | null;
  sensitivity?: string | null;
  sourceType?: string | null;
}): ImpactAssessment {
  const factors: string[] = [];
  let score = 0.3;

  try {
    const broker = matchBrokerByHost(new URL(params.url).hostname);
    if (broker) {
      factors.push(`${broker.name} (${broker.estimatedReach} reach broker)`);
      score += broker.estimatedReach === "high" ? 0.35 : broker.estimatedReach === "medium" ? 0.2 : 0.1;
    }
  } catch {
    factors.push("Unknown source host");
  }

  const summary = (params.informationSummary ?? "").toLowerCase();
  if (/phone|address|email/.test(summary)) {
    factors.push("Contact information exposed");
    score += 0.2;
  }
  if (params.riskLevel === "urgent" || params.riskLevel === "high") {
    factors.push(`${params.riskLevel} risk classification`);
    score += 0.15;
  }
  if (params.sensitivity === "high") {
    factors.push("High sensitivity");
    score += 0.1;
  }
  if (params.sourceType === "data_broker" || params.sourceType === "people_search") {
    factors.push("People-search / data-broker surface");
    score += 0.1;
  }

  score = Math.min(1, score);
  const label =
    score >= 0.85 ? "critical" : score >= 0.65 ? "high" : score >= 0.45 ? "medium" : "low";

  return { score, label, factors };
}