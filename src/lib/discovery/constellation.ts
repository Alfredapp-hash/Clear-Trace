export interface ClaimNode {
  claimType: string;
  value: string;
}

function groupClaims(claims: ClaimNode[]): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  for (const c of claims) {
    const v = c.value?.trim();
    if (!v) continue;
    const list = byType.get(c.claimType) ?? [];
    if (!list.includes(v)) list.push(v);
    byType.set(c.claimType, list);
  }
  return byType;
}

/**
 * Build expanded search queries from the identity claim graph.
 * Every claim is used (a case may have several names/emails/phones/cities — the
 * previous implementation kept only the last of each type), and a query is only
 * emitted when every value it interpolates exists (no `"undefined"` queries).
 */
export function buildConstellationQueries(claims: ClaimNode[]): string[] {
  const g = groupClaims(claims);
  const all = (...types: string[]) => types.flatMap((t) => g.get(t) ?? []);
  const names = all("full_name");
  const altNames = all("alias", "maiden_name");
  const cities = all("city_state", "city");
  const states = all("state");
  const emails = all("email");
  const phones = all("phone");
  const usernames = all("username");
  const employers = all("employer");
  const addresses = all("address");
  const zips = all("zip_code");
  const dobs = all("date_of_birth");
  const linkedinUrls = all("linkedin_url");
  const twitterHandles = all("twitter_handle");
  const githubUsernames = all("github_username");
  const redditUsernames = all("reddit_username");
  const queries: string[] = [];
  const primaryName = names[0];

  for (const name of names) {
    // --- Core identity queries ---
    for (const city of cities) {
      queries.push(`"${name}" ${city}`);
      queries.push(`"${name}" ${city} phone OR address`);
      queries.push(`"${name}" ${city} contact information`);
    }
    for (const state of states) queries.push(`"${name}" ${state} address`);
    queries.push(`"${name}" people search`);
    queries.push(`"${name}" whitepages OR spokeo OR beenverified OR intelius`);
    queries.push(`"${name}" truepeoplesearch OR fastpeoplesearch OR thatsthem`);
    queries.push(`"${name}" background check public records`);

    // --- Broker-specific queries ---
    if (cities.length) queries.push(`site:fastpeoplesearch.com "${name}"`);
    for (const city of cities) queries.push(`site:truepeoplesearch.com "${name}" ${city}`);
    queries.push(`site:radaris.com "${name}"`);
    queries.push(`site:spokeo.com "${name}"`);
    queries.push(`site:whitepages.com "${name}"`);
    queries.push(`site:peekyou.com "${name}"`);

    // --- Contact / professional ---
    for (const employer of employers) {
      queries.push(`"${name}" ${employer}`);
      queries.push(`"${name}" "${employer}" contact`);
      queries.push(`site:linkedin.com "${name}" "${employer}"`);
    }
    queries.push(`site:zoominfo.com "${name}"`);
    queries.push(`site:clearbit.com "${name}" OR site:apollo.io "${name}"`);

    for (const dob of dobs) queries.push(`"${name}" "${dob}" record`);
    for (const zip of zips) queries.push(`"${name}" "${zip}" public record`);

    // --- Public records / court / voter ---
    for (const city of cities) {
      queries.push(`"${name}" court records OR arrest records ${city}`);
      queries.push(`"${name}" property records ${city}`);
    }
    for (const state of states) queries.push(`"${name}" voter registration ${state}`);
    queries.push(`site:voterrecords.com "${name}"`);

    // --- Image / likeness ---
    queries.push(`"${name}" photo OR picture site:instagram.com OR site:flickr.com`);
  }

  for (const email of emails) {
    queries.push(`"${email}" site:hunter.io OR site:rocketreach.co OR site:apollo.io`);
    queries.push(`"${email}" public profile`);
    queries.push(`site:zoominfo.com "${email}" OR site:apollo.io "${email}"`);
  }
  for (const phone of phones) {
    queries.push(`"${phone}" listing`);
    queries.push(`"${phone}" reverse phone lookup`);
  }
  for (const address of addresses) queries.push(`"${address}" people search`);

  // --- Social / platform discovery ---
  for (const username of usernames) {
    queries.push(`"${username}" profile site:instagram.com OR site:twitter.com OR site:tiktok.com`);
    queries.push(`"${username}" site:reddit.com OR site:linkedin.com OR site:github.com`);
    queries.push(`"${username}" profile account`);
  }
  for (const h of twitterHandles) queries.push(`site:twitter.com "${h}"`);
  for (const url of linkedinUrls) {
    queries.push(primaryName ? `"${url}" OR site:linkedin.com "${primaryName}"` : `"${url}"`);
  }
  for (const u of githubUsernames) queries.push(`site:github.com "${u}"`);
  for (const u of redditUsernames) queries.push(`site:reddit.com/user "${u}"`);

  // --- Historical / identity variation (alias, maiden name) ---
  for (const alt of altNames) {
    for (const city of cities) queries.push(`"${alt}" ${city} people search`);
    queries.push(`"${alt}" whitepages OR spokeo`);
    queries.push(`"${alt}" people search`);
  }

  return [...new Set(queries)].filter((q) => !/\bundefined\b|\bnull\b/.test(q));
}
