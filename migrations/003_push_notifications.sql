-- FIDs belong to a single authenticated refresh session. Rebinding replaces the
-- row id, so an old queued delivery cannot follow the device to its new owner.
CREATE TABLE IF NOT EXISTS notification_devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  installation_id text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform='android'),
  registered_at timestamptz NOT NULL,
  CHECK (length(installation_id)=22)
);
CREATE INDEX IF NOT EXISTS notification_devices_user_idx ON notification_devices(user_id);
CREATE INDEX IF NOT EXISTS notification_devices_session_idx ON notification_devices(session_id);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS assignment_version integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY,
  event_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('shift_assigned','correction_reviewed','handover_submitted')),
  entity_id uuid NOT NULL,
  entity_version integer NOT NULL CHECK (entity_version > 0),
  recipient_id uuid NOT NULL REFERENCES users(id),
  device_id uuid REFERENCES notification_devices(id) ON DELETE SET NULL,
  -- A retained UUID is used only for deduplication, never to follow a new binding.
  delivery_binding_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','sent','skipped','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 6),
  available_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL,
  UNIQUE(event_key,delivery_binding_id)
);
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx ON notification_outbox(status,available_at);
CREATE INDEX IF NOT EXISTS notification_outbox_expiry_idx ON notification_outbox(expires_at);
