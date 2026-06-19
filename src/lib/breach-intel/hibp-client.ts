import { connectorFetch } from "@/lib/connectors/connection/http";
import { ConnectorConnectionError } from "@/lib/connectors/connection/errors";

export interface HibpBreach {
  name: string;
  title: string;
  domain: string;
  breachDate: string;
  addedDate: string;
  modifiedDate: string;
  pwnCount: number;
  description: string;
  dataClasses: string[];
  isVerified: boolean;
  isSensitive: boolean;
  isRetired: boolean;
  isSpamList: boolean;
}

interface HibpApiBreach {
  Name: string;
  Title: string;
  Domain: string;
  BreachDate: string;
  AddedDate: string;
  ModifiedDate: string;
  PwnCount: number;
  Description: string;
  DataClasses: string[];
  IsVerified: boolean;
  IsSensitive: boolean;
  IsRetired: boolean;
  IsSpamList: boolean;
}

function mapBreach(raw: HibpApiBreach): HibpBreach {
  return {
    name: raw.Name,
    title: raw.Title,
    domain: raw.Domain,
    breachDate: raw.BreachDate,
    addedDate: raw.AddedDate,
    modifiedDate: raw.ModifiedDate,
    pwnCount: raw.PwnCount,
    description: raw.Description,
    dataClasses: raw.DataClasses ?? [],
    isVerified: raw.IsVerified,
    isSensitive: raw.IsSensitive,
    isRetired: raw.IsRetired,
    isSpamList: raw.IsSpamList,
  };
}

export async function queryHibpBreaches(
  apiKey: string,
  email: string,
): Promise<HibpBreach[]> {
  const account = encodeURIComponent(email.trim());
  try {
    const res = await connectorFetch<HibpApiBreach[]>({
      provider: "hibp",
      url: `https://haveibeenpwned.com/api/v3/breachedaccount/${account}?truncateResponse=false`,
      method: "GET",
      headers: {
        "hibp-api-key": apiKey,
        "User-Agent": "ClearTrace-BreachIntel/1.0",
      },
      timeoutMs: 15_000,
      retries: 1,
    });
    return (res.data ?? []).map(mapBreach);
  } catch (error) {
    if (error instanceof ConnectorConnectionError && error.statusCode === 404) {
      return [];
    }
    throw error;
  }
}

export const DEMO_HIBP_BREACHES: HibpBreach[] = [
  {
    name: "DemoExposure2024",
    title: "Demo Credential Exposure (synthetic)",
    domain: "demo.cleartrace.local",
    breachDate: "2024-06-01",
    addedDate: new Date().toISOString(),
    modifiedDate: new Date().toISOString(),
    pwnCount: 12500,
    description: "Synthetic breach record for demo mode when HIBP API key is not configured.",
    dataClasses: ["Email addresses", "Passwords"],
    isVerified: true,
    isSensitive: false,
    isRetired: false,
    isSpamList: false,
  },
];