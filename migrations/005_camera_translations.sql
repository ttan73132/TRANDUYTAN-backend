-- Store only results explicitly saved by their owner, never camera frames.
CREATE TABLE IF NOT EXISTS camera_translations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  client_request_id uuid NOT NULL,
  source_language text NOT NULL CHECK (source_language IN ('vi','en','zh')),
  target_language text NOT NULL CHECK (target_language IN ('vi','en','zh')),
  original_text text NOT NULL CHECK (length(original_text) BETWEEN 1 AND 6000),
  translated_text text NOT NULL CHECK (length(translated_text) BETWEEN 1 AND 6000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_language <> target_language),
  UNIQUE (user_id,client_request_id)
);
CREATE INDEX IF NOT EXISTS camera_translations_owner_created_idx
  ON camera_translations(user_id,created_at DESC,id DESC);
