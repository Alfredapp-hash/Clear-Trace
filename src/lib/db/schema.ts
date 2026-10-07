import { sqliteTable, text, integer, real, unique } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  /** Bumped to revoke every outstanding session JWT for this user (logout / revokeUserSessions). */
  sessionVersion: integer("session_version").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  retentionDays: integer("retention_days").notNull().default(365),
  rateLimitPerHour: integer("rate_limit_per_hour").notNull().default(100),
  agentDefaultsJson: text("agent_defaults_json").notNull().default("{}"),
  plan: text("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status").notNull().default("none"),
  subscriptionCurrentPeriodEnd: text("subscription_current_period_end"),
  slaTier: text("sla_tier").notNull().default("standard"),
  slaResponseDays: integer("sla_response_days").notNull().default(14),
  slaRemovalDays: integer("sla_removal_days").notNull().default(45),
  slaFollowUpDays: integer("sla_follow_up_days").notNull().default(14),
  /** Set when the weekly digest was last sent; used for idempotency (see reports/digest.ts). */
  lastDigestSentAt: text("last_digest_sent_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const connectorConfigs = sqliteTable("connector_configs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  connectorType: text("connector_type").notNull(),
  label: text("label"),
  encryptedCredentials: text("encrypted_credentials").notNull(),
  maskedPreview: text("masked_preview"),
  status: text("status").notNull().default("pending"),
  lastTestedAt: text("last_tested_at"),
  lastError: text("last_error"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
}, (t) => [unique().on(t.organizationId, t.connectorType)]);

export const memberships = sqliteTable("memberships", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  role: text("role").notNull().default("user"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const familyMembers = sqliteTable("family_members", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  displayName: text("display_name").notNull(),
  relationship: text("relationship").notNull(),
  notes: text("notes"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const privacyCases = sqliteTable("privacy_cases", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  caseType: text("case_type").notNull(),
  targetRelationship: text("target_relationship").notNull(),
  status: text("status").notNull().default("draft"),
  /** Status the case had when it was paused or archived; restored (and cleared) by resume. */
  statusBeforePause: text("status_before_pause"),
  scanScopes: text("scan_scopes").notNull().default("[]"),
  ruthlessMode: integer("ruthless_mode", { mode: "boolean" }).notNull().default(false),
  familyMemberId: text("family_member_id").references(() => familyMembers.id),
  /** USPS 2-letter state code used for statutory routing (e.g. California DROP guidance). v2. */
  jurisdictionState: text("jurisdiction_state"),
  /** How jurisdiction_state was set: inferred from claims ('auto') or chosen by the user. v2. */
  jurisdictionSource: text("jurisdiction_source", { enum: ["auto", "user"] }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const authorizationRecords = sqliteTable("authorization_records", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  authorityBasis: text("authority_basis").notNull(),
  userAttestation: integer("user_attestation", { mode: "boolean" }).notNull(),
  status: text("status").notNull().default("pending"),
  guardianDocRef: text("guardian_doc_ref"),
  poaRef: text("poa_ref"),
  orgAuthRef: text("org_auth_ref"),
  attestedAt: text("attested_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const identityProfiles = sqliteTable("identity_profiles", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  label: text("label").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const identityClaims = sqliteTable("identity_claims", {
  id: text("id").primaryKey(),
  profileId: text("profile_id")
    .notNull()
    .references(() => identityProfiles.id),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  claimType: text("claim_type").notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  valueHash: text("value_hash").notNull(),
  scanEnabled: integer("scan_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const scanRuns = sqliteTable("scan_runs", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  status: text("status").notNull().default("queued"),
  mode: text("mode").notNull().default("demo"),
  queryCount: integer("query_count").notNull().default(0),
  candidateCount: integer("candidate_count").notNull().default(0),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  /** What started the run: a user ('manual') or the protection scheduler ('scheduled'). v2. */
  trigger: text("trigger", { enum: ["manual", "scheduled"] }).notNull().default("manual"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const searchQueries = sqliteTable("search_queries", {
  id: text("id").primaryKey(),
  scanRunId: text("scan_run_id")
    .notNull()
    .references(() => scanRuns.id),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  queryText: text("query_text").notNull(),
  sourceType: text("source_type").notNull(),
  /** JSON SearchQueryCoverage: which broker group / brokers this query covered or skipped. v2. */
  coverageJson: text("coverage_json"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const exposureCandidates = sqliteTable("exposure_candidates", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  scanRunId: text("scan_run_id")
    .notNull()
    .references(() => scanRuns.id),
  canonicalUrl: text("canonical_url").notNull(),
  sourceType: text("source_type").notNull(),
  title: text("title"),
  matchStatus: text("match_status").notNull().default("unreviewed"),
  confidenceScore: real("confidence_score"),
  corroboratingFactors: text("corroborating_factors"),
  conflictingFactors: text("conflicting_factors"),
  evidenceId: text("evidence_id"),
  reviewedAt: text("reviewed_at"),
  /** BROKER_UNIVERSE id when the candidate is a known broker listing. v2. */
  brokerId: text("broker_id"),
  /** How the candidate was captured. v2. */
  captureMethod: text("capture_method", { enum: ["serp", "page_fetch", "user_reported"] }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const verifiedExposures = sqliteTable("verified_exposures", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  candidateId: text("candidate_id")
    .notNull()
    .references(() => exposureCandidates.id),
  canonicalUrl: text("canonical_url").notNull(),
  exposureClass: text("exposure_class").notNull(),
  sensitivity: text("sensitivity").notNull().default("medium"),
  status: text("status").notNull().default("confirmed_exposure"),
  exposureCategories: text("exposure_categories"),
  sourceClass: text("source_class"),
  riskLevel: text("risk_level"),
  recommendedRemedyFamily: text("recommended_remedy_family"),
  informationSummary: text("information_summary"),
  evidenceId: text("evidence_id"),
  /** BROKER_UNIVERSE id when the exposure is a known broker listing. v2. */
  brokerId: text("broker_id"),
  confirmedAt: text("confirmed_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const contentEvidence = sqliteTable("content_evidence", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  sourceUrl: text("source_url").notNull(),
  redactedExcerpt: text("redacted_excerpt").notNull(),
  contentHash: text("content_hash").notNull(),
  capturedAt: text("captured_at").notNull(),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const controllerTargets = sqliteTable("controller_targets", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  exposureId: text("exposure_id")
    .notNull()
    .references(() => verifiedExposures.id),
  targetType: text("target_type").notNull(),
  contactMethod: text("contact_method").notNull(),
  contactValue: text("contact_value").notNull(),
  confidenceScore: real("confidence_score").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(true),
  policyUrl: text("policy_url"),
  notes: text("notes"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const remedyRoutes = sqliteTable("remedy_routes", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  exposureId: text("exposure_id")
    .notNull()
    .references(() => verifiedExposures.id),
  controllerTargetId: text("controller_target_id")
    .notNull()
    .references(() => controllerTargets.id),
  remedyType: text("remedy_type").notNull(),
  reasoning: text("reasoning").notNull(),
  requiredUserInputs: text("required_user_inputs"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const remediationCases = sqliteTable("remediation_cases", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  exposureId: text("exposure_id")
    .notNull()
    .references(() => verifiedExposures.id),
  remedyRouteId: text("remedy_route_id")
    .notNull()
    .references(() => remedyRoutes.id),
  status: text("status").notNull().default("draft_ready"),
  messageCount: integer("message_count").notNull().default(0),
  followUpCount: integer("follow_up_count").notNull().default(0),
  doNotContact: integer("do_not_contact", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const messageDrafts = sqliteTable("message_drafts", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  remediationCaseId: text("remediation_case_id")
    .notNull()
    .references(() => remediationCases.id),
  subject: text("subject").notNull(),
  recipient: text("recipient").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("awaiting_user_approval"),
  templateId: text("template_id"),
  templateLabel: text("template_label"),
  remedyType: text("remedy_type"),
  reviewItemsJson: text("review_items_json"),
  isFollowUp: integer("is_follow_up", { mode: "boolean" })
    .notNull()
    .default(false),
  currentVersion: integer("current_version").notNull().default(1),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const messageVersions = sqliteTable("message_versions", {
  id: text("id").primaryKey(),
  draftId: text("draft_id")
    .notNull()
    .references(() => messageDrafts.id),
  version: integer("version").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  editedBy: text("edited_by"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const outboundMessages = sqliteTable("outbound_messages", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  draftId: text("draft_id")
    .notNull()
    .references(() => messageDrafts.id),
  sentVia: text("sent_via").notNull(),
  sentAt: text("sent_at").notNull(),
  notes: text("notes"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const verificationChecks = sqliteTable("verification_checks", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  exposureId: text("exposure_id")
    .notNull()
    .references(() => verifiedExposures.id),
  status: text("status").notNull(),
  sourceStatus: text("source_status").notNull(),
  searchStatus: text("search_status"),
  relevantContentPresent: integer("relevant_content_present", { mode: "boolean" }),
  redirectChain: text("redirect_chain"),
  confidenceScore: real("confidence_score"),
  evidenceId: text("evidence_id"),
  followUpEligible: integer("follow_up_eligible", { mode: "boolean" }).default(false),
  checkedAt: text("checked_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const monitoringRules = sqliteTable("monitoring_rules", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  exposureId: text("exposure_id")
    .notNull()
    .references(() => verifiedExposures.id),
  schedule: text("schedule").notNull().default("weekly"),
  nextCheckAt: text("next_check_at").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const followUpRules = sqliteTable("follow_up_rules", {
  id: text("id").primaryKey(),
  remediationCaseId: text("remediation_case_id")
    .notNull()
    .references(() => remediationCases.id),
  maxFollowUps: integer("max_follow_ups").notNull().default(2),
  firstFollowUpDays: integer("first_follow_up_days").notNull().default(14),
  secondFollowUpDays: integer("second_follow_up_days").notNull().default(30),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  skillId: text("skill_id").notNull(),
  status: text("status").notNull().default("queued"),
  summary: text("summary"),
  confidenceScore: real("confidence_score"),
  outputJson: text("output_json"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const agentTasks = sqliteTable("agent_tasks", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.id),
  taskType: text("task_type").notNull(),
  status: text("status").notNull().default("pending"),
  detail: text("detail"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  caseId: text("case_id").references(() => privacyCases.id),
  organizationId: text("organization_id").references(() => organizations.id),
  userId: text("user_id").references(() => users.id),
  eventType: text("event_type").notNull(),
  summary: text("summary").notNull(),
  detailJson: text("detail_json"),
  prevHash: text("prev_hash"),
  eventHash: text("event_hash").notNull(),
  /** Hash-chain partition: "case:<id>" or "org:<id>" (or "global"). Survives case-row deletion. */
  chainKey: text("chain_key"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const securityScans = sqliteTable("security_scans", {
  id: text("id").primaryKey(),
  scanType: text("scan_type").notNull(),
  status: text("status").notNull(),
  findingsJson: text("findings_json"),
  runBy: text("run_by"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const rateLimitEvents = sqliteTable("rate_limit_events", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const remediationBatches = sqliteTable("remediation_batches", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  status: text("status").notNull().default("queued"),
  totalItems: integer("total_items").notNull().default(0),
  completedItems: integer("completed_items").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
});

export const remediationBatchItems = sqliteTable("remediation_batch_items", {
  id: text("id").primaryKey(),
  batchId: text("batch_id")
    .notNull()
    .references(() => remediationBatches.id),
  exposureId: text("exposure_id")
    .notNull()
    .references(() => verifiedExposures.id),
  step: text("step").notNull(),
  status: text("status").notNull().default("pending"),
  resultJson: text("result_json"),
  error: text("error"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
  /** When a run moved the item to `running` (stale claims are recovered). */
  claimedAt: text("claimed_at"),
});

export const slaDeadlines = sqliteTable("sla_deadlines", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  remediationCaseId: text("remediation_case_id").references(() => remediationCases.id),
  exposureId: text("exposure_id").references(() => verifiedExposures.id),
  deadlineType: text("deadline_type").notNull(),
  anchorAt: text("anchor_at").notNull(),
  dueAt: text("due_at").notNull(),
  status: text("status").notNull().default("pending"),
  metAt: text("met_at"),
  notes: text("notes"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  scopesJson: text("scopes_json").notNull().default('["cases:read","cases:write","broker_sweep"]'),
  createdByUserId: text("created_by_user_id").references(() => users.id),
  lastUsedAt: text("last_used_at"),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const enterpriseWebhooks = sqliteTable("enterprise_webhooks", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  name: text("name").notNull(),
  url: text("url").notNull(),
  encryptedSecret: text("encrypted_secret").notNull(),
  eventsJson: text("events_json").notNull().default('["*"]'),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  failureCount: integer("failure_count").notNull().default(0),
  lastSuccessAt: text("last_success_at"),
  lastError: text("last_error"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id")
    .notNull()
    .references(() => enterpriseWebhooks.id),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull().default("pending"),
  httpStatus: integer("http_status"),
  responseBody: text("response_body"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextRetryAt: text("next_retry_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  deliveredAt: text("delivered_at"),
});

export const brokerSweepRuns = sqliteTable("broker_sweep_runs", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  status: text("status").notNull().default("running"),
  brokerCount: integer("broker_count").notNull().default(0),
  matchCount: integer("match_count").notNull().default(0),
  resultJson: text("result_json"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
});

export const brokerSweepMatches = sqliteTable("broker_sweep_matches", {
  id: text("id").primaryKey(),
  sweepRunId: text("sweep_run_id")
    .notNull()
    .references(() => brokerSweepRuns.id),
  brokerId: text("broker_id").notNull(),
  brokerName: text("broker_name").notNull(),
  domain: text("domain").notNull(),
  matchReason: text("match_reason").notNull(),
  matchConfidence: real("match_confidence").notNull(),
  optOutUrl: text("opt_out_url"),
  status: text("status").notNull().default("open"),
  /** JSON string[] of profile URLs the user / checker found on this broker. v2. */
  profileUrlsJson: text("profile_urls_json"),
  /** content_evidence.id captured for this check (same case). v2. */
  evidenceId: text("evidence_id"),
  checkMethod: text("check_method", { enum: ["manual", "auto", "user_reported"] }),
  checkOutcome: text("check_outcome", { enum: ["found", "not_found", "blocked"] }),
  checkedAt: text("checked_at"),
  /** users.id of whoever recorded the check (null for automatic checks). v2. */
  checkedBy: text("checked_by"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const breachScanRuns = sqliteTable("breach_scan_runs", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  mode: text("mode").notNull().default("demo"),
  identifierCount: integer("identifier_count").notNull().default(0),
  findingCount: integer("finding_count").notNull().default(0),
  status: text("status").notNull().default("completed"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
});

export const breachFindings = sqliteTable("breach_findings", {
  id: text("id").primaryKey(),
  scanRunId: text("scan_run_id")
    .notNull()
    .references(() => breachScanRuns.id),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  identifierType: text("identifier_type").notNull(),
  identifierRedacted: text("identifier_redacted").notNull(),
  breachName: text("breach_name").notNull(),
  breachTitle: text("breach_title").notNull(),
  breachDate: text("breach_date"),
  domain: text("domain"),
  dataClassesJson: text("data_classes_json").notNull().default("[]"),
  pwnCount: integer("pwn_count"),
  isSensitive: integer("is_sensitive", { mode: "boolean" }).notNull().default(false),
  candidateId: text("candidate_id").references(() => exposureCandidates.id),
  status: text("status").notNull().default("open"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const optOutDispatches = sqliteTable("opt_out_dispatches", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  brokerId: text("broker_id"),
  brokerName: text("broker_name").notNull(),
  optOutUrl: text("opt_out_url"),
  exposureUrl: text("exposure_url"),
  status: text("status").notNull().default("pending_approval"),
  instructionsJson: text("instructions_json").notNull().default("{}"),
  approvedAt: text("approved_at"),
  submittedAt: text("submitted_at"),
  completedAt: text("completed_at"),
  notes: text("notes"),
  /** When this dispatch is next due for a relist re-check / re-submission. v2. */
  nextDueAt: text("next_due_at"),
  resubmitCount: integer("resubmit_count").notNull().default(0),
  /** Last time the listing was seen live (relist detection). v2. */
  lastSeenAt: text("last_seen_at"),
  /** opt_out_dispatches.id this dispatch re-submits after a relist. v2. */
  relistedFromId: text("relisted_from_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const deindexRequests = sqliteTable("deindex_requests", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  exposureId: text("exposure_id").references(() => verifiedExposures.id),
  sourceUrl: text("source_url").notNull(),
  searchEngine: text("search_engine").notNull(),
  toolUrl: text("tool_url").notNull(),
  draftSubject: text("draft_subject").notNull(),
  draftBody: text("draft_body").notNull(),
  status: text("status").notNull().default("draft"),
  submittedAt: text("submitted_at"),
  resolvedAt: text("resolved_at"),
  notes: text("notes"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/* ------------------------------------------------------------------------------------------
 * Schema v2 (Sprint 4 / v1.4.0): ongoing protection, statutory filings, job health.
 * Created by migration v2 in migrations.ts — every column here must exist there (drift test).
 * ---------------------------------------------------------------------------------------- */

export const PROTECTION_SCHEDULE_KINDS = ["discovery", "broker_sweep", "broker_recheck"] as const;
export type ProtectionScheduleKind = (typeof PROTECTION_SCHEDULE_KINDS)[number];

/** Recurring work per case. One row per (case, kind, broker) — see the unique index in v2. */
export const protectionSchedules = sqliteTable("protection_schedules", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  kind: text("kind", { enum: PROTECTION_SCHEDULE_KINDS }).notNull(),
  /** Set for broker_recheck rows (BROKER_UNIVERSE id); null for case-wide kinds. */
  brokerId: text("broker_id"),
  dispatchId: text("dispatch_id").references(() => optOutDispatches.id),
  cadenceDays: integer("cadence_days").notNull(),
  nextRunAt: text("next_run_at").notNull(),
  lastRunAt: text("last_run_at"),
  lastOutcome: text("last_outcome"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** A filing the user made themselves under a statute (e.g. California DROP). Never filed by ClearTrace. */
export const statutoryFilings = sqliteTable("statutory_filings", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => privacyCases.id),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  mechanism: text("mechanism", { enum: ["ca_drop"] }).notNull(),
  jurisdiction: text("jurisdiction", { enum: ["CA"] }).notNull(),
  filedAt: text("filed_at").notNull(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** Background job health. Holds counts and error codes only — never case data. */
export const jobRuns = sqliteTable("job_runs", {
  id: text("id").primaryKey(),
  job: text("job").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status", { enum: ["ok", "partial", "error"] }).notNull(),
  countsJson: text("counts_json").notNull().default("{}"),
  errorCode: text("error_code"),
});

/** Shape of search_queries.coverage_json. */
export interface SearchQueryCoverage {
  group: string;
  brokerIds: string[];
  skippedBrokerIds: string[];
}

export type ProtectionSchedule = typeof protectionSchedules.$inferSelect;
export type StatutoryFiling = typeof statutoryFilings.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type OptOutDispatch = typeof optOutDispatches.$inferSelect;
export type BrokerSweepMatch = typeof brokerSweepMatches.$inferSelect;

export type PrivacyCase = typeof privacyCases.$inferSelect;
export type ExposureCandidate = typeof exposureCandidates.$inferSelect;
export type VerifiedExposure = typeof verifiedExposures.$inferSelect;
export type MessageDraft = typeof messageDrafts.$inferSelect;
export type VerificationCheck = typeof verificationChecks.$inferSelect;