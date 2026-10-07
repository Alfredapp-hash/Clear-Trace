import { SEARCH_PLACEHOLDERS, type SearchPlaceholder } from "./catalog-schema";

export type SearchUrlParams = Partial<Record<SearchPlaceholder, string | null | undefined>>;

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
const KNOWN = new Set<string>(SEARCH_PLACEHOLDERS);

/** Placeholder names used by a template (in order, may repeat). */
export function templatePlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? "");
}

/** True when every placeholder in the template is one of SEARCH_PLACEHOLDERS. */
export function isValidSearchTemplate(template: string): boolean {
  if (!template.startsWith("https://")) return false;
  // Stray braces (e.g. "{first" or "{{x}}") are not valid placeholders.
  const stripped = template.replace(PLACEHOLDER_RE, "");
  if (/[{}]/.test(stripped)) return false;
  return templatePlaceholders(template).every((p) => KNOWN.has(p));
}

/** `full` defaults to "first last" and `cityState` to "city, state" when not given. */
function withDerivedParams(params: SearchUrlParams): SearchUrlParams {
  const first = params.first?.trim();
  const last = params.last?.trim();
  const city = params.city?.trim();
  const state = params.state?.trim();
  return {
    ...params,
    full: params.full?.trim() || (first && last ? `${first} ${last}` : undefined),
    cityState: params.cityState?.trim() || (city && state ? `${city}, ${state}` : undefined),
  };
}

/**
 * Fill a broker's detection.searchUrlTemplate.
 *
 * Every placeholder value is encodeURIComponent'd. Returns null when the broker has no
 * template, the template uses an unknown placeholder, or a placeholder it uses has no value
 * (a half-filled search URL would show the wrong people).
 */
export function buildSearchUrl(
  broker: { detection: { searchUrlTemplate: string | null } },
  params: SearchUrlParams,
): string | null {
  const template = broker.detection.searchUrlTemplate;
  if (!template || !isValidSearchTemplate(template)) return null;

  const values = withDerivedParams(params);
  let missing = false;
  const url = template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const value = values[name as SearchPlaceholder]?.trim();
    if (!value) {
      missing = true;
      return "";
    }
    return encodeURIComponent(value);
  });
  return missing ? null : url;
}

/** Placeholders that describe a place (city / state). */
export const PLACE_PLACEHOLDERS: ReadonlySet<SearchPlaceholder> = new Set(["city", "state", "cityState"]);

/**
 * Placeholders a broker's template uses that `params` cannot fill (each listed once, in
 * template order). Empty when the template fills, or when there is no valid template.
 */
export function missingSearchParams(
  broker: { detection: { searchUrlTemplate: string | null } },
  params: SearchUrlParams,
): SearchPlaceholder[] {
  const template = broker.detection.searchUrlTemplate;
  if (!template || !isValidSearchTemplate(template)) return [];
  const values = withDerivedParams(params);
  const missing: SearchPlaceholder[] = [];
  for (const name of templatePlaceholders(template) as SearchPlaceholder[]) {
    if (!values[name]?.trim() && !missing.includes(name)) missing.push(name);
  }
  return missing;
}
