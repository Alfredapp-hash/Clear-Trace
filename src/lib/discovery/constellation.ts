export interface ClaimNode {
  claimType: string;
  value: string;
}

/** Build expanded search queries from identity claim graph. */
export function buildConstellationQueries(claims: ClaimNode[]): string[] {
  const byType = Object.fromEntries(claims.map((c) => [c.claimType, c.value]));
  const name = byType.full_name;
  const city = byType.city_state ?? byType.city;
  const state = byType.state;
  const email = byType.email;
  const phone = byType.phone;
  const username = byType.username;
  const employer = byType.employer;
  const address = byType.address;
  const zip = byType.zip_code;
  const dob = byType.date_of_birth;
  const maidenName = byType.maiden_name;
  const linkedinUrl = byType.linkedin_url;
  const twitterHandle = byType.twitter_handle;
  const githubUsername = byType.github_username;
  const redditUsername = byType.reddit_username;
  const queries: string[] = [];

  // --- Core identity queries ---
  if (name && city) queries.push(`"${name}" ${city}`);
  if (name && city) queries.push(`"${name}" ${city} phone OR address`);
  if (name && city) queries.push(`"${name}" ${city} contact information`);
  if (name && state) queries.push(`"${name}" ${state} address`);
  if (name) queries.push(`"${name}" people search`);
  if (name) queries.push(`"${name}" whitepages OR spokeo OR beenverified OR intelius`);
  if (name) queries.push(`"${name}" truepeoplesearch OR fastpeoplesearch OR thatsthem`);
  if (name) queries.push(`"${name}" background check public records`);

  // --- Broker-specific queries ---
  if (name && city) queries.push(`site:fastpeoplesearch.com "${name}"`);
  if (name && city) queries.push(`site:truepeoplesearch.com "${name}" ${city}`);
  if (name) queries.push(`site:radaris.com "${name}"`);
  if (name) queries.push(`site:spokeo.com "${name}"`);
  if (name) queries.push(`site:whitepages.com "${name}"`);
  if (name) queries.push(`site:peekyou.com "${name}"`);

  // --- Contact information queries ---
  if (name && employer) queries.push(`"${name}" ${employer}`);
  if (name && employer) queries.push(`"${name}" "${employer}" contact`);
  if (email) queries.push(`"${email}" site:hunter.io OR site:rocketreach.co OR site:apollo.io`);
  if (email) queries.push(`"${email}" public profile`);
  if (phone) queries.push(`"${phone}" listing`);
  if (phone) queries.push(`"${phone}" reverse phone lookup`);
  if (address) queries.push(`"${address}" people search`);

  // --- Social / platform discovery ---
  if (username) queries.push(`"${username}" profile site:instagram.com OR site:twitter.com OR site:tiktok.com`);
  if (username) queries.push(`"${username}" site:reddit.com OR site:linkedin.com OR site:github.com`);
  if (username) queries.push(`"${username}" profile account`);
  if (twitterHandle) queries.push(`site:twitter.com "${twitterHandle}"`);
  if (linkedinUrl) queries.push(`"${linkedinUrl}" OR site:linkedin.com "${name}"`);
  if (githubUsername) queries.push(`site:github.com "${githubUsername}"`);
  if (redditUsername) queries.push(`site:reddit.com/user "${redditUsername}"`);

  // --- Professional directory queries ---
  if (name) queries.push(`site:zoominfo.com "${name}"`);
  if (name && employer) queries.push(`site:linkedin.com "${name}" "${employer}"`);
  if (name) queries.push(`site:clearbit.com "${name}" OR site:apollo.io "${name}"`);
  if (email) queries.push(`site:zoominfo.com "${email}" OR site:apollo.io "${email}"`);

  // --- Historical / identity variation queries ---
  if (maidenName && city) queries.push(`"${maidenName}" ${city} people search`);
  if (maidenName) queries.push(`"${maidenName}" whitepages OR spokeo`);
  if (dob && name) queries.push(`"${name}" "${dob}" record`);
  if (zip) queries.push(`"${name}" "${zip}" public record`);

  // --- Public records / court / voter ---
  if (name && city) queries.push(`"${name}" court records OR arrest records ${city}`);
  if (name && state) queries.push(`"${name}" voter registration ${state}`);
  if (name && city) queries.push(`"${name}" property records ${city}`);
  if (name) queries.push(`site:voterrecords.com "${name}"`);

  // --- Image / likeness discovery ---
  if (name) queries.push(`"${name}" photo OR picture site:instagram.com OR site:flickr.com`);

  return [...new Set(queries)];
}
