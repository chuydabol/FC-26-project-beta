CREATE TABLE IF NOT EXISTS public.news (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('auto','manual')),
  title TEXT NOT NULL,
  body TEXT,
  image_url TEXT,
  video_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  author TEXT
);

CREATE INDEX IF NOT EXISTS idx_news_created_at ON public.news (created_at DESC);
