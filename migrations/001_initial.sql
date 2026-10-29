CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  address text NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_meters double precision NOT NULL CHECK (radius_meters BETWEEN 20 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  full_name text NOT NULL,
  username text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','manager','employee')),
  status text NOT NULL CHECK (status IN ('pending','active','suspended')),
  email_verified boolean NOT NULL DEFAULT false,
  branch_id uuid REFERENCES branches(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS otp_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('register','login','face_login')),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  times_sent integer NOT NULL DEFAULT 1,
  last_sent_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_user_idx ON otp_challenges(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS shifts_employee_idx ON shifts(employee_id,starts_at);
CREATE TABLE IF NOT EXISTS attendance (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES users(id),
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  check_in_at timestamptz NOT NULL,
  check_out_at timestamptz,
  latitude double precision,
  longitude double precision,
  accuracy_meters double precision,
  source text NOT NULL DEFAULT 'device',
  UNIQUE(employee_id,shift_id),
  CHECK (check_out_at IS NULL OR check_out_at >= check_in_at)
);
CREATE TABLE IF NOT EXISTS corrections (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES users(id),
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  requested_check_in timestamptz,
  requested_check_out timestamptz,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  resolution_note text NOT NULL DEFAULT '',
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_check_in IS NOT NULL OR requested_check_out IS NOT NULL),
  CHECK (requested_check_in IS NULL OR requested_check_out IS NULL OR requested_check_out >= requested_check_in)
);
CREATE TABLE IF NOT EXISTS location_shares (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  accuracy_meters double precision NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS face_templates (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  embedding jsonb NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS handovers (
  id uuid PRIMARY KEY,
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES users(id),
  recipient_id uuid NOT NULL REFERENCES users(id),
  original_text text NOT NULL,
  translated_text text NOT NULL,
  source_language text NOT NULL,
  target_language text NOT NULL,
  items jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','submitted','acknowledged')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (created_by <> recipient_id)
);
CREATE TABLE IF NOT EXISTS handover_revisions (
  id uuid PRIMARY KEY,
  handover_id uuid NOT NULL REFERENCES handovers(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(handover_id,version)
);
