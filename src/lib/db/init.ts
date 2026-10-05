import type BetterSqlite3 from "better-sqlite3";
import { sqlite } from "./index";
import {
  EXCLUDED_EXPOSURE_STATUSES,
  deriveCaseStatusFromExposures,
} from "@/lib/cases/derive-status";

type Conn = BetterSqlite3.Database;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    session_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    retention_days INTEGER NOT NULL DEFAULT 365,
    rate_limit_per_hour INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS privacy_cases (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    case_type TEXT NOT NULL,
    target_relationship TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    status_before_pause TEXT,
    scan_scopes TEXT NOT NULL DEFAULT '[]',
    ruthless_mode INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS authorization_records (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    authority_basis TEXT NOT NULL,
    user_attestation INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    guardian_doc_ref TEXT,
    poa_ref TEXT,
    org_auth_ref TEXT,
    attested_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS identity_profiles (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS identity_claims (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES identity_profiles(id),
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    claim_type TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    value_hash TEXT NOT NULL,
    scan_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS scan_runs (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    status TEXT NOT NULL DEFAULT 'queued',
    mode TEXT NOT NULL DEFAULT 'demo',
    query_count INTEGER NOT NULL DEFAULT 0,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS search_queries (
    id TEXT PRIMARY KEY,
    scan_run_id TEXT NOT NULL REFERENCES scan_runs(id),
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    query_text TEXT NOT NULL,
    source_type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS exposure_candidates (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    scan_run_id TEXT NOT NULL REFERENCES scan_runs(id),
    canonical_url TEXT NOT NULL,
    source_type TEXT NOT NULL,
    title TEXT,
    match_status TEXT NOT NULL DEFAULT 'unreviewed',
    confidence_score REAL,
    corroborating_factors TEXT,
    conflicting_factors TEXT,
    evidence_id TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS verified_exposures (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    candidate_id TEXT NOT NULL REFERENCES exposure_candidates(id),
    canonical_url TEXT NOT NULL,
    exposure_class TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'confirmed_exposure',
    exposure_categories TEXT,
    source_class TEXT,
    risk_level TEXT,
    recommended_remedy_family TEXT,
    information_summary TEXT,
    evidence_id TEXT,
    confirmed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS content_evidence (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    source_url TEXT NOT NULL,
    redacted_excerpt TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS controller_targets (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    exposure_id TEXT NOT NULL REFERENCES verified_exposures(id),
    target_type TEXT NOT NULL,
    contact_method TEXT NOT NULL,
    contact_value TEXT NOT NULL,
    confidence_score REAL NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 1,
    policy_url TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS remedy_routes (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    exposure_id TEXT NOT NULL REFERENCES verified_exposures(id),
    controller_target_id TEXT NOT NULL REFERENCES controller_targets(id),
    remedy_type TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    required_user_inputs TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS remediation_cases (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    exposure_id TEXT NOT NULL REFERENCES verified_exposures(id),
    remedy_route_id TEXT NOT NULL REFERENCES remedy_routes(id),
    status TEXT NOT NULL DEFAULT 'draft_ready',
    message_count INTEGER NOT NULL DEFAULT 0,
    follow_up_count INTEGER NOT NULL DEFAULT 0,
    do_not_contact INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS message_drafts (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    remediation_case_id TEXT NOT NULL REFERENCES remediation_cases(id),
    subject TEXT NOT NULL,
    recipient TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_user_approval',
    template_id TEXT,
    template_label TEXT,
    remedy_type TEXT,
    review_items_json TEXT,
    is_follow_up INTEGER NOT NULL DEFAULT 0,
    current_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS message_versions (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES message_drafts(id),
    version INTEGER NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    edited_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS outbound_messages (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    draft_id TEXT NOT NULL REFERENCES message_drafts(id),
    sent_via TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS verification_checks (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    exposure_id TEXT NOT NULL REFERENCES verified_exposures(id),
    status TEXT NOT NULL,
    source_status TEXT NOT NULL,
    search_status TEXT,
    relevant_content_present INTEGER,
    redirect_chain TEXT,
    confidence_score REAL,
    evidence_id TEXT,
    follow_up_eligible INTEGER DEFAULT 0,
    checked_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS monitoring_rules (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    exposure_id TEXT NOT NULL REFERENCES verified_exposures(id),
    schedule TEXT NOT NULL DEFAULT 'weekly',
    next_check_at TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS follow_up_rules (
    id TEXT PRIMARY KEY,
    remediation_case_id TEXT NOT NULL REFERENCES remediation_cases(id),
    max_follow_ups INTEGER NOT NULL DEFAULT 2,
    first_follow_up_days INTEGER NOT NULL DEFAULT 14,
    second_follow_up_days INTEGER NOT NULL DEFAULT 30,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    skill_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    summary TEXT,
    confidence_score REAL,
    output_json TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id),
    task_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    case_id TEXT REFERENCES privacy_cases(id),
    organization_id TEXT REFERENCES organizations(id),
    user_id TEXT REFERENCES users(id),
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail_json TEXT,
    prev_hash TEXT,
    event_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS security_scans (
    id TEXT PRIMARY KEY,
    scan_type TEXT NOT NULL,
    status TEXT NOT NULL,
    findings_json TEXT,
    run_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limit_events (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS remediation_batches (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    status TEXT NOT NULL DEFAULT 'queued',
    total_items INTEGER NOT NULL DEFAULT 0,
    completed_items INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS remediation_batch_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES remediation_batches(id),
    exposure_id TEXT NOT NULL REFERENCES verified_exposures(id),
    step TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS connector_configs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    connector_type TEXT NOT NULL,
    label TEXT,
    encrypted_credentials TEXT NOT NULL,
    masked_preview TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    last_tested_at TEXT,
    last_error TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(organization_id, connector_type)
  )`,
  `CREATE TABLE IF NOT EXISTS sla_deadlines (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    remediation_case_id TEXT REFERENCES remediation_cases(id),
    exposure_id TEXT REFERENCES verified_exposures(id),
    deadline_type TEXT NOT NULL,
    anchor_at TEXT NOT NULL,
    due_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    met_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    scopes_json TEXT NOT NULL DEFAULT '["cases:read","cases:write","broker_sweep"]',
    created_by_user_id TEXT REFERENCES users(id),
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS enterprise_webhooks (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    encrypted_secret TEXT NOT NULL,
    events_json TEXT NOT NULL DEFAULT '["*"]',
    enabled INTEGER NOT NULL DEFAULT 1,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_success_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES enterprise_webhooks(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    http_status INTEGER,
    response_body TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS broker_sweep_runs (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    status TEXT NOT NULL DEFAULT 'running',
    broker_count INTEGER NOT NULL DEFAULT 0,
    match_count INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS breach_scan_runs (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    mode TEXT NOT NULL DEFAULT 'demo',
    identifier_count INTEGER NOT NULL DEFAULT 0,
    finding_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS breach_findings (
    id TEXT PRIMARY KEY,
    scan_run_id TEXT NOT NULL REFERENCES breach_scan_runs(id),
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    identifier_type TEXT NOT NULL,
    identifier_redacted TEXT NOT NULL,
    breach_name TEXT NOT NULL,
    breach_title TEXT NOT NULL,
    breach_date TEXT,
    domain TEXT,
    data_classes_json TEXT NOT NULL DEFAULT '[]',
    pwn_count INTEGER,
    is_sensitive INTEGER NOT NULL DEFAULT 0,
    candidate_id TEXT REFERENCES exposure_candidates(id),
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS broker_sweep_matches (
    id TEXT PRIMARY KEY,
    sweep_run_id TEXT NOT NULL REFERENCES broker_sweep_runs(id),
    broker_id TEXT NOT NULL,
    broker_name TEXT NOT NULL,
    domain TEXT NOT NULL,
    match_reason TEXT NOT NULL,
    match_confidence REAL NOT NULL,
    opt_out_url TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS family_members (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    display_name TEXT NOT NULL,
    relationship TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS opt_out_dispatches (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    broker_id TEXT,
    broker_name TEXT NOT NULL,
    opt_out_url TEXT,
    exposure_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending_approval',
    instructions_json TEXT NOT NULL DEFAULT '{}',
    approved_at TEXT,
    submitted_at TEXT,
    completed_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS deindex_requests (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    exposure_id TEXT REFERENCES verified_exposures(id),
    source_url TEXT NOT NULL,
    search_engine TEXT NOT NULL,
    tool_url TEXT NOT NULL,
    draft_subject TEXT NOT NULL,
    draft_body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    submitted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

/** Only "column already exists" is expected on an up-to-date DB; anything else is a real failure. */
export function isIgnorableMigrationError(err: unknown): boolean {
  return err instanceof Error && /duplicate column/i.test(err.message);
}

function migrateColumns(conn: Conn) {
  const migrations = [
    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'",
    "ALTER TABLE organizations ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 365",
    "ALTER TABLE organizations ADD COLUMN rate_limit_per_hour INTEGER NOT NULL DEFAULT 100",
    "ALTER TABLE verified_exposures ADD COLUMN exposure_categories TEXT",
    "ALTER TABLE verified_exposures ADD COLUMN source_class TEXT",
    "ALTER TABLE verified_exposures ADD COLUMN risk_level TEXT",
    "ALTER TABLE verified_exposures ADD COLUMN recommended_remedy_family TEXT",
    "ALTER TABLE verified_exposures ADD COLUMN information_summary TEXT",
    "ALTER TABLE message_drafts ADD COLUMN template_id TEXT",
    "ALTER TABLE message_drafts ADD COLUMN template_label TEXT",
    "ALTER TABLE message_drafts ADD COLUMN remedy_type TEXT",
    "ALTER TABLE message_drafts ADD COLUMN review_items_json TEXT",
    "ALTER TABLE organizations ADD COLUMN agent_defaults_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE organizations ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'",
    "ALTER TABLE organizations ADD COLUMN stripe_customer_id TEXT",
    "ALTER TABLE organizations ADD COLUMN stripe_subscription_id TEXT",
    "ALTER TABLE organizations ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'none'",
    "ALTER TABLE organizations ADD COLUMN subscription_current_period_end TEXT",
    "ALTER TABLE organizations ADD COLUMN sla_tier TEXT NOT NULL DEFAULT 'standard'",
    "ALTER TABLE organizations ADD COLUMN sla_response_days INTEGER NOT NULL DEFAULT 14",
    "ALTER TABLE organizations ADD COLUMN sla_removal_days INTEGER NOT NULL DEFAULT 45",
    "ALTER TABLE organizations ADD COLUMN sla_follow_up_days INTEGER NOT NULL DEFAULT 14",
    "ALTER TABLE privacy_cases ADD COLUMN ruthless_mode INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE privacy_cases ADD COLUMN family_member_id TEXT REFERENCES family_members(id)",
    "ALTER TABLE deindex_requests ADD COLUMN resolved_at TEXT",
    "ALTER TABLE deindex_requests ADD COLUMN notes TEXT",
    "ALTER TABLE organizations ADD COLUMN last_digest_sent_at TEXT",
    "ALTER TABLE audit_events ADD COLUMN chain_key TEXT",
    "ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE privacy_cases ADD COLUMN status_before_pause TEXT",
  ];
  for (const sql of migrations) {
    try {
      conn.exec(sql);
    } catch (err) {
      if (isIgnorableMigrationError(err)) continue;
      throw err;
    }
  }
}

/**
 * Secondary indexes. Every FK column that erasure (lifecycle.deleteCaseData) and the
 * dashboards filter on is indexed, plus the hot audit / monitoring / rate-limit lookups.
 */
export const VERIFIED_EXPOSURE_URL_INDEX = "idx_verified_exposures_case_url";

export const INDEXES = [
  // audit log: per-case and per-org timelines, hash-chain tail lookup
  "CREATE INDEX IF NOT EXISTS idx_audit_events_case_created ON audit_events(case_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_audit_events_org_created ON audit_events(organization_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_audit_events_chain_key ON audit_events(chain_key)",
  // case_id FKs
  "CREATE INDEX IF NOT EXISTS idx_authorization_records_case ON authorization_records(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_identity_profiles_case ON identity_profiles(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_identity_claims_case ON identity_claims(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_identity_claims_profile ON identity_claims(profile_id)",
  "CREATE INDEX IF NOT EXISTS idx_scan_runs_case ON scan_runs(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_search_queries_case ON search_queries(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_search_queries_scan_run ON search_queries(scan_run_id)",
  "CREATE INDEX IF NOT EXISTS idx_exposure_candidates_case ON exposure_candidates(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_exposure_candidates_scan_run ON exposure_candidates(scan_run_id)",
  "CREATE INDEX IF NOT EXISTS idx_verified_exposures_case ON verified_exposures(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_verified_exposures_candidate ON verified_exposures(candidate_id)",
  "CREATE INDEX IF NOT EXISTS idx_content_evidence_case ON content_evidence(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_controller_targets_case ON controller_targets(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_controller_targets_exposure ON controller_targets(exposure_id)",
  "CREATE INDEX IF NOT EXISTS idx_remedy_routes_case ON remedy_routes(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_remedy_routes_exposure ON remedy_routes(exposure_id)",
  "CREATE INDEX IF NOT EXISTS idx_remediation_cases_case ON remediation_cases(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_remediation_cases_exposure ON remediation_cases(exposure_id)",
  "CREATE INDEX IF NOT EXISTS idx_message_drafts_case ON message_drafts(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_message_drafts_remediation_case ON message_drafts(remediation_case_id)",
  "CREATE INDEX IF NOT EXISTS idx_message_versions_draft ON message_versions(draft_id)",
  "CREATE INDEX IF NOT EXISTS idx_outbound_messages_case ON outbound_messages(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_outbound_messages_draft ON outbound_messages(draft_id)",
  "CREATE INDEX IF NOT EXISTS idx_verification_checks_case ON verification_checks(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_verification_checks_exposure ON verification_checks(exposure_id)",
  "CREATE INDEX IF NOT EXISTS idx_monitoring_rules_case ON monitoring_rules(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_monitoring_rules_enabled_next ON monitoring_rules(enabled, next_check_at)",
  "CREATE INDEX IF NOT EXISTS idx_follow_up_rules_remediation_case ON follow_up_rules(remediation_case_id)",
  "CREATE INDEX IF NOT EXISTS idx_agent_runs_case ON agent_runs(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_agent_tasks_run ON agent_tasks(run_id)",
  "CREATE INDEX IF NOT EXISTS idx_remediation_batches_case ON remediation_batches(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_remediation_batch_items_batch ON remediation_batch_items(batch_id)",
  "CREATE INDEX IF NOT EXISTS idx_sla_deadlines_case ON sla_deadlines(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_sla_deadlines_remediation_case ON sla_deadlines(remediation_case_id)",
  "CREATE INDEX IF NOT EXISTS idx_sla_deadlines_org_status ON sla_deadlines(organization_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_broker_sweep_runs_case ON broker_sweep_runs(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_broker_sweep_matches_run ON broker_sweep_matches(sweep_run_id)",
  "CREATE INDEX IF NOT EXISTS idx_breach_scan_runs_case ON breach_scan_runs(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_breach_findings_case ON breach_findings(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_breach_findings_scan_run ON breach_findings(scan_run_id)",
  "CREATE INDEX IF NOT EXISTS idx_opt_out_dispatches_case ON opt_out_dispatches(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_deindex_requests_case ON deindex_requests(case_id)",
  // tenancy / misc
  "CREATE INDEX IF NOT EXISTS idx_privacy_cases_owner ON privacy_cases(owner_user_id)",
  "CREATE INDEX IF NOT EXISTS idx_privacy_cases_org_status ON privacy_cases(organization_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_privacy_cases_family_member ON privacy_cases(family_member_id)",
  "CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(organization_id)",
  "CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_rate_limit_events_key_created ON rate_limit_events(key, created_at)",
  // worker prune: DELETE FROM rate_limit_events WHERE created_at < ?
  "CREATE INDEX IF NOT EXISTS idx_rate_limit_events_created ON rate_limit_events(created_at)",
  // Bearer auth: api_keys lookup by key_hash (also guarantees one row per key)
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash)",
  // One exposure per URL per case. dedupeVerifiedExposures() must run before this.
  `CREATE UNIQUE INDEX IF NOT EXISTS ${VERIFIED_EXPOSURE_URL_INDEX} ON verified_exposures(case_id, canonical_url)`,
  "CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id)",
];

function createIndexes(conn: Conn) {
  for (const statement of INDEXES) {
    conn.exec(statement);
  }
}

/** Every (table, column) with a foreign key to verified_exposures(id), read from the live schema. */
export function exposureForeignKeys(conn: Conn): Array<{ table: string; column: string }> {
  const tables = (
    conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((r) => r.name);
  const refs: Array<{ table: string; column: string }> = [];
  for (const table of tables) {
    const fks = conn
      .prepare(`SELECT "table" AS parent, "from" AS col, "to" AS target FROM pragma_foreign_key_list(?)`)
      .all(table) as { parent: string; col: string; target: string | null }[];
    for (const fk of fks) {
      if (fk.parent === "verified_exposures" && (fk.target === null || fk.target === "id")) {
        refs.push({ table, column: fk.col });
      }
    }
  }
  return refs;
}

/** Open-ness rank for merging duplicate exposures: higher = more clearly still public. */
const OPEN_STATUS_RANK: Record<string, number> = {
  reappearance: 4,
  still_exposed: 3,
  confirmed_exposure: 2,
};

interface ExposureMember {
  id: string;
  status: string;
  confirmedAt: string;
}

/**
 * Status the surviving row of a duplicate group must carry (pure; exported for tests).
 * Newest evidence about the URL wins: a removal is kept only when the newest conclusive live
 * check across the group says removed and no member was confirmed (seen live) after it.
 * Otherwise the most open non-removed status wins — and when another member had been removed,
 * the page came back, so it is a reappearance. A page that is live again is never reported
 * as removed, and a later removal is never lost.
 */
export function mergedExposureStatus(
  members: ReadonlyArray<ExposureMember>,
  latestConclusiveCheck: { status: string; checkedAt: string } | null,
): string {
  const relevant = members.filter((m) => !EXCLUDED_EXPOSURE_STATUSES.has(m.status));
  if (relevant.length === 0) return members[0]?.status ?? "confirmed_exposure";

  const latestConfirmation = relevant.reduce(
    (max, m) => (m.confirmedAt > max ? m.confirmedAt : max),
    "",
  );
  const newestSaysRemoved =
    latestConclusiveCheck !== null &&
    latestConclusiveCheck.status === "removed_confirmed" &&
    latestConclusiveCheck.checkedAt >= latestConfirmation;
  if (newestSaysRemoved) return "removed_confirmed";

  const open = relevant.filter((m) => m.status !== "removed_confirmed");
  if (open.length === 0) {
    // Every member says removed: only a newer live sighting overrides that.
    return latestConclusiveCheck && latestConclusiveCheck.status !== "removed_confirmed"
      ? "reappearance"
      : "removed_confirmed";
  }
  const best = open.reduce((top, m) =>
    (OPEN_STATUS_RANK[m.status] ?? 1) > (OPEN_STATUS_RANK[top.status] ?? 1) ? m : top,
  ).status;
  // Removed earlier, then confirmed (seen live) again: the page came back.
  const wasRemoved = relevant.length > open.length;
  return wasRemoved ? "reappearance" : best;
}

/**
 * After a keeper absorbed its duplicates' children it can hold several remediations to the
 * same controller (same contact method + value). Keep one per controller — the one with the
 * most recent outbound message, else the oldest — and move the others' drafts, follow-up
 * rules and SLA deadlines onto it, so follow-ups are never drafted twice to one broker.
 * Duplicate controller targets and remedy routes left without a remediation are removed.
 */
function mergeKeeperRemediations(conn: Conn, keeper: string): number {
  const rows = conn
    .prepare(
      `SELECT rc.id AS id, rc.remedy_route_id AS routeId, rr.controller_target_id AS targetId,
              lower(ct.contact_method) || '|' || lower(trim(ct.contact_value)) AS controllerKey,
              rc.message_count AS messageCount, rc.follow_up_count AS followUpCount,
              rc.do_not_contact AS doNotContact,
              (SELECT MAX(om.sent_at) FROM outbound_messages om
                 JOIN message_drafts md ON md.id = om.draft_id
                WHERE md.remediation_case_id = rc.id) AS lastSentAt
         FROM remediation_cases rc
         JOIN remedy_routes rr ON rr.id = rc.remedy_route_id
         JOIN controller_targets ct ON ct.id = rr.controller_target_id
        WHERE rc.exposure_id = ?
        ORDER BY rc.created_at ASC, rc.rowid ASC`,
    )
    .all(keeper) as Array<{
    id: string;
    routeId: string;
    targetId: string;
    controllerKey: string;
    messageCount: number;
    followUpCount: number;
    doNotContact: number;
    lastSentAt: string | null;
  }>;

  const byController = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byController.get(row.controllerKey) ?? [];
    list.push(row);
    byController.set(row.controllerKey, list);
  }

  const moveDrafts = conn.prepare("UPDATE message_drafts SET remediation_case_id = ? WHERE remediation_case_id = ?");
  const moveRules = conn.prepare("UPDATE follow_up_rules SET remediation_case_id = ? WHERE remediation_case_id = ?");
  const moveSla = conn.prepare("UPDATE sla_deadlines SET remediation_case_id = ? WHERE remediation_case_id = ?");
  const dropRemediation = conn.prepare("DELETE FROM remediation_cases WHERE id = ?");
  const dropRouteIfUnused = conn.prepare(
    "DELETE FROM remedy_routes WHERE id = ? AND NOT EXISTS (SELECT 1 FROM remediation_cases WHERE remedy_route_id = ?)",
  );
  const dropTargetIfUnused = conn.prepare(
    "DELETE FROM controller_targets WHERE id = ? AND NOT EXISTS (SELECT 1 FROM remedy_routes WHERE controller_target_id = ?)",
  );
  const updateKept = conn.prepare(
    "UPDATE remediation_cases SET message_count = ?, follow_up_count = ?, do_not_contact = ? WHERE id = ?",
  );
  const dedupeFollowUpRules = conn.prepare(
    `DELETE FROM follow_up_rules WHERE remediation_case_id = ?
       AND rowid NOT IN (SELECT MIN(rowid) FROM follow_up_rules WHERE remediation_case_id = ?)`,
  );

  let merged = 0;
  for (const group of byController.values()) {
    if (group.length < 2) continue;
    const kept = group.reduce((best, r) =>
      (r.lastSentAt ?? "") > (best.lastSentAt ?? "") ? r : best,
    );
    for (const other of group) {
      if (other.id === kept.id) continue;
      moveDrafts.run(kept.id, other.id);
      moveRules.run(kept.id, other.id);
      moveSla.run(kept.id, other.id);
      dropRemediation.run(other.id);
      dropRouteIfUnused.run(other.routeId, other.routeId);
      if (other.targetId !== kept.targetId) dropTargetIfUnused.run(other.targetId, other.targetId);
      merged++;
    }
    updateKept.run(
      group.reduce((n, r) => n + (r.messageCount ?? 0), 0),
      Math.max(...group.map((r) => r.followUpCount ?? 0)),
      group.some((r) => r.doNotContact) ? 1 : 0,
      kept.id,
    );
    dedupeFollowUpRules.run(kept.id, kept.id);
  }
  return merged;
}

/** Re-derive one case's status from its exposures (sync; migration-time recomputeCaseStatus). */
function recomputeCaseStatusSync(conn: Conn, caseId: string): void {
  const row = conn.prepare("SELECT status FROM privacy_cases WHERE id = ?").get(caseId) as
    | { status: string }
    | undefined;
  if (!row) return;
  const statuses = (
    conn.prepare("SELECT status FROM verified_exposures WHERE case_id = ?").all(caseId) as { status: string }[]
  ).map((r) => r.status);
  const next = deriveCaseStatusFromExposures(statuses, row.status);
  if (next !== row.status) {
    conn
      .prepare("UPDATE privacy_cases SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(next, new Date().toISOString(), caseId, row.status);
  }
}

/**
 * Collapses verified_exposures rows that share (case_id, canonical_url) so the unique index
 * can be created. For each group the oldest row is kept and every child row (any FK to
 * verified_exposures.id) is repointed to it; the keeper's status is merged from the whole
 * group's evidence (see mergedExposureStatus); duplicate remediations to one controller are
 * merged; the duplicates are deleted and each affected case's status is re-derived — all in
 * one transaction. A keeper ends up with at most one monitoring rule.
 *
 * Idempotent: once the unique index exists there can be no duplicates, so it returns at once.
 */
export function dedupeVerifiedExposures(conn: Conn): { groups: number; removed: number } {
  const indexed = conn
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(VERIFIED_EXPOSURE_URL_INDEX);
  if (indexed) return { groups: 0, removed: 0 };

  const run = conn.transaction(() => {
    const groups = conn
      .prepare(
        `SELECT case_id AS caseId, canonical_url AS url FROM verified_exposures
          GROUP BY case_id, canonical_url HAVING COUNT(*) > 1`,
      )
      .all() as { caseId: string; url: string }[];
    if (groups.length === 0) return { groups: 0, removed: 0 };

    const members = conn.prepare(
      `SELECT id, status, confirmed_at AS confirmedAt FROM verified_exposures
        WHERE case_id = ? AND canonical_url = ?
        ORDER BY created_at ASC, confirmed_at ASC, rowid ASC`,
    );
    // Newest conclusive live check across the group (simulated / inconclusive never count).
    const latestCheck = conn.prepare(
      `SELECT vc.status AS status, vc.checked_at AS checkedAt FROM verification_checks vc
         JOIN verified_exposures ve ON ve.id = vc.exposure_id
        WHERE ve.case_id = ? AND ve.canonical_url = ?
          AND vc.status IN ('removed_confirmed', 'still_exposed', 'reappearance_detected')
          AND vc.search_status IN ('source_not_visible', 'source_still_visible')
        ORDER BY vc.checked_at DESC, vc.created_at DESC LIMIT 1`,
    );
    const repoints = exposureForeignKeys(conn).map((fk) =>
      conn.prepare(`UPDATE "${fk.table}" SET "${fk.column}" = ? WHERE "${fk.column}" = ?`),
    );
    const setStatus = conn.prepare("UPDATE verified_exposures SET status = ? WHERE id = ?");
    const remove = conn.prepare("DELETE FROM verified_exposures WHERE id = ?");
    const dedupeRules = conn.prepare(
      `DELETE FROM monitoring_rules WHERE exposure_id = ?
         AND rowid NOT IN (SELECT MIN(rowid) FROM monitoring_rules WHERE exposure_id = ?)`,
    );

    let removed = 0;
    const affectedCases = new Set<string>();
    for (const group of groups) {
      const rows = members.all(group.caseId, group.url) as ExposureMember[];
      const check = (latestCheck.get(group.caseId, group.url) as
        | { status: string; checkedAt: string }
        | undefined) ?? null;
      const status = mergedExposureStatus(rows, check);
      const [keeper, ...duplicates] = rows.map((r) => r.id);
      for (const duplicate of duplicates) {
        for (const stmt of repoints) stmt.run(keeper, duplicate);
        remove.run(duplicate);
        removed++;
      }
      setStatus.run(status, keeper);
      dedupeRules.run(keeper, keeper);
      mergeKeeperRemediations(conn, keeper);
      affectedCases.add(group.caseId);
    }
    for (const caseId of affectedCases) recomputeCaseStatusSync(conn, caseId);
    return { groups: groups.length, removed };
  });
  return conn.inTransaction ? run() : run.immediate();
}

/** Creates/migrates the whole schema on `conn`. Safe to run repeatedly on an existing DB. */
export function initializeSchema(conn: Conn = sqlite): void {
  for (const statement of TABLES) {
    conn.exec(statement);
  }
  migrateColumns(conn);
  dedupeVerifiedExposures(conn);
  createIndexes(conn);
}

let initialized = false;

export function ensureDatabase(): void {
  if (initialized) return;
  initializeSchema(sqlite);
  initialized = true;
}