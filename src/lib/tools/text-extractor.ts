import { createHash } from "crypto";
import { redactValue } from "@/lib/crypto/encryption";

export function extractVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

export function redactExcerpt(text: string, sensitiveTerms: string[]): string {
  let excerpt = text.slice(0, 500);
  for (const term of sensitiveTerms) {
    if (!term || term.length < 3) continue;
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    excerpt = excerpt.replace(regex, redactValue(term));
  }
  return excerpt;
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}