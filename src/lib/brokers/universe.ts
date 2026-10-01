export interface BrokerEntry {
  id: string;
  name: string;
  domain: string;
  type: "data_broker" | "people_search" | "public_records";
  optOutUrl?: string;
  privacyUrl?: string;
  estimatedReach: "low" | "medium" | "high";
}

/**
 * Known broker universe. Domains are unique (duplicate peoplelooker.com /
 * checkpeople.com entries removed in Sprint 1). `optOutUrl` must point at an actual
 * opt-out / suppression flow; entries whose only known URL is a generic
 * privacy/help/contact page have no optOutUrl (resolveFromPlaybook then falls back
 * to the privacy contact) and carry a TODO to research the real flow.
 */
export const BROKER_UNIVERSE: BrokerEntry[] = [
  // High-reach people-search / data brokers
  { id: "spokeo", name: "Spokeo", domain: "spokeo.com", type: "data_broker", optOutUrl: "https://www.spokeo.com/optout", privacyUrl: "https://www.spokeo.com/privacy", estimatedReach: "high" },
  { id: "whitepages", name: "Whitepages", domain: "whitepages.com", type: "people_search", optOutUrl: "https://www.whitepages.com/suppression-requests", privacyUrl: "https://www.whitepages.com/privacy", estimatedReach: "high" },
  { id: "beenverified", name: "BeenVerified", domain: "beenverified.com", type: "data_broker", optOutUrl: "https://www.beenverified.com/app/optout/search", privacyUrl: "https://www.beenverified.com/privacy", estimatedReach: "high" },
  { id: "truthfinder", name: "TruthFinder", domain: "truthfinder.com", type: "data_broker", optOutUrl: "https://www.truthfinder.com/opt-out/", privacyUrl: "https://www.truthfinder.com/privacy", estimatedReach: "high" },
  { id: "intelius", name: "Intelius", domain: "intelius.com", type: "people_search", optOutUrl: "https://www.intelius.com/opt-out", privacyUrl: "https://www.intelius.com/privacy", estimatedReach: "high" },
  { id: "instantcheckmate", name: "Instant Checkmate", domain: "instantcheckmate.com", type: "data_broker", optOutUrl: "https://www.instantcheckmate.com/opt-out/", privacyUrl: "https://www.instantcheckmate.com/privacy", estimatedReach: "medium" },
  { id: "fastpeoplesearch", name: "FastPeopleSearch", domain: "fastpeoplesearch.com", type: "people_search", optOutUrl: "https://www.fastpeoplesearch.com/removal", estimatedReach: "high" },
  { id: "truepeoplesearch", name: "TruePeopleSearch", domain: "truepeoplesearch.com", type: "people_search", optOutUrl: "https://www.truepeoplesearch.com/removal", estimatedReach: "high" },
  { id: "thatsthem", name: "ThatsThem", domain: "thatsthem.com", type: "people_search", optOutUrl: "https://thatsthem.com/optout", privacyUrl: "https://thatsthem.com/privacy", estimatedReach: "medium" },
  { id: "radaris", name: "Radaris", domain: "radaris.com", type: "data_broker", optOutUrl: "https://radaris.com/control/privacy", privacyUrl: "https://radaris.com/privacy", estimatedReach: "medium" },
  { id: "mylife", name: "MyLife", domain: "mylife.com", type: "people_search", optOutUrl: "https://www.mylife.com/ccpa/index.pubview", privacyUrl: "https://www.mylife.com/privacy-policy", estimatedReach: "high" },
  { id: "usphonebook", name: "USPhonebook", domain: "usphonebook.com", type: "people_search", optOutUrl: "https://www.usphonebook.com/opt-out", estimatedReach: "medium" },
  { id: "addresses", name: "Addresses.com", domain: "addresses.com", type: "people_search", optOutUrl: "https://www.addresses.com/optout.php", estimatedReach: "medium" },
  { id: "nuwber", name: "Nuwber", domain: "nuwber.com", type: "data_broker", optOutUrl: "https://nuwber.com/removal/link", privacyUrl: "https://nuwber.com/privacy", estimatedReach: "medium" },
  { id: "peekyou", name: "PeekYou", domain: "peekyou.com", type: "people_search", optOutUrl: "https://www.peekyou.com/about/contact/optout/", privacyUrl: "https://www.peekyou.com/about/privacy", estimatedReach: "medium" },
  { id: "zabasearch", name: "ZabaSearch", domain: "zabasearch.com", type: "people_search", optOutUrl: "https://www.zabasearch.com/block_records/", estimatedReach: "low" },
  { id: "anywho", name: "AnyWho", domain: "anywho.com", type: "people_search", optOutUrl: "https://www.anywho.com/optout", estimatedReach: "low" },
  { id: "peoplefinders", name: "PeopleFinders", domain: "peoplefinders.com", type: "data_broker", optOutUrl: "https://www.peoplefinders.com/opt-out", privacyUrl: "https://www.peoplefinders.com/privacy", estimatedReach: "medium" },
  { id: "publicrecords", name: "PublicRecords.com", domain: "publicrecords.com", type: "public_records", optOutUrl: "https://www.publicrecords.com/content/optout.html", estimatedReach: "medium" },
  { id: "familytreenow", name: "FamilyTreeNow", domain: "familytreenow.com", type: "people_search", optOutUrl: "https://www.familytreenow.com/optout", estimatedReach: "medium" },

  // Extended broker list — major aggregators
  { id: "infotracer", name: "InfoTracer", domain: "infotracer.com", type: "data_broker", optOutUrl: "https://infotracer.com/optout/", privacyUrl: "https://infotracer.com/privacy", estimatedReach: "medium" },
  { id: "checkpeople", name: "CheckPeople", domain: "checkpeople.com", type: "data_broker", optOutUrl: "https://checkpeople.com/opt-out", privacyUrl: "https://checkpeople.com/privacy", estimatedReach: "medium" },
  { id: "cyberbackgroundchecks", name: "CyberBackgroundChecks", domain: "cyberbackgroundchecks.com", type: "data_broker", optOutUrl: "https://www.cyberbackgroundchecks.com/removal", estimatedReach: "medium" },
  { id: "peoplelooker", name: "PeopleLooker", domain: "peoplelooker.com", type: "data_broker", optOutUrl: "https://www.peoplelooker.com/optout", privacyUrl: "https://www.peoplelooker.com/privacy", estimatedReach: "medium" },
  { id: "clustrmaps", name: "ClustrMaps", domain: "clustrmaps.com", type: "people_search", optOutUrl: "https://clustrmaps.com/bl/opt-out", estimatedReach: "low" },
  { id: "usatrace", name: "USATrace", domain: "usatrace.com", type: "data_broker", optOutUrl: "https://www.usatrace.com/optout", estimatedReach: "low" },
  { id: "ussearch", name: "US Search", domain: "ussearch.com", type: "data_broker", optOutUrl: "https://www.ussearch.com/opt-out/submit", privacyUrl: "https://www.ussearch.com/privacy", estimatedReach: "medium" },
  { id: "publicdatausa", name: "PublicDataUSA", domain: "publicdatausa.com", type: "public_records", optOutUrl: "https://www.publicdatausa.com/remove.php", estimatedReach: "low" },
  { id: "smartbackgroundchecks", name: "SmartBackgroundChecks", domain: "smartbackgroundchecks.com", type: "data_broker", optOutUrl: "https://www.smartbackgroundchecks.com/optout", estimatedReach: "medium" },
  { id: "idtrue", name: "IDTrue", domain: "idtrue.com", type: "data_broker", optOutUrl: "https://www.idtrue.com/optout/", estimatedReach: "low" },
  { id: "voterrecords", name: "VoterRecords", domain: "voterrecords.com", type: "public_records", privacyUrl: "https://voterrecords.com/privacy", estimatedReach: "medium" }, // TODO(sprint-1): no verified opt-out URL — previous value was a help/privacy/contact page
  { id: "arrestfacts", name: "ArrestFacts", domain: "arrestfacts.com", type: "public_records", optOutUrl: "https://arrestfacts.com/ng/control/privacy", estimatedReach: "low" },
  { id: "mugshots", name: "Mugshots.com", domain: "mugshots.com", type: "public_records", privacyUrl: "https://mugshots.com/privacy.html", estimatedReach: "medium" },
  { id: "busted", name: "BustedMugshots", domain: "bustedmugshots.com", type: "public_records", optOutUrl: "https://www.bustedmugshots.com/removal", estimatedReach: "medium" },
  { id: "privaterecords", name: "PrivateRecords.net", domain: "privaterecords.net", type: "data_broker", optOutUrl: "https://privaterecords.net/optout", estimatedReach: "low" },
  { id: "neighborwho", name: "NeighborWho", domain: "neighborwho.com", type: "people_search", optOutUrl: "https://www.neighborwho.com/app/optout/search", estimatedReach: "medium" },
  { id: "telephonedirectories", name: "TelephoneDirectories", domain: "telephonedirectories.us", type: "people_search", optOutUrl: "https://www.telephonedirectories.us/edit_remove", estimatedReach: "low" },
  { id: "reversephonelookup", name: "Reverse Phone Lookup", domain: "reversephonelookup.com", type: "people_search", privacyUrl: "https://www.reversephonelookup.com/privacy", estimatedReach: "low" },
  { id: "411", name: "411.com", domain: "411.com", type: "people_search", estimatedReach: "medium" }, // TODO(sprint-1): no verified opt-out URL — previous value was a help/privacy/contact page
  { id: "yellowpages", name: "YellowPages", domain: "yellowpages.com", type: "people_search", estimatedReach: "medium" }, // TODO(sprint-1): no verified opt-out URL — previous value was a help/privacy/contact page
  { id: "opencorporates", name: "OpenCorporates", domain: "opencorporates.com", type: "public_records", privacyUrl: "https://opencorporates.com/privacy", estimatedReach: "medium" },
  { id: "peopleby", name: "PeopleByName", domain: "peoplebyname.com", type: "people_search", optOutUrl: "https://www.peoplebyname.com/remove.php", estimatedReach: "low" },
  { id: "peoplesmart", name: "PeopleSmart", domain: "peoplesmart.com", type: "data_broker", optOutUrl: "https://www.peoplesmart.com/optout-go", privacyUrl: "https://www.peoplesmart.com/privacy", estimatedReach: "medium" },
  { id: "spokeo2", name: "PeopleSearch123", domain: "peoplesearch123.com", type: "people_search", privacyUrl: "https://www.peoplesearch123.com/privacy", estimatedReach: "low" },
  { id: "backgroundalert", name: "BackgroundAlert", domain: "backgroundalert.com", type: "data_broker", optOutUrl: "https://www.backgroundalert.com/optout/", estimatedReach: "low" },
  { id: "recordsfinder", name: "RecordsFinder", domain: "recordsfinder.com", type: "public_records", optOutUrl: "https://recordsfinder.com/opt-out/", estimatedReach: "low" },
  { id: "searchsystems", name: "SearchSystems", domain: "searchsystems.net", type: "public_records", privacyUrl: "https://searchsystems.net/privacy", estimatedReach: "low" },
  { id: "councilon", name: "CounciLon", domain: "councilon.com", type: "data_broker", privacyUrl: "https://www.councilon.com/privacy", estimatedReach: "low" },
  { id: "zoominfo", name: "ZoomInfo", domain: "zoominfo.com", type: "data_broker", optOutUrl: "https://www.zoominfo.com/about/privacy/privacycenter", privacyUrl: "https://www.zoominfo.com/about/privacy", estimatedReach: "high" },
  { id: "clearbit", name: "Clearbit", domain: "clearbit.com", type: "data_broker", optOutUrl: "https://dashboard.clearbit.com/privacy", privacyUrl: "https://clearbit.com/privacy", estimatedReach: "medium" },
  { id: "pdl", name: "PeopleDataLabs", domain: "peopledatalabs.com", type: "data_broker", optOutUrl: "https://www.peopledatalabs.com/opt-out", privacyUrl: "https://www.peopledatalabs.com/privacy", estimatedReach: "medium" },
  { id: "pipl", name: "Pipl", domain: "pipl.com", type: "data_broker", optOutUrl: "https://pipl.com/personal-information-removal-request/", privacyUrl: "https://pipl.com/privacy", estimatedReach: "medium" },
  { id: "acxiom", name: "Acxiom", domain: "acxiom.com", type: "data_broker", optOutUrl: "https://isapps.acxiom.com/optout/optout.aspx", privacyUrl: "https://www.acxiom.com/privacy/", estimatedReach: "high" },
  { id: "epsilon", name: "Epsilon / Conversant", domain: "epsilon.com", type: "data_broker", optOutUrl: "https://www.epsilon.com/us/privacy-policy/opt-out", privacyUrl: "https://www.epsilon.com/us/privacy-policy", estimatedReach: "high" },
  { id: "comscore", name: "Comscore", domain: "comscore.com", type: "data_broker", optOutUrl: "https://www.comscore.com/About-comScore/Privacy/Opt-out-of-comScore-panel", privacyUrl: "https://www.comscore.com/About-comScore/Privacy", estimatedReach: "medium" },
  { id: "towerdata", name: "TowerData / Zeta Global", domain: "towerdata.com", type: "data_broker", optOutUrl: "https://www.towerdata.com/company/opt_out.html", privacyUrl: "https://www.towerdata.com/company/privacy_policy.html", estimatedReach: "medium" },
  { id: "lexisnexis", name: "LexisNexis Risk Solutions", domain: "risk.lexisnexis.com", type: "data_broker", optOutUrl: "https://optout.lexisnexis.com/", privacyUrl: "https://risk.lexisnexis.com/privacy", estimatedReach: "high" },
  { id: "veromi", name: "Veromi", domain: "veromi.net", type: "people_search", estimatedReach: "low" }, // TODO(sprint-1): no verified opt-out URL — previous value was a help/privacy/contact page
  { id: "dobsearch", name: "DOBSearch", domain: "dobsearch.com", type: "people_search", optOutUrl: "https://www.dobsearch.com/people-finder/pf_remove_record.php", estimatedReach: "low" },
  { id: "checkr", name: "Checkr", domain: "checkr.com", type: "data_broker", optOutUrl: "https://checkr.com/privacy/consumer", privacyUrl: "https://checkr.com/privacy", estimatedReach: "medium" },
  { id: "backgroundcheck", name: "BackgroundCheck.run", domain: "backgroundcheck.run", type: "data_broker", optOutUrl: "https://backgroundcheck.run/optout", estimatedReach: "low" },

  // v0.9 expansion — additional high-traffic people-search sites
  { id: "gladiknow", name: "Glad I Know", domain: "gladiknow.com", type: "people_search", optOutUrl: "https://gladiknow.com/optout", estimatedReach: "medium" },
  { id: "allpeople", name: "AllPeople", domain: "allpeople.com", type: "people_search", optOutUrl: "https://allpeople.com/remove", estimatedReach: "medium" },
  { id: "spydialer", name: "SpyDialer", domain: "spydialer.com", type: "people_search", optOutUrl: "https://www.spydialer.com/optout", estimatedReach: "medium" },
  { id: "numlookup", name: "NumLookup", domain: "numlookup.com", type: "people_search", optOutUrl: "https://www.numlookup.com/opt-out", estimatedReach: "medium" },

  { id: "openpeoplesearch", name: "OpenPeopleSearch", domain: "openpeoplesearch.com", type: "people_search", optOutUrl: "https://www.openpeoplesearch.com/optout", estimatedReach: "medium" },
  { id: "peoplewhiz", name: "PeopleWhiz", domain: "peoplewhiz.com", type: "people_search", privacyUrl: "https://www.peoplewhiz.com/privacy", estimatedReach: "medium" },
  { id: "searchpeoplefree", name: "SearchPeopleFree", domain: "searchpeoplefree.com", type: "people_search", optOutUrl: "https://www.searchpeoplefree.com/opt-out", estimatedReach: "medium" },
  { id: "freepeopledirectory", name: "Free People Directory", domain: "freepeopledirectory.com", type: "people_search", optOutUrl: "https://www.freepeopledirectory.com/optout", estimatedReach: "low" },
  { id: "mugshotlook", name: "MugshotLook", domain: "mugshotlook.com", type: "public_records", optOutUrl: "https://www.mugshotlook.com/optout", estimatedReach: "low" },
  { id: "publicrecordsnow", name: "PublicRecordsNow", domain: "publicrecordsnow.com", type: "public_records", optOutUrl: "https://www.publicrecordsnow.com/optout", estimatedReach: "medium" },
  { id: "contactout", name: "ContactOut", domain: "contactout.com", type: "data_broker", optOutUrl: "https://contactout.com/optout", privacyUrl: "https://contactout.com/privacy", estimatedReach: "medium" },
  { id: "seamless", name: "Seamless.AI", domain: "seamless.ai", type: "data_broker", privacyUrl: "https://seamless.ai/privacy", estimatedReach: "medium" }, // TODO(sprint-1): no verified opt-out URL — previous value was a help/privacy/contact page
  { id: "apollo", name: "Apollo.io", domain: "apollo.io", type: "data_broker", privacyUrl: "https://www.apollo.io/privacy-policy", estimatedReach: "high" }, // TODO(sprint-1): no verified opt-out URL — previous value was a help/privacy/contact page
  { id: "lusha", name: "Lusha", domain: "lusha.com", type: "data_broker", optOutUrl: "https://www.lusha.com/privacy-center/", privacyUrl: "https://www.lusha.com/privacy-policy/", estimatedReach: "medium" },
  { id: "melissa", name: "Melissa Data", domain: "melissa.com", type: "data_broker", privacyUrl: "https://www.melissa.com/privacy", estimatedReach: "medium" }, // TODO(sprint-1): no verified opt-out URL — previous value was a help/privacy/contact page
  { id: "spokeo_alt", name: "UnitedStatesPhonebook", domain: "unitedstatesphonebook.com", type: "people_search", optOutUrl: "https://www.unitedstatesphonebook.com/opt-out", estimatedReach: "medium" },
  { id: "revealphone", name: "RevealPhoneOwner", domain: "revealphoneowner.com", type: "people_search", privacyUrl: "https://www.revealphoneowner.com/privacy", estimatedReach: "low" },
  { id: "zlookup", name: "ZLookup", domain: "zlookup.com", type: "people_search", optOutUrl: "https://www.zlookup.com/optout", estimatedReach: "medium" },
];

export function matchBrokerByHost(hostname: string): BrokerEntry | undefined {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return BROKER_UNIVERSE.find(
    (b) => host === b.domain || host.endsWith(`.${b.domain}`),
  );
}

export function brokerSiteQueries(name: string, city?: string): string[] {
  const highReach = BROKER_UNIVERSE.filter((b) => b.estimatedReach === "high");
  const medReach = BROKER_UNIVERSE.filter((b) => b.estimatedReach === "medium").slice(0, 6);
  const top = [...highReach, ...medReach];
  return top.map((b) => {
    const loc = city ? ` ${city}` : "";
    return `site:${b.domain} "${name}"${loc}`;
  });
}

export function getBrokersWithOptOut(): BrokerEntry[] {
  return BROKER_UNIVERSE.filter((b) => b.optOutUrl);
}

export function getBrokersByReach(reach: "high" | "medium" | "low"): BrokerEntry[] {
  return BROKER_UNIVERSE.filter((b) => b.estimatedReach === reach);
}
