interface MapNode {
  id: string;
  url: string;
  type: string;
  status: string;
  confidence?: number | null;
}

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
        <p className="text-sm text-slate-500">
          No exposures mapped yet. Run discovery or add a live URL.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {nodes.map((node) => (
        <div
          key={node.id}
          className={`group rounded-xl border p-4 transition duration-200 hover:border-white/15 ${
            node.layer === "confirmed"
              ? "border-teal-500/25 bg-gradient-to-br from-teal-500/10 to-transparent"
              : "border-white/[0.08] bg-white/[0.02]"
          }`}
        >
          <div className="mb-3 flex items-center justify-between">
            <span
              className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                node.layer === "confirmed"
                  ? "bg-teal-500/15 text-teal-300"
                  : "bg-white/5 text-slate-500"
              }`}
            >
              {node.layer}
            </span>
            {node.confidence != null && (
              <span className="font-mono text-xs text-slate-500">
                {(node.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-white">
            {node.type.replaceAll("_", " ")}
          </p>
          <p className="mt-1 truncate text-xs text-slate-500">{node.url}</p>
          <p className="mt-2 text-[11px] uppercase tracking-wide text-slate-600">
            {node.status.replaceAll("_", " ")}
          </p>
        </div>
      ))}
    </div>
  );
}