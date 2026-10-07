-- Rows a v1.6.0 (schema v4) database can hold with legacy (renamed) broker ids, loaded on top
-- of a fresh v4 schema by migrations.test.ts. Aliases: spokeo2 -> peoplesearch123,
-- spokeo_alt -> unitedstatesphonebook (src/lib/brokers/data/id-aliases.json).
INSERT INTO users (id, email, name, password_hash, role) VALUES ('u1', 'owner@fixture.test', 'Fixture Owner', 'x', 'admin');
INSERT INTO organizations (id, name, slug) VALUES ('o1', 'Fixture Org', 'fixture-org');
INSERT INTO privacy_cases (id, organization_id, owner_user_id, title, case_type, target_relationship, status)
  VALUES ('c1', 'o1', 'u1', 'Case one', 'people_search', 'self', 'remediation_in_progress'),
         ('c2', 'o1', 'u1', 'Case two', 'people_search', 'self', 'remediation_in_progress');
INSERT INTO scan_runs (id, case_id, status, mode) VALUES ('s1', 'c1', 'completed', 'demo');
INSERT INTO search_queries (id, scan_run_id, case_id, query_text, source_type, coverage_json) VALUES
  ('q1', 's1', 'c1', 'q', 'web', '{"group":"people_search","brokerIds":["spokeo","spokeo2","peoplesearch123"],"skippedBrokerIds":["spokeo_alt"]}'),
  ('q2', 's1', 'c1', 'q', 'web', '{"group":"people_search","brokerIds":["spokeo"],"skippedBrokerIds":[]}');

INSERT INTO exposure_candidates (id, case_id, scan_run_id, canonical_url, source_type, broker_id) VALUES
  ('k1', 'c1', 's1', 'https://peoplesearch123.example/jane', 'data_broker', 'spokeo2'),
  ('k2', 'c1', 's1', 'https://unitedstatesphonebook.example/jane', 'data_broker', 'spokeo_alt'),
  ('k3', 'c1', 's1', 'https://www.spokeo.com/jane', 'data_broker', 'spokeo');
INSERT INTO verified_exposures (id, case_id, candidate_id, canonical_url, exposure_class, confirmed_at, broker_id) VALUES
  ('e1', 'c1', 'k1', 'https://peoplesearch123.example/jane', 'people_search', '2026-01-01T00:00:00.000Z', 'spokeo2');

INSERT INTO opt_out_dispatches (id, case_id, organization_id, broker_id, broker_name, status, created_at) VALUES
  ('od-old', 'c1', 'o1', 'peoplesearch123', 'PeopleSearch123', 'completed', '2026-01-01T00:00:00.000Z'),
  ('od-new', 'c1', 'o1', 'spokeo2', 'PeopleSearch123', 'completed', '2026-03-01T00:00:00.000Z'),
  ('od-c2-new', 'c2', 'o1', 'peoplesearch123', 'PeopleSearch123', 'completed', '2026-04-01T00:00:00.000Z'),
  ('od-c2-old', 'c2', 'o1', 'spokeo2', 'PeopleSearch123', 'completed', '2026-02-01T00:00:00.000Z');

-- Case 1: the alias schedule points at the NEWER dispatch -> the kept row takes it.
-- Case 2: the alias schedule points at the OLDER dispatch -> the kept row is unchanged.
INSERT INTO protection_schedules (id, case_id, organization_id, kind, broker_id, dispatch_id, cadence_days, next_run_at, last_run_at, updated_at) VALUES
  ('ps-c1-canon', 'c1', 'o1', 'broker_recheck', 'peoplesearch123', 'od-old', 90, '2026-04-01T00:00:00.000Z', '2026-01-15T00:00:00.000Z', '2026-01-15T00:00:00.000Z'),
  ('ps-c1-alias', 'c1', 'o1', 'broker_recheck', 'spokeo2', 'od-new', 45, '2026-05-01T00:00:00.000Z', '2026-03-15T00:00:00.000Z', '2026-03-15T00:00:00.000Z'),
  ('ps-c1-alt', 'c1', 'o1', 'broker_recheck', 'spokeo_alt', NULL, 30, '2026-06-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z'),
  ('ps-c2-canon', 'c2', 'o1', 'broker_recheck', 'peoplesearch123', 'od-c2-new', 90, '2026-07-01T00:00:00.000Z', NULL, '2026-04-01T00:00:00.000Z'),
  ('ps-c2-alias', 'c2', 'o1', 'broker_recheck', 'spokeo2', 'od-c2-old', 45, '2026-03-01T00:00:00.000Z', '2026-02-10T00:00:00.000Z', '2026-02-10T00:00:00.000Z');

INSERT INTO broker_sweep_runs (id, case_id, organization_id, status) VALUES
  ('bsr1', 'c1', 'o1', 'completed'), ('bsr2', 'c1', 'o1', 'completed');
-- bsr1: alias + current rows; the alias row has the newer check -> it is kept under the current id.
-- bsr2: only an alias row -> rewritten in place.
INSERT INTO broker_sweep_matches (id, sweep_run_id, broker_id, broker_name, domain, match_reason, match_confidence, check_outcome, checked_at, profile_urls_json, evidence_id, created_at) VALUES
  ('bsm-canon', 'bsr1', 'peoplesearch123', 'PeopleSearch123', 'peoplesearch123.example', 'seen', 0.5, NULL, NULL, '["https://peoplesearch123.example/a"]', 'ev-canon', '2026-01-01T00:00:00.000Z'),
  ('bsm-alias', 'bsr1', 'spokeo2', 'PeopleSearch123', 'peoplesearch123.example', 'seen', 0.5, 'found', '2026-02-01T00:00:00.000Z', '["https://peoplesearch123.example/b"]', NULL, '2026-01-01T00:00:00.000Z'),
  ('bsm-solo', 'bsr2', 'spokeo_alt', 'UnitedStatesPhoneBook', 'unitedstatesphonebook.example', 'seen', 0.5, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z'),
  ('bsm-other', 'bsr2', 'spokeo', 'Spokeo', 'spokeo.com', 'seen', 0.5, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z');
