import { isSampleUrl, itemStatusLabel, sourceTypeLabel } from "@/lib/ux/plain-status";

interface MapNode {
  id: string;
  url: string;
  type: string;
  status: string;
  confidence?: number | null;
}

/** Sidebar list of confirmed pages and possible matches (one column). */
export function ExposureMap({
  candidates,
  exposures,
}: {
  candidates: MapNode[];
  exposures: MapNode[];
}) {
  const nodes = [
    ...exposures.map((e) => ({ ...e, layer: "confirmed" as const })),
    ...candidates
      .filter((c) => !exposures.some((e) => e.url === c.url))
      .map((c) => ({ ...c, layer: "candidate" as const })),
  ];

  if (!nodes.length) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center">
        <p className="text-sm text-[var(--muted)]">
          Nothing found yet. Search for your information or add a page you found.
        </p>
      </div>
    );
  }

  return (
    <ul className="grid gap-3">
      {nodes.map((node) => (
        <li
          key={node.id}
          className={`min-w-0 rounded-xl border p-4 transition duration-200 hover:border-white/15 ${
            node.layer === "confirmed"
              ? "border-teal-500/25 bg-gradient-to-br from-teal-500/10 to-transparent"
              : "border-white/[0.08] bg-white/[0.02]"
          }`}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                node.layer === "confirmed"
                  ? "bg-teal-500/15 text-teal-200"
                  : "bg-white/5 text-[var(--muted)]"
              }`}
            >
              {node.layer === "confirmed" ? "Confirmed" : "Possible match"}
              {isSampleUrl(node.url) ? " · Sample" : ""}
            </span>
            {node.confidence != null && (
              <span className="font-mono text-xs text-[var(--muted)]">
                {(node.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-white">{sourceTypeLabel(node.type)}</p>
          <p className="mt-1 truncate text-xs text-[var(--muted)]" title={node.url}>
            {node.url}
          </p>
          <p className="mt-2 text-xs text-[var(--muted)]">{itemStatusLabel(node.status)}</p>
        </li>
      ))}
    </ul>
  );
}
