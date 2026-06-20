export type SearchEngine = "google" | "bing" | "duckduckgo" | "yahoo";

export interface DeindexTool {
  engine: SearchEngine;
  label: string;
  toolUrl: string;
  instructions: string[];
}

export const DEINDEX_TOOLS: DeindexTool[] = [
  {
    engine: "google",
    label: "Google — Remove outdated content",
    toolUrl: "https://search.google.com/search-console/remove-outdated-content",
    instructions: [
      "Remove or update the source page first when possible.",
      "Open Google's Remove Outdated Content tool (Search Console).",
      "Submit the search result URL that still shows old personal information.",
      "Google reviews separately from broker opt-out — not guaranteed.",
    ],
  },
  {
    engine: "bing",
    label: "Bing — Content removal",
    toolUrl: "https://www.bing.com/webmasters/about",
    instructions: [
      "Use Bing Webmaster Tools content removal after source removal.",
      "Submit the outdated result URL with factual description.",
    ],
  },
  {
    engine: "duckduckgo",
    label: "DuckDuckGo — Privacy request",
    toolUrl: "https://duckduckgo.com/duckduckgo-help-pages/privacy-complaints/",
    instructions: [
      "File a privacy complaint for search results linking to outdated personal data.",
      "Reference that the source has been removed or corrected when applicable.",
    ],
  },
  {
    engine: "yahoo",
    label: "Yahoo — Search suppression",
    toolUrl: "https://help.yahoo.com/kb/SLN2206.html",
    instructions: [
      "Use Yahoo's published process for search listing concerns.",
      "Provide the exact result URL and removal context.",
    ],
  },
];

export function buildDeindexDraft(sourceUrl: string, engine: SearchEngine): {
  subject: string;
  body: string;
  tool: DeindexTool;
} {
  const tool = DEINDEX_TOOLS.find((t) => t.engine === engine)!;
  return {
    tool,
    subject: `Search result review — outdated personal information (${engine})`,
    body: `I am requesting review of a search result linking to outdated personal information.

Source / result URL: ${sourceUrl}

The original listing may have been removed or corrected at the source. I am requesting review under your published outdated-content or privacy process.

I understand search removal is separate from data-broker opt-out and is not guaranteed.

Thank you for your review.`,
  };
}