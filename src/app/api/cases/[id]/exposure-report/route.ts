import { ensureDatabase } from "@/lib/db/init";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { jsonError, jsonOk } from "@/lib/api";
import { buildExposureReport } from "@/lib/reports/exposure-report";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;

  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "json";

  try {
    const report = await buildExposureReport(id, access.session);
    if (format === "markdown") {
      return new Response(report.markdown, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="exposure-report-${encodeURIComponent(id.slice(0, 8))}.md"`,
          "Cache-Control": "no-store",
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
