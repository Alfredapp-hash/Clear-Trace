import { describe, expect, it } from "vitest";
import {
  decodeHtmlEntities,
  extractVisibleText,
  extractVisibleTextDetailed,
  MAX_VISIBLE_TEXT_CHARS,
} from "./text-extractor";

describe("decodeHtmlEntities", () => {
  it("decodes decimal and hex numeric references", () => {
    expect(decodeHtmlEntities("O&#39;Brien")).toBe("O'Brien");
    expect(decodeHtmlEntities("O&#x27;Brien")).toBe("O'Brien");
    expect(decodeHtmlEntities("O&#X27;Brien")).toBe("O'Brien");
    expect(decodeHtmlEntities("&#128512;")).toBe("😀");
  });

  it("decodes named references", () => {
    expect(decodeHtmlEntities("Jos&eacute; &amp; Ren&eacute;e &apos;Q&apos;")).toBe("José & Renée 'Q'");
    expect(decodeHtmlEntities("&ldquo;Hi&rdquo; &mdash; &copy;")).toBe("“Hi” — ©");
  });

  it("decodes in one pass (no double decoding)", () => {
    expect(decodeHtmlEntities("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });

  it("leaves unknown names and invalid code points safe", () => {
    expect(decodeHtmlEntities("&notareal; x")).toBe("&notareal; x");
    expect(decodeHtmlEntities("&#0;&#xD800;")).toBe("��");
  });
});

describe("extractVisibleText", () => {
  it("no longer cuts at 8000 chars", () => {
    const html = `<p>${"a ".repeat(6000)}</p><h1>Jane Doe</h1>`;
    const text = extractVisibleText(html);
    expect(text.length).toBeGreaterThan(8000);
    expect(text.endsWith("Jane Doe")).toBe(true);
  });

  it("drops scripts, styles and comments", () => {
    expect(extractVisibleText("<style>x{}</style><script>var a=1</script><!-- hidden --><p>Hi&nbsp;there</p>")).toBe(
      "Hi there",
    );
  });

  it("flags truncation past the cap", () => {
    const small = extractVisibleTextDetailed("<p>hello world</p>", 5);
    expect(small).toEqual({ text: "hello", truncated: true });
    const full = extractVisibleTextDetailed("<p>hello</p>");
    expect(full.truncated).toBe(false);
    expect(MAX_VISIBLE_TEXT_CHARS).toBeGreaterThan(8000);
  });
});
