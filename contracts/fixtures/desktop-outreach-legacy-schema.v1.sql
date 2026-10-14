SET time_zone = '+00:00';

CREATE TABLE users (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  auth_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE acquisition_social_accounts (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(255) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  account_handle VARCHAR(512) NULL,
  upstream_session_id VARCHAR(512) NULL,
  display_name VARCHAR(512) NULL,
  state VARCHAR(32) NOT NULL,
  login_state_version BIGINT NULL,
  login_state_version_high_water BIGINT UNSIGNED NOT NULL DEFAULT 0,
  revision BIGINT NOT NULL,
  etag VARCHAR(64) NOT NULL,
  last_validated_at VARCHAR(40) NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  UNIQUE KEY acquisition_social_accounts_workspace_platform (workspace_id, platform)
) ENGINE=InnoDB;

CREATE TABLE acquisition_outreach_batches (
  id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT NOT NULL,
  state VARCHAR(40) NOT NULL,
  account_id VARCHAR(255) NOT NULL,
  local_date DATE NOT NULL,
  daily_candidate_limit INT NOT NULL,
  etag VARCHAR(255) NOT NULL,
  batch_hash CHAR(71) NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id, revision),
  UNIQUE KEY uk_acquisition_outreach_batch_revision (workspace_id, id, revision),
  KEY ix_acquisition_outreach_batch_head (workspace_id, id, revision),
  KEY ix_acquisition_outreach_batch_run_page (workspace_id,run_id,created_at,id,revision)
) ENGINE=InnoDB;

CREATE TABLE acquisition_outreach_actions (
  id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_revision INT NOT NULL,
  candidate_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  local_date DATE NOT NULL,
  kind VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sequence INT NOT NULL,
  status VARCHAR(40) NOT NULL,
  predecessor_action_id VARCHAR(255) NULL,
  target_public_url VARCHAR(2000) NOT NULL,
  content_text TEXT NOT NULL,
  content_hash CHAR(71) NOT NULL,
  approval_hash CHAR(71) NOT NULL,
  authorization_version TINYINT NULL,
  approved_by VARCHAR(255) NULL,
  approved_at DATETIME(3) NULL,
  direct_message_daily_limit INT NULL,
  direct_message_daily_ordinal INT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  lease_owner VARCHAR(255) NULL,
  lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  fencing_token BIGINT NOT NULL DEFAULT 0,
  lease_expires_at DATETIME(3) NULL,
  claimed_at DATETIME(3) NULL,
  platform_receipt_reference VARCHAR(255) NULL,
  occurred_at DATETIME(3) NULL,
  failure_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  UNIQUE KEY uk_acquisition_outreach_action_sequence
    (batch_id, batch_revision, candidate_id, sequence),
  UNIQUE KEY uk_acquisition_outreach_daily_candidate
    (workspace_id, account_id, local_date, candidate_id, kind),
  UNIQUE KEY uk_acquisition_outreach_direct_message_ordinal
    (workspace_id, account_id, local_date, kind, direct_message_daily_ordinal),
  KEY ix_acquisition_outreach_action_claim (status,created_at,id),
  CONSTRAINT fk_acquisition_outreach_action_batch FOREIGN KEY (batch_id, batch_revision)
    REFERENCES acquisition_outreach_batches (id, revision)
) ENGINE=InnoDB;

CREATE TABLE acquisition_outreach_action_accounts (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  next_eligible_at DATETIME(3) NULL,
  consecutive_failures INT NOT NULL DEFAULT 0,
  risk_paused BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id, account_id)
) ENGINE=InnoDB;

CREATE TABLE acquisition_outreach_action_attempts (
  action_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fencing_token BIGINT NOT NULL,
  lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  worker_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claimed_at DATETIME(3) NOT NULL,
  lease_expires_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  outcome VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
  failure_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  platform_receipt_reference VARCHAR(255) NULL,
  UNIQUE KEY uk_acquisition_outreach_action_attempt_fence (action_id, fencing_token),
  CONSTRAINT fk_acquisition_outreach_action_attempt FOREIGN KEY (action_id)
    REFERENCES acquisition_outreach_actions (id)
) ENGINE=InnoDB;
