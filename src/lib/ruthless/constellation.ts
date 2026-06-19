import type { ClaimNode } from "@/lib/discovery/constellation";
import { buildConstellationQueries } from "@/lib/discovery/constellation";

/** Extra high-coverage queries used only in Ruthless mode (approved public search). */
export function buildRuthlessExtraQueries(claims: ClaimNode[]): string[] {
  const byType = Object.fromEntries(claims.map((c) => [c.claimType, c.value]));
  const name = byType.full_name;
  const city = byType.city_state;
  const email = byType.email;
  const phone = byType.phone;
  const username = byType.username;
  const queries: string[] = [];

  if (name) {
    queries.push(`"${name}" doxx OR exposed OR leak OR profile`);
    queries.push(`"${name}" intitle:"people search" OR intitle:"background check"`);
    queries.push(
      `"${name}" site:beenverified.com OR site:truthfinder.com OR site:instantcheckmate.com`,
    );
    queries.push(`"${name}" site:mylife.com OR site:nuwber.com OR site:peoplefinders.com`);
    queries.push(`"${name}" site:cyberbackgroundchecks.com OR site:smartbackgroundchecks.com`);
    queries.push(`"${name}" mugshot OR arrest OR court record`);
    queries.push(`"${name}" voter record OR property owner`);
    queries.push(`"${name}" email OR phone OR address listing`);
  }

  if (name && city) {
    queries.push(`"${name}" "${city}" site:facebook.com OR site:linkedin.com`);
    queries.push(`"${name}" "${city}" directory OR listing OR contact`);
  }

  if (email) {
    queries.push(`"${email}" breach OR leak OR exposed`);
    queries.push(`"${email}" site:pastebin.com OR site:ghostbin.com`);
  }

  if (phone) {
    queries.push(`"${phone}" caller id OR reverse lookup OR spam`);
  }

  if (username) {
    queries.push(`"${username}" doxx OR exposed OR "real name"`);
    queries.push(`"${username}" site:telegram.me OR site:discord.com`);
  }

  return [...new Set(queries)];
}

export function buildRuthlessDiscoveryQueries(claims: ClaimNode[]): string[] {
  return [...new Set([...buildConstellationQueries(claims), ...buildRuthlessExtraQueries(claims)])];
}