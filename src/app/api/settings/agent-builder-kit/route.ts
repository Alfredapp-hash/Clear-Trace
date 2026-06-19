import { getSession } from "@/lib/auth/session";
import {
  buildAgentBuilderKit,
  BUILDER_PLATFORMS,
  type BuilderPlatform,
} from "@/lib/guide/agent-builder-kit";
import { buildAgentKitZipBuffer } from "@/lib/guide/agent-kit-zip";
import { jsonError, jsonOk } from "@/lib/api";

const PLATFORMS = new Set(BUILDER_PLATFORMS.map((p) => p.id));

function parsePlatform(raw: string | null): BuilderPlatform | null {
  if (!raw || !PLATFORMS.has(raw as BuilderPlatform)) return null;
  return raw as BuilderPlatform;
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return jsonError("Unauthorized", 401);

  const { searchParams } = new URL(request.url);
  const platform = parsePlatform(searchParams.get("platform"));
  if (!platform) {
    return jsonError(
      `platform required — one of: ${BUILDER_PLATFORMS.map((p) => p.id).join(", ")}`,
      400,
    );
  }

  const format = searchParams.get("format") ?? "json";

  if (format === "zip") {
    const buffer = await buildAgentKitZipBuffer(platform);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="cleartrace-agent-kit-${platform}.zip"`,
      },
    });
  }

  const kit = buildAgentBuilderKit(platform);
  return jsonOk({
    platform,
    kit,
    templateUrl: "https://github.com/Alfredapp-hash/Clear-Trace/generate",
    repoUrl: "https://github.com/Alfredapp-hash/Clear-Trace",
    cliCommand: "npx create-cleartrace my-app",
    mcpPath: "agent-builder/mcp-server",
  });
}