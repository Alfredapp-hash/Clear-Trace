import { z } from "zod";
import routesJson from "./data/platform-report-routes.json";

/**
 * Official per-platform privacy / personal-information report routes (Sprint 7).
 *
 * Data lives in `data/platform-report-routes.json`. Every route is a form or help-page link
 * that was opened and checked on `verifiedOn`; `verifiedVia` says how and `sources` lists the
 * official pages that link to it. There is deliberately no email field: platform routes are
 * form links only. A platform whose page could not be verified is left out, so its URLs fall
 * back to `manual_research`.
 */

const domainSchema = z
  .string()
  .regex(/^(?!www\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "lowercase registrable domain without www.");

const httpsUrl = z.url({ protocol: /^https$/ });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const platformRouteSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
    name: z.string().min(1),
    /** Registrable domains (and official short-link domains) the platform serves content on. */
    domains: z.array(domainSchema).min(1),
    /** The official report / request form (or the help page that hosts it). */
    reportUrl: httpsUrl,
    reportLabel: z.string().min(1),
    /** What the route covers, in plain words (shown to the user in the controller notes). */
    scope: z.string().min(1),
    requiresAccount: z.union([z.boolean(), z.literal("unknown")]),
    policyUrl: httpsUrl,
    verifiedOn: isoDate,
    verifiedVia: z.string().min(1),
    sources: z.array(httpsUrl).min(1),
  })
  .strict();

export type PlatformRoute = z.infer<typeof platformRouteSchema>;

export const platformRoutesFileSchema = z
  .object({
    version: z.literal(1),
    routes: z.array(platformRouteSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seenIds = new Set<string>();
    const seenDomains = new Map<string, string>();
    for (const route of file.routes) {
      if (seenIds.has(route.id)) ctx.addIssue({ code: "custom", message: `duplicate route id ${route.id}` });
      seenIds.add(route.id);
      for (const d of route.domains) {
        const owner = seenDomains.get(d);
        if (owner) ctx.addIssue({ code: "custom", message: `domain ${d} claimed by ${owner} and ${route.id}` });
        seenDomains.set(d, route.id);
      }
    }
  });

export const PLATFORM_ROUTES: readonly PlatformRoute[] = platformRoutesFileSchema.parse(routesJson).routes;

const ROUTE_BY_DOMAIN = new Map<string, PlatformRoute>(
  PLATFORM_ROUTES.flatMap((r) => r.domains.map((d) => [d, r] as const)),
);

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Match a hostname to a platform by registrable domain: the host must equal a listed domain or
 * be a subdomain of it (m.facebook.com, vm.tiktok.com). Look-alikes such as
 * `notfacebook.com` or `facebook.com.example.net` do not match.
 */
export function matchPlatformByHost(hostname: string): PlatformRoute | undefined {
  const host = normalizeHost(hostname);
  if (!host) return undefined;
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const hit = ROUTE_BY_DOMAIN.get(labels.slice(i).join("."));
    if (hit) return hit;
  }
  return undefined;
}

export function matchPlatformByUrl(url: string): PlatformRoute | undefined {
  try {
    return matchPlatformByHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
}
