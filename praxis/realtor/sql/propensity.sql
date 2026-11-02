-- 2026-09-24 — Realtor edition, 15: likelihood to buy or sell, 1 to 5.
--
-- REALTOR DATABASES ONLY. Read the header of 2026_09_23_01_realtor_contacts.sql
-- first; the same guard runs here. Needs file 01 (leads realtor columns) and
-- file 07 (contact_briefs).
--
--   propensity_signals  one dated fact per row that bears on whether a contact
--                       may buy or sell soon, with where it came from (a deed
--                       reception number, an SOS entity, a public url, a PDL
--                       match, or a row of her own CRM). No date, no row.
--   propensity_scores   the code-computed score for a contact (1 to 5, or
--                       NULL for "not enough data", shown as a dash), its top
--                       three signals, and the one-line reason a model worded
--                       from those three, when one was.
--   contact_briefs      reason_kind widened with 'likely_mover', the Today
--                       reason for a 4 or 5 with no touch in 60 days.
--
-- The vocabularies mirror SIGNAL_KINDS and SIGNAL_SOURCES in
-- src/lib/realtor/propensity/types.ts; test/realtor-propensity.test.mjs reads
-- this file and fails if they disagree. The rubric that turns signals into a
-- score is src/lib/realtor/propensity/rubric.ts, and no trait of a person is
-- in either list (src/lib/realtor/propensity/fair-housing.ts).
--
-- Apply by hand (SQL editor or the Supabase MCP), whole, and read back.
-- Idempotent: safe to re-run. Expand only: nothing is dropped or renamed, and
-- the widened CHECK allows every value the old one did.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM leads WHERE stage IN ('lead', 'prospect', 'client', 'converted'))
     OR EXISTS (SELECT 1 FROM leads WHERE mcc_contact_id IS NOT NULL) THEN
    RAISE EXCEPTION 'migrations-realtor refused: this database holds GJC leads (GJC stages or Mission Control rows). These files are for a realtor edition database only.';
  END IF;
END $$;

-- ── propensity_signals ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS propensity_signals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  source      text NOT NULL,
  event_date  date NOT NULL,
  source_ref  text,
  source_url  text,
  weight      numeric(4, 2) NOT NULL,
  detail      text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  sig_key     text NOT NULL,
  found_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE propensity_signals DROP CONSTRAINT IF EXISTS propensity_signals_kind_check;
ALTER TABLE propensity_signals
  ADD CONSTRAINT propensity_signals_kind_check
  CHECK (kind IN (
    'mover_band', 'home_sold', 'second_property', 'lot_bought', 'recent_purchase', 'long_tenure',
    'entity_formed', 'entity_dissolved', 'trade_name_new_address', 'business_opened', 'business_moved', 'business_closed',
    'job_change', 'employer_change', 'location_change', 'relocation_public', 'fsbo_own_page',
    'stated_intent', 'active_file', 'repeat_client', 'referral_source', 'recent_contact'
  ));

ALTER TABLE propensity_signals DROP CONSTRAINT IF EXISTS propensity_signals_source_check;
ALTER TABLE propensity_signals
  ADD CONSTRAINT propensity_signals_source_check
  CHECK (source IN ('deed', 'parcel', 'eagleweb', 'sos', 'web', 'pdl', 'crm'));

-- Every signal stands on something: a row, a record number or a public page.
ALTER TABLE propensity_signals DROP CONSTRAINT IF EXISTS propensity_signals_traced_check;
ALTER TABLE propensity_signals
  ADD CONSTRAINT propensity_signals_traced_check
  CHECK (nullif(btrim(source_ref), '') IS NOT NULL OR nullif(btrim(source_url), '') IS NOT NULL);

ALTER TABLE propensity_signals DROP CONSTRAINT IF EXISTS propensity_signals_detail_check;
ALTER TABLE propensity_signals
  ADD CONSTRAINT propensity_signals_detail_check
  CHECK (length(btrim(detail)) BETWEEN 1 AND 400);

CREATE UNIQUE INDEX IF NOT EXISTS propensity_signals_key_uidx ON propensity_signals (lead_id, sig_key);
CREATE INDEX IF NOT EXISTS propensity_signals_lead_idx ON propensity_signals (lead_id, event_date DESC);
CREATE INDEX IF NOT EXISTS propensity_signals_source_idx ON propensity_signals (source);

ALTER TABLE propensity_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON propensity_signals FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON propensity_signals TO service_role;

-- ── propensity_scores ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS propensity_scores (
  lead_id              uuid PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  score                smallint,
  points               numeric(6, 2) NOT NULL DEFAULT 0,
  signal_count         integer NOT NULL DEFAULT 0,
  top_signals          jsonb NOT NULL DEFAULT '[]'::jsonb,
  held_at_four         text,
  sources_run          text[] NOT NULL DEFAULT '{crm}',
  reason               text,
  reason_hash          text,
  reason_model         text,
  reason_cost_usd      numeric(10, 6),
  reason_cost_source   text,
  rubric_version       integer NOT NULL,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  computed_by          text NOT NULL
);

ALTER TABLE propensity_scores DROP CONSTRAINT IF EXISTS propensity_scores_score_check;
ALTER TABLE propensity_scores
  ADD CONSTRAINT propensity_scores_score_check
  CHECK (score IS NULL OR score BETWEEN 1 AND 5);

ALTER TABLE propensity_scores DROP CONSTRAINT IF EXISTS propensity_scores_by_check;
ALTER TABLE propensity_scores
  ADD CONSTRAINT propensity_scores_by_check
  CHECK (computed_by IN ('run', 'sweep', 'profile'));

ALTER TABLE propensity_scores DROP CONSTRAINT IF EXISTS propensity_scores_reason_check;
ALTER TABLE propensity_scores
  ADD CONSTRAINT propensity_scores_reason_check
  CHECK (reason IS NULL OR (length(btrim(reason)) BETWEEN 1 AND 200 AND reason_hash IS NOT NULL));

ALTER TABLE propensity_scores DROP CONSTRAINT IF EXISTS propensity_scores_cost_check;
ALTER TABLE propensity_scores
  ADD CONSTRAINT propensity_scores_cost_check
  CHECK (
    (reason_cost_usd IS NULL AND reason_cost_source IS NULL)
    OR (reason_cost_usd >= 0 AND reason_cost_source IN ('provider', 'estimate'))
  );

ALTER TABLE propensity_scores DROP CONSTRAINT IF EXISTS propensity_scores_sources_check;
ALTER TABLE propensity_scores
  ADD CONSTRAINT propensity_scores_sources_check
  CHECK (sources_run <@ ARRAY['deed', 'parcel', 'eagleweb', 'sos', 'web', 'pdl', 'crm']::text[]);

CREATE INDEX IF NOT EXISTS propensity_scores_score_idx ON propensity_scores (score DESC NULLS LAST);

ALTER TABLE propensity_scores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON propensity_scores FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON propensity_scores TO service_role;

-- ── contact_briefs: the Today reason for a likely mover ─────────────────────

ALTER TABLE contact_briefs DROP CONSTRAINT IF EXISTS contact_briefs_reason_check;
ALTER TABLE contact_briefs
  ADD CONSTRAINT contact_briefs_reason_check
  CHECK (reason_kind IN ('follow_up', 'anniversary', 'birthday', 'inquiry', 'recording', 'quiet', 'likely_mover'));

COMMENT ON TABLE propensity_signals IS
  'Dated facts that bear on whether a contact may buy or sell soon, each traced to its source row, record number or public url. Kinds and sources mirror src/lib/realtor/propensity/types.ts. No protected trait or proxy is ever a signal (fair-housing.ts).';
COMMENT ON TABLE propensity_scores IS
  'Likelihood to buy or sell, 1 to 5, computed by code from propensity_signals (rubric.ts). NULL score = not enough data, shown as a dash. sources_run says which research has run; reason is model-worded from the top three signals and refused if it carries a number not in them.';
