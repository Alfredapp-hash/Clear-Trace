import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { config as proxyConfig } from "@/proxy";

const publicDir = path.join(process.cwd(), "public");

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

const manifest = JSON.parse(readFileSync(path.join(publicDir, "manifest.json"), "utf8")) as {
  icons: ManifestIcon[];
};

/** Read width/height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("PWA manifest icons", () => {
  it("every icon exists with the declared size", () => {
    for (const icon of manifest.icons) {
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(path.join(publicDir, icon.src))).toEqual({ width: w, height: h });
    }
  });

  it("maskable icon is a dedicated padded asset, not the plain 'any' icon", () => {
    const maskable = manifest.icons.filter((i) => i.purpose === "maskable");
    expect(maskable).toHaveLength(1);
    const anyIcons = manifest.icons.filter((i) => i.purpose !== "maskable").map((i) => i.src);
    expect(anyIcons).not.toContain(maskable[0]!.src);
  });

  it("proxy matcher lets every manifest icon through without auth", () => {
    const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);
    expect(matcher.test("/manifest.json")).toBe(false);
    for (const icon of manifest.icons) {
      expect(matcher.test(icon.src), icon.src).toBe(false);
    }
    expect(matcher.test("/apple-touch-icon.png")).toBe(false);
    expect(matcher.test("/cases")).toBe(true);
  });
});
