-- Drafts and pre-feature rows may have no facts. Submission/acknowledgement
-- requirements are enforced transactionally against current text and version.
ALTER TABLE handovers ADD COLUMN IF NOT EXISTS critical_facts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE handovers ADD COLUMN IF NOT EXISTS critical_fact_confirmation jsonb;
CREATE INDEX IF NOT EXISTS notification_outbox_entity_version_idx ON notification_outbox(event_type,entity_id,entity_version);
