-- Renames legacy matches.id to match_id if it exists.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='matches' AND column_name='id'
  ) THEN
    EXECUTE 'ALTER TABLE public.matches RENAME COLUMN id TO match_id';
  END IF;
END$$;

-- If for any reason match_id is missing, add it and backfill from raw->>''matchId''
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='matches' AND column_name='match_id'
  ) THEN
    EXECUTE 'ALTER TABLE public.matches ADD COLUMN match_id TEXT';
    EXECUTE 'UPDATE public.matches SET match_id = COALESCE(match_id, raw->>''matchId'')';
    -- Attempt to add PK (ignore if duplicates exist)
    BEGIN
      EXECUTE 'ALTER TABLE public.matches ADD PRIMARY KEY (match_id)';
    EXCEPTION WHEN others THEN
      -- fallback unique index if PK fails
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname=''public'' AND indexname=''uniq_matches_match_id''
      ) THEN
        EXECUTE 'CREATE UNIQUE INDEX uniq_matches_match_id ON public.matches(match_id)';
      END IF;
    END;
  END IF;
END$$;
