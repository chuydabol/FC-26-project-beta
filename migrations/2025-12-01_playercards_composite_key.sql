ALTER TABLE public.playercards
ADD COLUMN IF NOT EXISTS club_id TEXT;

-- Fill missing club_id from players table if needed
UPDATE public.playercards pc
SET club_id = p.club_id
FROM public.players p
WHERE pc.player_id = p.player_id AND pc.club_id IS NULL;

-- Add unique constraint for upsert
ALTER TABLE public.playercards
DROP CONSTRAINT IF EXISTS playercards_unique;
ALTER TABLE public.playercards
ADD CONSTRAINT playercards_unique UNIQUE (player_id, club_id);
