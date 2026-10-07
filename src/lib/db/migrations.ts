/**
 * Versioned schema migrations (PRAGMA user_version).
 *
 * MIGRATIONS is an ordered list of { version, name, up(conn) }. runMigrations() applies every
 * migration newer than the database's user_version, each inside its own BEGIN IMMEDIATE
 * transaction that also bumps user_version, so a migration that throws leaves the database at
 * the previous version. Before upgrading a database that already holds tables it writes a
 * VACUUM INTO snapshot to <dirname(DATABASE_URL)>/backups/pre-migrate-v<from>-<ts>.db, encrypted
 * to .db.enc when BACKUP_PASSPHRASE is set and pruned after BACKUP_SNAPSHOT_RETENTION_DAYS (see
 * ./snapshots.ts; rollback = that snapshot + the previous image; docs/self-hosting/upgrade.md).
 *
 * Adding a migration: append { version: N + 1, ... }, add the matching drizzle columns in
 * schema.ts (the drift test in migrations.test.ts compares the two), and bump
 * package.json "cleartrace.schemaVersion" (scripts/restore.mjs reads it).
 */
import fs from "fs";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { sqlite } from "./index";
import { log } from "@/lib/log";
import { encryptFileSync } from "./snapshots";
import brokerIdAliases from "@/lib/brokers/data/id-aliases.json";
import {
  EXCLUDED_EXPOSURE_STATUSES,
  deriveCaseStatusFromExposures,
} from "@/lib/cases/derive-status";

type Conn = BetterSqlite3.Database;

/* ==========================================================================================
 * v1 — baseline (the v1.3.0 schema)
 *
 * Frozen: never edit these statements to add new columns or tables. Every later change is a
 * new numbered migration below. v1 is idempotent so a pre-1.4 database (user_version 0, tables
 * already present, possibly missing columns from older releases) runs it as a no-op upgrade.
 * ======================================================================================== */

/** v1.3.0 tables. Frozen — see the note above. */
export const V1_TABLES: readonly string[] = [
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

function migrateV1Columns(conn: Conn) {
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

/** v1 secondary indexes (frozen). Indexes added later live in their own migration. */
export const V1_INDEXES: readonly string[] = [
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

function createV1Indexes(conn: Conn) {
  for (const statement of V1_INDEXES) {
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

/** Applies the v1 (v1.3.0) baseline. Idempotent on any pre-1.4 database. */
export function applyBaselineSchema(conn: Conn): void {
  for (const statement of V1_TABLES) {
    conn.exec(statement);
  }
  migrateV1Columns(conn);
  dedupeVerifiedExposures(conn);
  createV1Indexes(conn);
}

/* ==========================================================================================
 * v2 — ongoing protection & broker coverage (v1.4.0)
 * ======================================================================================== */

function hasColumn(conn: Conn, table: string, column: string): boolean {
  return (conn.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).some(
    (c) => c.name === column,
  );
}

/** ALTER TABLE ... ADD COLUMN unless the column is already there (keeps every step re-runnable). */
function addColumn(conn: Conn, table: string, column: string, definition: string): void {
  if (hasColumn(conn, table, column)) return;
  conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const V2_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS protection_schedules (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    kind TEXT NOT NULL,
    broker_id TEXT,
    dispatch_id TEXT REFERENCES opt_out_dispatches(id),
    cadence_days INTEGER NOT NULL,
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    last_outcome TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS statutory_filings (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES privacy_cases(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    mechanism TEXT NOT NULL,
    jurisdiction TEXT NOT NULL,
    filed_at TEXT NOT NULL,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS job_runs (
    id TEXT PRIMARY KEY,
    job TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    counts_json TEXT NOT NULL DEFAULT '{}',
    error_code TEXT
  )`,
];

/** [table, column, definition] added by v2. */
export const V2_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ["opt_out_dispatches", "next_due_at", "TEXT"],
  ["opt_out_dispatches", "resubmit_count", "INTEGER NOT NULL DEFAULT 0"],
  ["opt_out_dispatches", "last_seen_at", "TEXT"],
  ["opt_out_dispatches", "relisted_from_id", "TEXT"],
  ["broker_sweep_matches", "profile_urls_json", "TEXT"],
  ["broker_sweep_matches", "evidence_id", "TEXT"],
  ["broker_sweep_matches", "check_method", "TEXT"],
  ["broker_sweep_matches", "check_outcome", "TEXT"],
  ["broker_sweep_matches", "checked_at", "TEXT"],
  ["broker_sweep_matches", "checked_by", "TEXT"],
  ["privacy_cases", "jurisdiction_state", "TEXT"],
  ["privacy_cases", "jurisdiction_source", "TEXT"],
  ["scan_runs", "trigger", "TEXT NOT NULL DEFAULT 'manual'"],
  ["search_queries", "coverage_json", "TEXT"],
  ["exposure_candidates", "broker_id", "TEXT"],
  ["exposure_candidates", "capture_method", "TEXT"],
  ["verified_exposures", "broker_id", "TEXT"],
];

export const PROTECTION_SCHEDULE_UNIQUE_INDEX = "idx_protection_schedules_case_kind_broker";

export const V2_INDEXES: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_protection_schedules_enabled_next ON protection_schedules(enabled, next_run_at)",
  `CREATE UNIQUE INDEX IF NOT EXISTS ${PROTECTION_SCHEDULE_UNIQUE_INDEX} ON protection_schedules(case_id, kind, COALESCE(broker_id, ''))`,
  "CREATE INDEX IF NOT EXISTS idx_protection_schedules_org ON protection_schedules(organization_id)",
  "CREATE INDEX IF NOT EXISTS idx_protection_schedules_dispatch ON protection_schedules(dispatch_id)",
  "CREATE INDEX IF NOT EXISTS idx_opt_out_dispatches_case_broker_created ON opt_out_dispatches(case_id, broker_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_statutory_filings_case ON statutory_filings(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_job_runs_job_started ON job_runs(job, started_at)",
];

export const V2_DUPLICATE_OPT_OUT_NOTE = "auto: duplicate broker_opt_out (v2 migration)";

/**
 * v2 data step: older releases inserted a new pending broker_opt_out SLA row on every call.
 * Per case, keep the earliest pending one (created_at, then due_at, then rowid) and mark the
 * rest 'superseded'. Returns the number of rows superseded.
 */
export function supersedeDuplicateBrokerOptOutDeadlines(conn: Conn, now = new Date().toISOString()): number {
  return conn
    .prepare(
      `UPDATE sla_deadlines
          SET status = 'superseded', notes = @note, updated_at = @now
        WHERE deadline_type = 'broker_opt_out'
          AND status = 'pending'
          AND rowid NOT IN (
            SELECT (SELECT s2.rowid FROM sla_deadlines s2
                     WHERE s2.case_id = s1.case_id
                       AND s2.deadline_type = 'broker_opt_out' AND s2.status = 'pending'
                     ORDER BY s2.created_at ASC, s2.due_at ASC, s2.rowid ASC LIMIT 1)
              FROM sla_deadlines s1
             WHERE s1.deadline_type = 'broker_opt_out' AND s1.status = 'pending'
             GROUP BY s1.case_id
          )`,
    )
    .run({ note: V2_DUPLICATE_OPT_OUT_NOTE, now }).changes;
}

function migrateV2(conn: Conn): void {
  for (const statement of V2_TABLES) conn.exec(statement);
  for (const [table, column, definition] of V2_COLUMNS) addColumn(conn, table, column, definition);
  for (const statement of V2_INDEXES) conn.exec(statement);
  supersedeDuplicateBrokerOptOutDeadlines(conn);
}

/** v3 (Sprint 5): latest-check-per-exposure lookups (relist, follow-up, certificate). */
export const V3_INDEXES: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_verification_checks_exposure_checked ON verification_checks(exposure_id, checked_at)",
];

function migrateV3(conn: Conn): void {
  for (const statement of V3_INDEXES) conn.exec(statement);
}

/**
 * v4 (v1.6.0): the dashboard's owner + org case list, newest first, without a sort step; and
 * `remediation_batch_items.claimed_at`, so a step left `running` by a crashed process can be
 * recovered.
 */
export const V4_INDEXES: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_privacy_cases_owner_org_updated ON privacy_cases(owner_user_id, organization_id, updated_at)",
];

function migrateV4(conn: Conn): void {
  addColumn(conn, "remediation_batch_items", "claimed_at", "TEXT");
  for (const statement of V4_INDEXES) conn.exec(statement);
}

/* ==========================================================================================
 * v5 (v1.7.0) — rewrite stored legacy broker ids
 * ======================================================================================== */

/** Old broker id → current id (src/lib/brokers/data/id-aliases.json). */
export const LEGACY_BROKER_ID_ALIASES: Readonly<Record<string, string>> = brokerIdAliases as Record<string, string>;

export interface CanonicalizeBrokerIdsResult {
  /** Rows whose broker_id was rewritten in place. */
  rewritten: number;
  /** Alias rows merged into a row that already had the current id (and deleted). */
  merged: number;
}

function newestOf(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

function parseJsonList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * v5 data step: rewrite every stored legacy (renamed) broker id to its current id, in every
 * table that carries one — exposure_candidates, verified_exposures, opt_out_dispatches,
 * broker_sweep_matches, protection_schedules — and in search_queries.coverage_json.
 *
 * Collisions (an alias row next to a row that already has the current id):
 * - broker_sweep_matches, same sweep run: one row is kept — the one with the newest check
 *   (then the newest row) — under the current id; profile URLs are unioned and a missing
 *   evidence id is taken from the other row; the other row is deleted.
 * - protection_schedules, same (case, kind): the unique index allows one. The current-id row
 *   is kept and takes the alias row's dispatch / cadence / next run when the alias row is the
 *   newer one (newer dispatch, else newer updated_at) — the same rule as the per-tick
 *   canonicalizeStoredBrokerIds() in protection/schedules.ts; last_run_at keeps the newest.
 *
 * Idempotent (a second run finds no legacy ids). Runs inside the migration's transaction.
 */
export function canonicalizeLegacyBrokerIds(
  conn: Conn,
  aliases: Readonly<Record<string, string>> = LEGACY_BROKER_ID_ALIASES,
): CanonicalizeBrokerIdsResult {
  const result: CanonicalizeBrokerIdsResult = { rewritten: 0, merged: 0 };
  const pairs = Object.entries(aliases).filter(([from, to]) => from && to && from !== to);
  if (pairs.length === 0) return result;

  for (const [legacy, current] of pairs) {
    // Tables with no uniqueness on broker_id: a plain rewrite.
    for (const table of ["exposure_candidates", "verified_exposures", "opt_out_dispatches"]) {
      result.rewritten += conn
        .prepare(`UPDATE "${table}" SET broker_id = ? WHERE broker_id = ?`)
        .run(current, legacy).changes;
    }

    // broker_sweep_matches: at most one row per broker per sweep run.
    type MatchRow = {
      id: string;
      sweepRunId: string;
      checkedAt: string | null;
      createdAt: string | null;
      profileUrlsJson: string | null;
      evidenceId: string | null;
      rid: number;
    };
    const matchCols = `id, sweep_run_id AS sweepRunId, checked_at AS checkedAt, created_at AS createdAt,
      profile_urls_json AS profileUrlsJson, evidence_id AS evidenceId, rowid AS rid`;
    const legacyMatches = conn
      .prepare(`SELECT ${matchCols} FROM broker_sweep_matches WHERE broker_id = ?`)
      .all(legacy) as MatchRow[];
    const twinMatch = conn.prepare(
      `SELECT ${matchCols} FROM broker_sweep_matches WHERE sweep_run_id = ? AND broker_id = ? LIMIT 1`,
    );
    const rank = (m: MatchRow) => [m.checkedAt ? 1 : 0, m.checkedAt ?? "", m.createdAt ?? "", m.rid] as const;
    const newer = (a: MatchRow, b: MatchRow) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i];
      return false;
    };
    for (const m of legacyMatches) {
      const twin = twinMatch.get(m.sweepRunId, current) as MatchRow | undefined;
      if (!twin) {
        conn.prepare("UPDATE broker_sweep_matches SET broker_id = ? WHERE id = ?").run(current, m.id);
        result.rewritten++;
        continue;
      }
      const [keep, drop] = newer(m, twin) ? [m, twin] : [twin, m];
      const urls = [...new Set([...parseJsonList(keep.profileUrlsJson), ...parseJsonList(drop.profileUrlsJson)])];
      conn.prepare("DELETE FROM broker_sweep_matches WHERE id = ?").run(drop.id);
      conn
        .prepare(
          `UPDATE broker_sweep_matches
              SET broker_id = ?, profile_urls_json = ?, evidence_id = COALESCE(evidence_id, ?)
            WHERE id = ?`,
        )
        .run(current, urls.length ? JSON.stringify(urls) : keep.profileUrlsJson, drop.evidenceId, keep.id);
      result.merged++;
    }

    // protection_schedules: unique per (case, kind, broker).
    type ScheduleRow = {
      id: string;
      caseId: string;
      kind: string;
      dispatchId: string | null;
      dispatchAt: string | null;
      updatedAt: string | null;
      lastRunAt: string | null;
      cadenceDays: number;
      nextRunAt: string;
    };
    const scheduleCols = `ps.id, ps.case_id AS caseId, ps.kind, ps.dispatch_id AS dispatchId,
      od.created_at AS dispatchAt, ps.updated_at AS updatedAt, ps.last_run_at AS lastRunAt,
      ps.cadence_days AS cadenceDays, ps.next_run_at AS nextRunAt`;
    const legacySchedules = conn
      .prepare(
        `SELECT ${scheduleCols} FROM protection_schedules ps
           LEFT JOIN opt_out_dispatches od ON od.id = ps.dispatch_id
          WHERE ps.broker_id = ?`,
      )
      .all(legacy) as ScheduleRow[];
    const twinSchedule = conn.prepare(
      `SELECT ${scheduleCols} FROM protection_schedules ps
         LEFT JOIN opt_out_dispatches od ON od.id = ps.dispatch_id
        WHERE ps.case_id = ? AND ps.kind = ? AND ps.broker_id = ? LIMIT 1`,
    );
    for (const sched of legacySchedules) {
      const twin = twinSchedule.get(sched.caseId, sched.kind, current) as ScheduleRow | undefined;
      if (!twin) {
        conn.prepare("UPDATE protection_schedules SET broker_id = ? WHERE id = ?").run(current, sched.id);
        result.rewritten++;
        continue;
      }
      const aliasIsNewer =
        sched.dispatchAt || twin.dispatchAt
          ? (sched.dispatchAt ?? "") > (twin.dispatchAt ?? "")
          : (sched.updatedAt ?? "") > (twin.updatedAt ?? "");
      conn.prepare("DELETE FROM protection_schedules WHERE id = ?").run(sched.id);
      if (aliasIsNewer) {
        conn
          .prepare(
            `UPDATE protection_schedules
                SET dispatch_id = ?, cadence_days = ?, next_run_at = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(sched.dispatchId, sched.cadenceDays, sched.nextRunAt, newestOf(sched.updatedAt, twin.updatedAt), twin.id);
      }
      conn
        .prepare("UPDATE protection_schedules SET last_run_at = ? WHERE id = ?")
        .run(newestOf(sched.lastRunAt, twin.lastRunAt), twin.id);
      result.merged++;
    }
  }

  // search_queries.coverage_json: {group, brokerIds[], skippedBrokerIds[]}.
  const legacyIds = pairs.map(([from]) => from);
  const like = legacyIds.map(() => "coverage_json LIKE ?").join(" OR ");
  const queries = conn
    .prepare(`SELECT id, coverage_json AS json FROM search_queries WHERE ${like}`)
    .all(...legacyIds.map((id) => `%"${id}"%`)) as { id: string; json: string }[];
  const map = new Map(pairs);
  for (const q of queries) {
    let coverage: Record<string, unknown>;
    try {
      coverage = JSON.parse(q.json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!coverage || typeof coverage !== "object") continue;
    let changed = false;
    for (const key of ["brokerIds", "skippedBrokerIds"]) {
      const list = coverage[key];
      if (!Array.isArray(list)) continue;
      const next = [...new Set(list.map((v) => (typeof v === "string" ? (map.get(v) ?? v) : v)))];
      if (next.length !== list.length || next.some((v, i) => v !== list[i])) {
        coverage[key] = next;
        changed = true;
      }
    }
    if (changed) {
      conn.prepare("UPDATE search_queries SET coverage_json = ? WHERE id = ?").run(JSON.stringify(coverage), q.id);
      result.rewritten++;
    }
  }
  return result;
}

function migrateV5(conn: Conn): void {
  const { rewritten, merged } = canonicalizeLegacyBrokerIds(conn);
  if (rewritten || merged) {
    log.info("db.migration.broker_ids", { migration: "v5_canonical_broker_ids", counts: { rewritten, merged } });
  }
}

/* ==========================================================================================
 * Runner
 * ======================================================================================== */

export interface Migration {
  version: number;
  name: string;
  up(conn: Conn): void;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "v1_baseline", up: applyBaselineSchema },
  { version: 2, name: "v2_ongoing_protection", up: migrateV2 },
  { version: 3, name: "v3_verification_checks_exposure_index", up: migrateV3 },
  { version: 4, name: "v4_privacy_cases_owner_org_updated_index", up: migrateV4 },
  { version: 5, name: "v5_canonical_broker_ids", up: migrateV5 },
];

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1].version;

export const NEWER_DATABASE_MESSAGE =
  "database is newer than this ClearTrace version — restore a backup or upgrade";

export function readUserVersion(conn: Conn): number {
  return Number(conn.pragma("user_version", { simple: true }) ?? 0);
}

/** user_version of the app database (0 for a database created before v1.4.0). */
export function getSchemaVersion(conn: Conn = sqlite): number {
  return readUserVersion(conn);
}

/** True when the database already holds application tables (i.e. it is not a fresh file). */
export function hasUserTables(conn: Conn): boolean {
  return !!conn
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
}

function timestampForFile(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** <dirname(dbFile)>/backups/pre-migrate-v<from>-<ts>.db */
export function preMigrateSnapshotPath(dbFile: string, fromVersion: number, now: Date = new Date()): string {
  return path.join(/*turbopackIgnore: true*/ path.dirname(dbFile), "backups", `pre-migrate-v${fromVersion}-${timestampForFile(now)}.db`);
}

function isFileBacked(conn: Conn): boolean {
  return !!conn.name && conn.name !== ":memory:" && !conn.memory;
}

/**
 * VACUUM INTO a consistent copy of the database before it is migrated. Owner-only perms.
 * With a passphrase the copy is encrypted (CTBK1, readable by scripts/restore.mjs) and the
 * plaintext copy removed, so erased cases do not linger readable in the snapshot.
 */
function writePreMigrateSnapshot(
  conn: Conn,
  fromVersion: number,
  now: Date,
  passphrase: string | undefined,
): string | null {
  if (!isFileBacked(conn)) return null;
  const target = preMigrateSnapshotPath(conn.name, fromVersion, now);
  // turbopackIgnore: runtime paths next to the live database; never traced into the build.
  fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(target), { recursive: true, mode: 0o700 });
  let file = target;
  for (let i = 1; fs.existsSync(/*turbopackIgnore: true*/ file); i++) file = target.replace(/\.db$/, `-${i}.db`);
  conn.prepare("VACUUM INTO ?").run(file);
  try {
    fs.chmodSync(/*turbopackIgnore: true*/ file, 0o600);
  } catch {
    // best effort (e.g. filesystems without POSIX modes)
  }
  if (!passphrase) {
    // The snapshot is a full plaintext copy of the database, kept for the retention window
    // (including cases erased after the upgrade). Say so loudly in production.
    if (process.env.NODE_ENV === "production") {
      log.warn("db.premigrate_snapshot_unencrypted", { errorCode: "BACKUP_PASSPHRASE_UNSET" });
    }
    return file;
  }
  const encrypted = `${file}.enc`;
  try {
    encryptFileSync(file, encrypted, passphrase);
  } finally {
    fs.rmSync(/*turbopackIgnore: true*/ file, { force: true });
  }
  return encrypted;
}

export interface RunMigrationsOptions {
  /** Write the pre-migrate snapshot. Default: on unless CLEARTRACE_SKIP_PREMIGRATE_SNAPSHOT=1. */
  snapshot?: boolean;
  /** Stop after this version (tests seed older shapes). Default: the latest. */
  target?: number;
  /** Override the migration list (tests). */
  migrations?: readonly Migration[];
  now?: () => Date;
  /** Encrypts the snapshot. Default: BACKUP_PASSPHRASE (plaintext .db when unset). */
  snapshotPassphrase?: string;
}

export interface RunMigrationsResult {
  from: number;
  to: number;
  applied: string[];
  snapshotPath: string | null;
}

/**
 * Brings `conn` up to the latest schema version. Throws NEWER_DATABASE_MESSAGE when the
 * database was written by a newer ClearTrace. Safe to call concurrently from several
 * processes: each migration re-checks user_version after taking the write lock.
 */
export function runMigrations(conn: Conn = sqlite, options: RunMigrationsOptions = {}): RunMigrationsResult {
  const migrations = options.migrations ?? MIGRATIONS;
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  const target = Math.min(options.target ?? latest, latest);
  const from = readUserVersion(conn);
  if (from > latest) throw new Error(NEWER_DATABASE_MESSAGE);

  const pending = migrations.filter((m) => m.version > from && m.version <= target);
  const result: RunMigrationsResult = { from, to: from, applied: [], snapshotPath: null };
  if (pending.length === 0) return result;

  const wantSnapshot = options.snapshot ?? process.env.CLEARTRACE_SKIP_PREMIGRATE_SNAPSHOT !== "1";
  if (wantSnapshot && hasUserTables(conn)) {
    result.snapshotPath = writePreMigrateSnapshot(
      conn,
      from,
      (options.now ?? (() => new Date()))(),
      options.snapshotPassphrase ?? (process.env.BACKUP_PASSPHRASE || undefined),
    );
  }

  for (const migration of pending) {
    const started = performance.now();
    conn.exec("BEGIN IMMEDIATE");
    try {
      const current = readUserVersion(conn);
      if (current > latest) throw new Error(NEWER_DATABASE_MESSAGE);
      if (current >= migration.version) {
        // Another process applied it while we waited for the lock.
        conn.exec("COMMIT");
        result.to = current;
        continue;
      }
      migration.up(conn);
      conn.pragma(`user_version = ${Math.trunc(migration.version)}`);
      conn.exec("COMMIT");
    } catch (err) {
      if (conn.inTransaction) conn.exec("ROLLBACK");
      throw err;
    }
    result.to = migration.version;
    result.applied.push(migration.name);
    log.info("db.migration", {
      migration: migration.name,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    });
  }
  return result;
}

/* ==========================================================================================
 * Drift check: drizzle schema.ts vs. the migrated database
 * ======================================================================================== */

export interface SchemaDrift {
  table: string;
  column: string;
  problem: "missing_table" | "missing_column" | "nullability";
}

/**
 * Compares every drizzle table's columns and NOT NULL flags with PRAGMA table_info. A schema.ts
 * column without a migration (or a migration without the drizzle column's nullability) is
 * reported. Primary keys are compared by presence only (SQLite reports TEXT PKs as nullable).
 */
export function findSchemaDrift(conn: Conn, tables: readonly SQLiteTable[]): SchemaDrift[] {
  const drift: SchemaDrift[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    const info = conn.prepare(`SELECT name, "notnull" AS nn, pk FROM pragma_table_info(?)`).all(config.name) as {
      name: string;
      nn: number;
      pk: number;
    }[];
    if (info.length === 0) {
      drift.push({ table: config.name, column: "*", problem: "missing_table" });
      continue;
    }
    const byName = new Map(info.map((c) => [c.name, c]));
    for (const column of config.columns) {
      const live = byName.get(column.name);
      if (!live) {
        drift.push({ table: config.name, column: column.name, problem: "missing_column" });
        continue;
      }
      if (column.primary || live.pk) continue;
      if (Boolean(live.nn) !== column.notNull) {
        drift.push({ table: config.name, column: column.name, problem: "nullability" });
      }
    }
  }
  return drift;
}
