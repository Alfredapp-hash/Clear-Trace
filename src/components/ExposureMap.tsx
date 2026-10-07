import { safeHttpUrl } from "@/lib/ui/safe-url";
import { isSampleUrl, itemStatusLabel, sourceTypeLabel } from "@/lib/ux/plain-status";

interface MapNode {
  id: string;
  url: string;
  type: string;
  status: string;
  confidence?: number | null;
}

/** Rows shown before "Show all"; the rest sit in a native disclosure (no client JS). */
export const EXPOSURE_MAP_LIMIT = 6;

type Node = MapNode & { layer: "confirmed" | "candidate" };

function NodeItem({ node }: { node: Node }) {
  const sample = isSampleUrl(node.url);
  // Sample pages are not real; everything else opens the page itself, without a referrer.
  const href = sample ? null : safeHttpUrl(node.url);
  return (
    <li
      className={`min-w-0 rounded-xl border p-4 transition duration-200 hover:border-white/15 ${
        node.layer === "confirmed"
          ? "border-teal-500/25 bg-gradient-to-br from-teal-500/10 to-transparent"
          : "border-white/[0.08] bg-white/[0.02]"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
            node.layer === "confirmed" ? "bg-teal-500/15 text-teal-200" : "bg-white/5 text-[var(--muted)]"
          }`}
        >
          {node.layer === "confirmed" ? "Confirmed" : "Possible match"}
          {sample ? " · Sample" : ""}
        </span>
        {node.confidence != null && (
          <span className="font-mono text-xs text-[var(--muted)]">
            {(node.confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <p className="text-sm font-medium text-white">{sourceTypeLabel(node.type)}</p>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          className="mt-1 block truncate text-xs text-teal-300 hover:underline"
          title={node.url}
        >
          {node.url}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <p className="mt-1 truncate text-xs text-[var(--muted)]" title={node.url}>
          {node.url}
        </p>
      )}
      <p className="mt-2 text-xs text-[var(--muted)]">{itemStatusLabel(node.status)}</p>
    </li>
  );
}

/** Sidebar list of confirmed pages and possible matches (one column). */
export function ExposureMap({
  candidates,
  exposures,
  limit = EXPOSURE_MAP_LIMIT,
}: {
  candidates: MapNode[];
  exposures: MapNode[];
  limit?: number;
}) {
  const nodes: Node[] = [
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

  const shown = nodes.slice(0, limit);
  const rest = nodes.slice(limit);
  return (
    <div>
      <ul className="grid gap-3">
        {shown.map((node) => (
          <NodeItem key={node.id} node={node} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="group mt-3">
          <summary className="cursor-pointer list-none text-sm font-medium text-teal-300 hover:text-teal-200 focus-visible:outline-2 focus-visible:outline-teal-300">
            <span className="group-open:hidden">Show all {nodes.length}</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul className="mt-3 grid gap-3">
            {rest.map((node) => (
              <NodeItem key={node.id} node={node} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
