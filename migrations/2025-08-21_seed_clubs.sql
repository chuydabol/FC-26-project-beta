INSERT INTO public.clubs (club_id, club_name) VALUES
('576007','Ethabella'),
('567756','Potland Pounders'),
('3638105','Real MVC'),
('55408','Elite VT'),
('3465152','Razorblacks FC'),
('1969494','Club Frijol'),
('2491998','Royal Republic'),
('4819681','Everything Dead'),
('52008','afc warriors'),
('2040883','Iron United'),
('3160508','Mad Ladz 117')
ON CONFLICT (club_id) DO NOTHING;
