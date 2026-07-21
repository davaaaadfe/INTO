CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  is_system_owner boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Runtime bridge used while INTO migrates from the local mock repository to
-- fully normalized PostgreSQL tables. It keeps production state durable on
-- Vercel without exposing provider tokens or relying on serverless memory.
CREATE TABLE into_runtime_store (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE invoice_source AS ENUM ('manual_upload');
CREATE TYPE invoice_status AS ENUM (
  'Uploaded',
  'Reading',
  'Validation Failed',
  'Attachment Missing',
  'Payment Condition Review Required',
  'Booking Intelligence Review Required',
  'Possible Duplicate',
  'Ready to Book',
  'Learned',
  'Booked',
  'Booking Failed'
);
CREATE TYPE validation_severity AS ENUM ('error', 'warning');
CREATE TYPE booking_status AS ENUM ('success', 'failed');
CREATE TYPE duplicate_detection_outcome AS ENUM (
  'none',
  'already_booked',
  'processed_unbooked',
  'possible_duplicate'
);
CREATE TYPE duplicate_resolution_decision AS ENUM (
  'blocked_already_booked',
  're_read',
  'keep_existing',
  'cancel_upload',
  'continue_anyway'
);
CREATE TYPE extraction_version_reason AS ENUM (
  'initial',
  'manual_edit',
  'duplicate_re_read'
);

CREATE TABLE uploaded_invoices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id),
  uploaded_by_name text NOT NULL,
  source invoice_source NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL,
  file_size bigint NOT NULL,
  checksum text,
  storage_key text NOT NULL,
  status invoice_status NOT NULL DEFAULT 'Uploaded',
  last_error text,
  exact_booking_id text,
  exact_booking_status text,
  duplicate_detection_json jsonb,
  duplicate_resolution_decision duplicate_resolution_decision,
  purchase_journal_json jsonb,
  intelligence_approved_at timestamptz,
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE into_temp_invoice_files (
  storage_key text PRIMARY KEY,
  original_file_name text NOT NULL,
  stored_file_name text NOT NULL,
  file_type text NOT NULL,
  file_size bigint NOT NULL,
  checksum text NOT NULL,
  content_base64 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  invoice_id uuid REFERENCES uploaded_invoices(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  user_name text NOT NULL,
  type text NOT NULL,
  message text NOT NULL,
  field text,
  old_value_json jsonb,
  new_value_json jsonb,
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE duplicate_decision_logs (
  id uuid PRIMARY KEY,
  invoice_id uuid REFERENCES uploaded_invoices(id) ON DELETE SET NULL,
  duplicate_invoice_id uuid REFERENCES uploaded_invoices(id) ON DELETE SET NULL,
  source invoice_source NOT NULL,
  file_name text NOT NULL,
  checksum text,
  detection_outcome duplicate_detection_outcome NOT NULL,
  decision duplicate_resolution_decision NOT NULL,
  message text NOT NULL,
  exact_booking_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE extraction_version_histories (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES uploaded_invoices(id) ON DELETE CASCADE,
  version integer NOT NULL,
  reason extraction_version_reason NOT NULL,
  decision duplicate_resolution_decision,
  extracted_data_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, version)
);

CREATE TABLE extracted_invoice_data (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL UNIQUE REFERENCES uploaded_invoices(id) ON DELETE CASCADE,
  supplier_name text,
  supplier_vat_number text,
  supplier_chamber_of_commerce_number text,
  supplier_address text,
  supplier_country text,
  invoice_number text,
  reference_code text,
  invoice_date date,
  due_date date,
  payment_terms text,
  currency char(3),
  net_amount numeric(14, 2),
  vat_amount numeric(14, 2),
  gross_amount numeric(14, 2),
  iban text,
  expense_description text,
  beneficiary text,
  service_start_date date,
  service_end_date date,
  company_vat_number text,
  reverse_charge_mentioned boolean NOT NULL DEFAULT false,
  intra_community_mentioned boolean NOT NULL DEFAULT false,
  raw_text text,
  confidence numeric(5, 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoice_line_items (
  id uuid PRIMARY KEY,
  extracted_data_id uuid NOT NULL REFERENCES extracted_invoice_data(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity numeric(14, 4) NOT NULL,
  unit_price numeric(14, 4) NOT NULL,
  net_amount numeric(14, 2) NOT NULL,
  vat_rate numeric(6, 4) NOT NULL,
  vat_amount numeric(14, 2) NOT NULL,
  gross_amount numeric(14, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE validation_errors (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES uploaded_invoices(id) ON DELETE CASCADE,
  field text NOT NULL,
  message text NOT NULL,
  severity validation_severity NOT NULL DEFAULT 'error',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exact_online_connections (
  id uuid PRIMARY KEY,
  connection_scope text NOT NULL DEFAULT 'company',
  connection_owner_id text NOT NULL DEFAULT 'company_connection',
  division_code text,
  access_token_ciphertext text NOT NULL,
  refresh_token_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  scopes text[],
  status text NOT NULL DEFAULT 'connected',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_scope)
);

CREATE TABLE exact_master_data_caches (
  id uuid PRIMARY KEY,
  connection_scope text NOT NULL DEFAULT 'company',
  connection_owner_id text NOT NULL DEFAULT 'company_connection',
  exact_connection_id uuid REFERENCES exact_online_connections(id) ON DELETE SET NULL,
  division_code text NOT NULL,
  payload_json jsonb NOT NULL,
  last_synced_at timestamptz NOT NULL,
  stale_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_scope, division_code)
);

CREATE TABLE booking_attempts (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES uploaded_invoices(id),
  exact_connection_id uuid REFERENCES exact_online_connections(id),
  status booking_status NOT NULL,
  request_payload jsonb,
  response_payload jsonb,
  error_message text,
  exact_booking_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE supplier_resolution_decisions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supplier_identity text NOT NULL,
  exact_supplier_account_id text NOT NULL,
  confidence numeric(5, 4),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_mapping_decisions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supplier_account_id text NOT NULL,
  description_key text NOT NULL,
  gl_account text NOT NULL,
  vat_code text,
  cost_centre text,
  cost_unit text,
  accrual_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invoice_duplicate_guard_idx
  ON extracted_invoice_data (lower(coalesce(supplier_name, '')), lower(coalesce(invoice_number, '')))
  WHERE supplier_name IS NOT NULL AND invoice_number IS NOT NULL;

CREATE INDEX uploaded_invoices_user_status_idx ON uploaded_invoices (user_id, status);
CREATE INDEX uploaded_invoices_uploader_idx ON uploaded_invoices (uploaded_by_user_id);
CREATE INDEX uploaded_invoices_archive_status_idx ON uploaded_invoices (status, created_at);
CREATE INDEX uploaded_invoices_duplicate_file_idx ON uploaded_invoices (file_name, file_size, checksum);
CREATE INDEX uploaded_invoices_checksum_idx ON uploaded_invoices (checksum);
CREATE INDEX audit_events_invoice_idx ON audit_events (invoice_id, created_at);
CREATE INDEX audit_events_user_idx ON audit_events (user_id, created_at);
CREATE INDEX audit_events_type_idx ON audit_events (type);
CREATE INDEX duplicate_decision_logs_invoice_idx ON duplicate_decision_logs (invoice_id);
CREATE INDEX duplicate_decision_logs_duplicate_idx ON duplicate_decision_logs (duplicate_invoice_id);
CREATE INDEX duplicate_decision_logs_checksum_idx ON duplicate_decision_logs (checksum);
CREATE INDEX extraction_version_histories_invoice_idx ON extraction_version_histories (invoice_id);
CREATE INDEX extracted_invoice_data_supplier_invoice_idx ON extracted_invoice_data (supplier_name, invoice_number);
CREATE INDEX booking_attempts_invoice_idx ON booking_attempts (invoice_id);
CREATE INDEX exact_master_data_caches_freshness_idx ON exact_master_data_caches (stale_after);
CREATE INDEX supplier_resolution_decisions_identity_idx ON supplier_resolution_decisions (user_id, supplier_identity);
CREATE INDEX account_mapping_decisions_lookup_idx ON account_mapping_decisions (user_id, supplier_account_id, description_key);
