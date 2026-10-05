-- Frozen v1.2.0-shaped ClearTrace database (PRAGMA user_version = 0).
-- Schema generated from git tag v1.2.0 (src/lib/db/init.ts TABLES + ALTERs + INDEXES).
-- Do not edit to match newer schemas: upgrade tests rely on this being the old shape.
-- v1.2 had no unique (case_id, canonical_url) index, so duplicate exposures are possible.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL DEFAULT 365,
  rate_limit_per_hour INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  , agent_defaults_json TEXT NOT NULL DEFAULT '{}', plan TEXT NOT NULL DEFAULT 'free', stripe_customer_id TEXT, stripe_subscription_id TEXT, subscription_status TEXT NOT NULL DEFAULT 'none', subscription_current_period_end TEXT, sla_tier TEXT NOT NULL DEFAULT 'standard', sla_response_days INTEGER NOT NULL DEFAULT 14, sla_removal_days INTEGER NOT NULL DEFAULT 45, sla_follow_up_days INTEGER NOT NULL DEFAULT 14, last_digest_sent_at TEXT);
CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE privacy_cases (
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
  , family_member_id TEXT REFERENCES family_members(id));
CREATE TABLE authorization_records (
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
  );
CREATE TABLE identity_profiles (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE identity_claims (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES identity_profiles(id),
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  claim_type TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  scan_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  status TEXT NOT NULL DEFAULT 'queued',
  mode TEXT NOT NULL DEFAULT 'demo',
  query_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE search_queries (
  id TEXT PRIMARY KEY,
  scan_run_id TEXT NOT NULL REFERENCES scan_runs(id),
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  query_text TEXT NOT NULL,
  source_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE exposure_candidates (
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
  );
CREATE TABLE verified_exposures (
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
  );
CREATE TABLE content_evidence (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  source_url TEXT NOT NULL,
  redacted_excerpt TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE controller_targets (
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
  );
CREATE TABLE remedy_routes (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  exposure_id TEXT NOT NULL REFERENCES verified_exposures(id),
  controller_target_id TEXT NOT NULL REFERENCES controller_targets(id),
  remedy_type TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  required_user_inputs TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE remediation_cases (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  exposure_id TEXT NOT NULL REFERENCES verified_exposures(id),
  remedy_route_id TEXT NOT NULL REFERENCES remedy_routes(id),
  status TEXT NOT NULL DEFAULT 'draft_ready',
  message_count INTEGER NOT NULL DEFAULT 0,
  follow_up_count INTEGER NOT NULL DEFAULT 0,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE message_drafts (
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
  );
CREATE TABLE message_versions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES message_drafts(id),
  version INTEGER NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  edited_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE outbound_messages (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  draft_id TEXT NOT NULL REFERENCES message_drafts(id),
  sent_via TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE verification_checks (
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
  );
CREATE TABLE monitoring_rules (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  exposure_id TEXT NOT NULL REFERENCES verified_exposures(id),
  schedule TEXT NOT NULL DEFAULT 'weekly',
  next_check_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE follow_up_rules (
  id TEXT PRIMARY KEY,
  remediation_case_id TEXT NOT NULL REFERENCES remediation_cases(id),
  max_follow_ups INTEGER NOT NULL DEFAULT 2,
  first_follow_up_days INTEGER NOT NULL DEFAULT 14,
  second_follow_up_days INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE agent_runs (
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
  );
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  task_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE audit_events (
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
  , chain_key TEXT);
CREATE TABLE security_scans (
  id TEXT PRIMARY KEY,
  scan_type TEXT NOT NULL,
  status TEXT NOT NULL,
  findings_json TEXT,
  run_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE rate_limit_events (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE remediation_batches (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  status TEXT NOT NULL DEFAULT 'queued',
  total_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
  );
CREATE TABLE remediation_batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES remediation_batches(id),
  exposure_id TEXT NOT NULL REFERENCES verified_exposures(id),
  step TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
  );
CREATE TABLE connector_configs (
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
  );
CREATE TABLE sla_deadlines (
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
  );
CREATE TABLE api_keys (
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
  );
CREATE TABLE enterprise_webhooks (
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
  );
CREATE TABLE webhook_deliveries (
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
  );
CREATE TABLE broker_sweep_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  status TEXT NOT NULL DEFAULT 'running',
  broker_count INTEGER NOT NULL DEFAULT 0,
  match_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
  );
CREATE TABLE breach_scan_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES privacy_cases(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  mode TEXT NOT NULL DEFAULT 'demo',
  identifier_count INTEGER NOT NULL DEFAULT 0,
  finding_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
  );
CREATE TABLE breach_findings (
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
  );
CREATE TABLE broker_sweep_matches (
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
  );
CREATE TABLE family_members (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  display_name TEXT NOT NULL,
  relationship TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE opt_out_dispatches (
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
  );
CREATE TABLE deindex_requests (
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
  , resolved_at TEXT, notes TEXT);
CREATE INDEX idx_audit_events_case_created ON audit_events(case_id, created_at);
CREATE INDEX idx_audit_events_org_created ON audit_events(organization_id, created_at);
CREATE INDEX idx_audit_events_chain_key ON audit_events(chain_key);
CREATE INDEX idx_authorization_records_case ON authorization_records(case_id);
CREATE INDEX idx_identity_profiles_case ON identity_profiles(case_id);
CREATE INDEX idx_identity_claims_case ON identity_claims(case_id);
CREATE INDEX idx_identity_claims_profile ON identity_claims(profile_id);
CREATE INDEX idx_scan_runs_case ON scan_runs(case_id);
CREATE INDEX idx_search_queries_case ON search_queries(case_id);
CREATE INDEX idx_search_queries_scan_run ON search_queries(scan_run_id);
CREATE INDEX idx_exposure_candidates_case ON exposure_candidates(case_id);
CREATE INDEX idx_exposure_candidates_scan_run ON exposure_candidates(scan_run_id);
CREATE INDEX idx_verified_exposures_case ON verified_exposures(case_id);
CREATE INDEX idx_verified_exposures_candidate ON verified_exposures(candidate_id);
CREATE INDEX idx_content_evidence_case ON content_evidence(case_id);
CREATE INDEX idx_controller_targets_case ON controller_targets(case_id);
CREATE INDEX idx_controller_targets_exposure ON controller_targets(exposure_id);
CREATE INDEX idx_remedy_routes_case ON remedy_routes(case_id);
CREATE INDEX idx_remedy_routes_exposure ON remedy_routes(exposure_id);
CREATE INDEX idx_remediation_cases_case ON remediation_cases(case_id);
CREATE INDEX idx_remediation_cases_exposure ON remediation_cases(exposure_id);
CREATE INDEX idx_message_drafts_case ON message_drafts(case_id);
CREATE INDEX idx_message_drafts_remediation_case ON message_drafts(remediation_case_id);
CREATE INDEX idx_message_versions_draft ON message_versions(draft_id);
CREATE INDEX idx_outbound_messages_case ON outbound_messages(case_id);
CREATE INDEX idx_outbound_messages_draft ON outbound_messages(draft_id);
CREATE INDEX idx_verification_checks_case ON verification_checks(case_id);
CREATE INDEX idx_verification_checks_exposure ON verification_checks(exposure_id);
CREATE INDEX idx_monitoring_rules_case ON monitoring_rules(case_id);
CREATE INDEX idx_monitoring_rules_enabled_next ON monitoring_rules(enabled, next_check_at);
CREATE INDEX idx_follow_up_rules_remediation_case ON follow_up_rules(remediation_case_id);
CREATE INDEX idx_agent_runs_case ON agent_runs(case_id);
CREATE INDEX idx_agent_tasks_run ON agent_tasks(run_id);
CREATE INDEX idx_remediation_batches_case ON remediation_batches(case_id);
CREATE INDEX idx_remediation_batch_items_batch ON remediation_batch_items(batch_id);
CREATE INDEX idx_sla_deadlines_case ON sla_deadlines(case_id);
CREATE INDEX idx_sla_deadlines_remediation_case ON sla_deadlines(remediation_case_id);
CREATE INDEX idx_sla_deadlines_org_status ON sla_deadlines(organization_id, status);
CREATE INDEX idx_broker_sweep_runs_case ON broker_sweep_runs(case_id);
CREATE INDEX idx_broker_sweep_matches_run ON broker_sweep_matches(sweep_run_id);
CREATE INDEX idx_breach_scan_runs_case ON breach_scan_runs(case_id);
CREATE INDEX idx_breach_findings_case ON breach_findings(case_id);
CREATE INDEX idx_breach_findings_scan_run ON breach_findings(scan_run_id);
CREATE INDEX idx_opt_out_dispatches_case ON opt_out_dispatches(case_id);
CREATE INDEX idx_deindex_requests_case ON deindex_requests(case_id);
CREATE INDEX idx_privacy_cases_owner ON privacy_cases(owner_user_id);
CREATE INDEX idx_privacy_cases_org_status ON privacy_cases(organization_id, status);
CREATE INDEX idx_privacy_cases_family_member ON privacy_cases(family_member_id);
CREATE INDEX idx_memberships_org ON memberships(organization_id);
CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_rate_limit_events_key_created ON rate_limit_events(key, created_at);
CREATE INDEX idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);


INSERT INTO users (id, email, name, password_hash, role) VALUES ('u1', 'owner@fixture.test', 'Fixture Owner', 'x', 'admin');
INSERT INTO organizations (id, name, slug) VALUES ('o1', 'Fixture Org', 'fixture-org');
INSERT INTO memberships (id, user_id, organization_id, role) VALUES ('m1', 'u1', 'o1', 'owner');
INSERT INTO privacy_cases (id, organization_id, owner_user_id, title, case_type, target_relationship, status)
  VALUES ('c1', 'o1', 'u1', 'Case one', 'people_search', 'self', 'remediation_in_progress'),
         ('c2', 'o1', 'u1', 'Case two', 'people_search', 'self', 'confirmed_exposure');
INSERT INTO identity_profiles (id, case_id, label) VALUES ('p1', 'c1', 'Primary');
INSERT INTO identity_claims (id, profile_id, case_id, claim_type, encrypted_value, value_hash)
  VALUES ('ic1', 'p1', 'c1', 'full_name', 'v2:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA', 'h');
INSERT INTO scan_runs (id, case_id, status, mode) VALUES ('s1', 'c1', 'completed', 'demo'), ('s2', 'c2', 'completed', 'demo');
INSERT INTO search_queries (id, scan_run_id, case_id, query_text, source_type) VALUES ('q1', 's1', 'c1', 'q', 'web');
INSERT INTO opt_out_dispatches (id, case_id, organization_id, broker_id, broker_name, status)
  VALUES ('od1', 'c1', 'o1', 'spokeo', 'Spokeo', 'submitted'), ('od2', 'c2', 'o1', 'whitepages', 'Whitepages', 'pending_approval');
INSERT INTO broker_sweep_runs (id, case_id, organization_id, status) VALUES ('bsr1', 'c1', 'o1', 'completed');
INSERT INTO broker_sweep_matches (id, sweep_run_id, broker_id, broker_name, domain, match_reason, match_confidence)
  VALUES ('bsm1', 'bsr1', 'spokeo', 'Spokeo', 'spokeo.com', 'seen', 0.9);
-- Duplicate pending broker_opt_out deadlines (createBrokerOptOutDeadline inserted one per call).
INSERT INTO sla_deadlines (id, organization_id, case_id, deadline_type, anchor_at, due_at, status, created_at) VALUES
  ('sla-c1-a', 'o1', 'c1', 'broker_opt_out', '2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z', 'pending', '2026-01-01T00:00:00.000Z'),
  ('sla-c1-b', 'o1', 'c1', 'broker_opt_out', '2026-02-01T00:00:00.000Z', '2026-03-03T00:00:00.000Z', 'pending', '2026-02-01T00:00:00.000Z'),
  ('sla-c1-c', 'o1', 'c1', 'broker_opt_out', '2026-03-01T00:00:00.000Z', '2026-03-31T00:00:00.000Z', 'pending', '2026-03-01T00:00:00.000Z'),
  ('sla-c1-met', 'o1', 'c1', 'broker_opt_out', '2025-12-01T00:00:00.000Z', '2025-12-31T00:00:00.000Z', 'met', '2025-12-01T00:00:00.000Z'),
  ('sla-c1-resp', 'o1', 'c1', 'response', '2026-01-01T00:00:00.000Z', '2026-01-15T00:00:00.000Z', 'pending', '2026-01-01T00:00:00.000Z'),
  ('sla-c2-a', 'o1', 'c2', 'broker_opt_out', '2026-02-01T00:00:00.000Z', '2026-03-03T00:00:00.000Z', 'pending', '2026-02-01T00:00:00.000Z');

INSERT INTO exposure_candidates (id, case_id, scan_run_id, canonical_url, source_type)
  VALUES ('k1', 'c1', 's1', 'https://people.example/jane', 'web'), ('k2', 'c1', 's1', 'https://people.example/jane', 'web'),
         ('k3', 'c2', 's2', 'https://people.example/jane', 'web');
INSERT INTO verified_exposures (id, case_id, candidate_id, canonical_url, exposure_class, status, confirmed_at, created_at) VALUES
  ('e1', 'c1', 'k1', 'https://people.example/jane', 'people_search', 'confirmed_exposure', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('e1-dup', 'c1', 'k2', 'https://people.example/jane', 'people_search', 'still_exposed', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
  ('e2', 'c2', 'k3', 'https://people.example/jane', 'people_search', 'confirmed_exposure', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO monitoring_rules (id, case_id, exposure_id, next_check_at) VALUES ('mr1', 'c1', 'e1-dup', '2026-04-01T00:00:00.000Z');
