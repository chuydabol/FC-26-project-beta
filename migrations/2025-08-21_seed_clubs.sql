INSERT INTO public.clubs (club_id, club_name) VALUES
('585548','Club Frijol')
ON CONFLICT (club_id) DO NOTHING;
