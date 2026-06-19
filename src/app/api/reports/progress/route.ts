import { getSession } from "@/lib/auth/session";
import { jsonError, jsonOk } from "@/lib/api";
import { buildProgressReport } from "@/lib/reports/progress-report";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return jsonError("Unauthorized", 401);

  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "json";

  const report = await buildProgressReport(session);

  if (format === "markdown") {
    return new Response(report.markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="cleartrace-progress-report.md"`,
      },
    });
  }

  return jsonOk({ report });
}