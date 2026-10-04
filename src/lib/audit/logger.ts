import { createHash } from "crypto";
import { sqlite } from "@/lib/db";
import { ensureDatabase } from "@/lib/db/init";
import { v4 as uuid } from "uuid";

export interface AuditEventInput {
  caseId?: string;
  organizationId?: string;
  userId?: string;
  eventType: string;
  summary: string;
  detail?: Record<string, unknown>;
}

/**
 * Detail keys that carry subject PII or free text and must never be persisted in the
 * audit log (which outlives case data). Values under these keys are dropped.
 */
const PII_DETAIL_KEYS = new Set(
  [
    "title",
    "caseTitle",
    "name",
    "displayName",
    "fullName",
    "reason",
    "email",
    "phone",
    "address",
    "notes",
    "note",
    "value",
    "values",
    "query",
    "queryText",
    "subject",
    "body",
    "recipient",
    "claims",
    "encryptedValue",
    "password",
    "secret",
    "apiKey",
  ].map((k) => k.toLowerCase()),
);

function sanitizeDetail(detail?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (PII_DETAIL_KEYS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Redacts quoted free text (e.g. case titles embedded as `Privacy case "Jane Doe" created`). */
function sanitizeSummary(summary: string): string {
  return summary
    .replace(/"[^"]*"/g, '"[redacted]"')
    .replace(/“[^”]*”/g, "“[redacted]”");
}

/** Strips PII from an audit event before it is stored or sent to webhooks. */
export function sanitizeAuditInput(input: AuditEventInput): AuditEventInput {
  return {
    ...input,
    summary: sanitizeSummary(input.summary),
    detail: sanitizeDetail(input.detail),
  };
}

/** Hash-chain partition. Case events and org-level events form separate chains. */
export function auditChainKey(input: Pick<AuditEventInput, "caseId" | "organizationId">): string {
  if (input.caseId) return `case:${input.caseId}`;
  if (input.organizationId) return `org:${input.organizationId}`;
  return "global";
}

export function computeEventHash(event: {
  id: string;
  caseId?: string | null;
  organizationId?: string | null;
  userId?: string | null;
  eventType: string;
  summary: string;
  detail?: Record<string, unknown> | null;
  prevHash: string;
  createdAt: string;
  chainKey?: string | null;
}): string {
  const payload = JSON.stringify({
    id: event.id,
    caseId: event.caseId ?? null,
    organizationId: event.organizationId ?? null,
    userId: event.userId ?? null,
    eventType: event.eventType,
    summary: event.summary,
    detail: event.detail ?? null,
    prevHash: event.prevHash,
    createdAt: event.createdAt,
    ...(event.chainKey ? { chainKey: event.chainKey } : {}),
  });
  return createHash("sha256").update(payload).digest("hex");
}

interface TailRow {
  event_hash: string;
}

function chainTail(chainKey: string, input: AuditEventInput): string {
  const tail = sqlite
    .prepare(
      "SELECT event_hash FROM audit_events WHERE chain_key = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(chainKey) as TailRow | undefined;
  if (tail) return tail.event_hash;

  // Continue a pre-chain_key (legacy) chain rather than forking it.
  const legacy = input.caseId
    ? (sqlite
        .prepare(
          "SELECT event_hash FROM audit_events WHERE chain_key IS NULL AND case_id = ? ORDER BY rowid DESC LIMIT 1",
        )
        .get(input.caseId) as TailRow | undefined)
    : input.organizationId
      ? (sqlite
          .prepare(
            "SELECT event_hash FROM audit_events WHERE chain_key IS NULL AND case_id IS NULL AND organization_id = ? ORDER BY rowid DESC LIMIT 1",
          )
          .get(input.organizationId) as TailRow | undefined)
      : undefined;
  return legacy?.event_hash ?? "GENESIS";
}

const insertStmt = () =>
  sqlite.prepare(
    `INSERT INTO audit_events
      (id, case_id, organization_id, user_id, event_type, summary, detail_json, prev_hash, event_hash, chain_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

const writeTx = sqlite.transaction((event: AuditEventInput, id: string, createdAt: string) => {
  const chainKey = auditChainKey(event);
  const prevHash = chainTail(chainKey, event);
  const eventHash = computeEventHash({ ...event, id, createdAt, prevHash, chainKey });
  insertStmt().run(
    id,
    event.caseId ?? null,
    event.organizationId ?? null,
    event.userId ?? null,
    event.eventType,
    event.summary,
    event.detail ? JSON.stringify(event.detail) : null,
    prevHash,
    eventHash,
    chainKey,
    createdAt,
  );
});

/**
 * Synchronously appends a sanitized audit event. Tail lookup + insert run in one
 * IMMEDIATE transaction (or a savepoint when called inside an outer transaction),
 * so concurrent writers cannot fork a chain. Does NOT dispatch webhooks.
 */
export function writeAuditEventSync(input: AuditEventInput): {
  id: string;
  event: AuditEventInput;
} {
  ensureDatabase();
  const event = sanitizeAuditInput(input);
  const id = uuid();
  const createdAt = new Date().toISOString();
  if (sqlite.inTransaction) {
    writeTx(event, id, createdAt);
  } else {
    writeTx.immediate(event, id, createdAt);
  }
  return { id, event };
}

/** Fire-and-forget webhook fan-out for an already-sanitized event. */
export function dispatchAuditWebhooks(event: AuditEventInput): void {
  void import("@/lib/connectors/webhook-dispatcher")
    .then(({ maybeDispatchWebhook }) => maybeDispatchWebhook(event))
    .catch(() => {});
  void import("@/lib/enterprise/webhook-dispatcher")
    .then(({ dispatchEnterpriseWebhooks }) => dispatchEnterpriseWebhooks(event))
    .catch(() => {});
}

export async function logAuditEvent(input: AuditEventInput): Promise<string> {
  const { id, event } = writeAuditEventSync(input);
  dispatchAuditWebhooks(event);
  return id;
}

interface ChainRow {
  id: string;
  case_id: string | null;
  organization_id: string | null;
  user_id: string | null;
  event_type: string;
  summary: string;
  detail_json: string | null;
  prev_hash: string | null;
  event_hash: string;
  chain_key: string | null;
  created_at: string;
}

/**
 * Verifies linkage and hashes of a chain written with chain_key. Rows scrubbed by case
 * erasure (detail.scrubbed === true) are checked for linkage only.
 */
export function verifyAuditChain(chainKey: string): { ok: boolean; count: number; brokenAt?: string } {
  const rows = sqlite
    .prepare("SELECT * FROM audit_events WHERE chain_key = ? ORDER BY rowid ASC")
    .all(chainKey) as ChainRow[];
  let prev: string | null = null;
  for (const row of rows) {
    if (prev !== null && row.prev_hash !== prev) return { ok: false, count: rows.length, brokenAt: row.id };
    const detail = row.detail_json ? (JSON.parse(row.detail_json) as Record<string, unknown>) : null;
    if (!detail?.scrubbed) {
      const expected = computeEventHash({
        id: row.id,
        caseId: row.case_id,
        organizationId: row.organization_id,
        userId: row.user_id,
        eventType: row.event_type,
        summary: row.summary,
        detail,
        prevHash: row.prev_hash ?? "GENESIS",
        createdAt: row.created_at,
        chainKey: row.chain_key,
      });
      if (expected !== row.event_hash) return { ok: false, count: rows.length, brokenAt: row.id };
    }
    prev = row.event_hash;
  }
  return { ok: true, count: rows.length };
}
