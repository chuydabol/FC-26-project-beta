-- Rename legacy table with spaces and ensure structure
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ea last matches'
  ) THEN
    EXECUTE 'ALTER TABLE "ea last matches" RENAME TO ea_last_matches';
  END IF;
END$$;

-- Ensure table exists with proper columns
CREATE TABLE IF NOT EXISTS public.ea_last_matches (
  club_id TEXT PRIMARY KEY,
  last_match_id TEXT
);

-- Add PK if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ea_last_matches'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.ea_last_matches
      ADD CONSTRAINT ea_last_matches_pkey PRIMARY KEY (club_id);
  END IF;
END$$;
