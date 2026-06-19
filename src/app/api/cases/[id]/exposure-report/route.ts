import { getSession } from "@/lib/auth/session";
import { jsonError, jsonOk } from "@/lib/api";
import { buildExposureReport } from "@/lib/reports/exposure-report";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return jsonError("Unauthorized", 401);

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "json";

  try {
    const report = await buildExposureReport(id, session);
    if (format === "markdown") {
      return new Response(report.markdown, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="exposure-report-${id.slice(0, 8)}.md"`,
        },
      });
    }
    return jsonOk({ report });
  } catch (error) {
    if (error instanceof Error && error.message === "CASE_NOT_FOUND") {
      return jsonError("Case not found", 404);
    }
    throw error;
  }
}