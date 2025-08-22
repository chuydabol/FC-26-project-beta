INSERT INTO public.clubs (club_id, club_name) VALUES
('2491998','Royal Republic'),('1527486','Gungan FC'),('1969494','Club Frijol'),
('2086022','Brehemen'),('2462194','Costa Chica FC'),('5098824','Sporting de la ma'),
('4869810','Afc Tekki'),('576007','Ethabella FC'),('4933507','Loss Toyz'),
('4824736','GoldenGoals FC'),('481847','Rooney tunes'),('3050467','invincible afc'),
('4154835','khalch Fc'),('3638105','Real mvc'),('55408','Elite VT'),
('4819681','EVERYTHING DEAD'),('35642','EBK FC')
ON CONFLICT (club_id) DO NOTHING;
