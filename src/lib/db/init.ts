import { sqlite } from "./index";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
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
];

function migrateColumns() {
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
  ];
  for (const sql of migrations) {
    try {
      sqlite.exec(sql);
    } catch {
      // column already exists
    }
  }
}

let initialized = false;

export function ensureDatabase(): void {
  if (initialized) return;
  for (const statement of TABLES) {
    sqlite.exec(statement);
  }
  migrateColumns();
  initialized = true;
}