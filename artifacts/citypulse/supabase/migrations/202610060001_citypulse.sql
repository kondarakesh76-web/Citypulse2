-- CityPulse schema, role setup, storage policies, and explicitly simulated demo data.
-- Apply in the Supabase SQL editor for the linked project.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text not null default '',
  role text not null default 'CITIZEN' check (role in ('CITIZEN', 'ADMIN')),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  category text not null check (category in ('Traffic', 'Flooding', 'Road Damage', 'Garbage', 'Streetlight', 'Pollution', 'Infrastructure')),
  title text not null,
  description text not null,
  image_url text,
  latitude double precision,
  longitude double precision,
  location_name text,
  severity text not null check (severity in ('LOW', 'MEDIUM', 'HIGH')),
  status text not null default 'PENDING_VERIFICATION' check (status in ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED')),
  ai_confidence double precision check (ai_confidence is null or ai_confidence between 0 and 1),
  ai_category text,
  ai_summary text,
  suspicious boolean not null default false,
  duplicate_of uuid references public.reports(id) on delete set null,
  evidence_count integer not null default 1 check (evidence_count >= 1),
  is_demo boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reports_coordinates_pair check (
    (latitude is null and longitude is null)
    or (latitude between -90 and 90 and longitude between -180 and 180)
  )
);

create table if not exists public.risk_scores (
  id uuid primary key default gen_random_uuid(),
  location_name text not null unique,
  latitude double precision not null,
  longitude double precision not null,
  traffic_risk integer not null check (traffic_risk between 0 and 100),
  flood_risk integer not null check (flood_risk between 0 and 100),
  infrastructure_risk integer not null check (infrastructure_risk between 0 and 100),
  pollution_risk integer not null check (pollution_risk between 0 and 100),
  verified_report_risk integer not null default 0 check (verified_report_risk between 0 and 100),
  overall_risk integer not null check (overall_risk between 0 and 100),
  risk_level text not null check (risk_level in ('LOW', 'MEDIUM', 'HIGH')),
  calculated_at timestamptz not null default now()
);

create table if not exists public.predictions (
  id uuid primary key default gen_random_uuid(),
  location_name text not null,
  prediction_type text not null,
  probability double precision not null check (probability between 0 and 1),
  expected_start timestamptz not null,
  expected_end timestamptz not null,
  contributing_factors jsonb not null default '[]'::jsonb,
  recommendation text not null,
  created_at timestamptz not null default now(),
  constraint predictions_location_type_unique unique (location_name, prediction_type)
);

create table if not exists public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id) on delete restrict,
  report_id uuid not null references public.reports(id) on delete cascade,
  action text not null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  message text not null,
  severity text not null check (severity in ('LOW', 'MEDIUM', 'HIGH')),
  location_name text not null default 'Citywide',
  related_report_id uuid references public.reports(id) on delete set null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists reports_status_idx on public.reports(status);
create index if not exists reports_category_idx on public.reports(category);
create index if not exists reports_created_at_idx on public.reports(created_at desc);
create index if not exists reports_user_id_idx on public.reports(user_id);
create index if not exists reports_latitude_idx on public.reports(latitude);
create index if not exists reports_longitude_idx on public.reports(longitude);
create index if not exists reports_location_status_idx on public.reports(location_name, status);
create index if not exists risk_scores_risk_level_idx on public.risk_scores(risk_level);
create index if not exists risk_scores_location_name_idx on public.risk_scores(location_name);
create index if not exists predictions_location_idx on public.predictions(location_name);
create index if not exists admin_actions_report_idx on public.admin_actions(report_id, created_at desc);
create index if not exists alerts_read_created_idx on public.alerts(read, created_at desc);

create or replace function public.is_citypulse_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'ADMIN'
  );
$$;

create or replace function public.create_citypulse_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.email, ''),
    'CITIZEN'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_citypulse_profile_after_signup on auth.users;
create trigger create_citypulse_profile_after_signup
after insert on auth.users
for each row execute procedure public.create_citypulse_profile();

alter table public.profiles enable row level security;
alter table public.reports enable row level security;
alter table public.risk_scores enable row level security;
alter table public.predictions enable row level security;
alter table public.admin_actions enable row level security;
alter table public.alerts enable row level security;

drop policy if exists "Profiles are visible to their owner or admins" on public.profiles;
create policy "Profiles are visible to their owner or admins"
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_citypulse_admin());
drop policy if exists "Citizens can update their own profile" on public.profiles;
create policy "Citizens can update their own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_citypulse_admin())
  with check (id = auth.uid() or public.is_citypulse_admin());
revoke update on public.profiles from authenticated;
grant update (full_name, avatar_url, updated_at) on public.profiles to authenticated;

drop policy if exists "Reports are visible to owner, admins, or signed-in demo viewers" on public.reports;
create policy "Reports are visible to owner, admins, or signed-in demo viewers"
  on public.reports for select to authenticated
  using (user_id = auth.uid() or public.is_citypulse_admin() or is_demo);
drop policy if exists "Citizens can submit their own pending reports" on public.reports;
create policy "Citizens can submit their own pending reports"
  on public.reports for insert to authenticated
  with check (
    user_id = auth.uid()
    and status = 'PENDING_VERIFICATION'
    and is_demo = false
  );
drop policy if exists "Admins can update reports" on public.reports;
create policy "Admins can update reports"
  on public.reports for update to authenticated
  using (public.is_citypulse_admin())
  with check (public.is_citypulse_admin());

drop policy if exists "Signed-in users can view city risk scores" on public.risk_scores;
create policy "Signed-in users can view city risk scores"
  on public.risk_scores for select to authenticated using (true);
drop policy if exists "Admins manage city risk scores" on public.risk_scores;
create policy "Admins manage city risk scores"
  on public.risk_scores for all to authenticated
  using (public.is_citypulse_admin()) with check (public.is_citypulse_admin());

drop policy if exists "Signed-in users can view city predictions" on public.predictions;
create policy "Signed-in users can view city predictions"
  on public.predictions for select to authenticated using (true);
drop policy if exists "Admins manage city predictions" on public.predictions;
create policy "Admins manage city predictions"
  on public.predictions for all to authenticated
  using (public.is_citypulse_admin()) with check (public.is_citypulse_admin());

drop policy if exists "Admins can view admin actions" on public.admin_actions;
create policy "Admins can view admin actions"
  on public.admin_actions for select to authenticated
  using (public.is_citypulse_admin());
drop policy if exists "Admins can create admin actions as themselves" on public.admin_actions;
create policy "Admins can create admin actions as themselves"
  on public.admin_actions for insert to authenticated
  with check (public.is_citypulse_admin() and admin_id = auth.uid());

drop policy if exists "Admins can manage alerts" on public.alerts;
create policy "Admins can manage alerts"
  on public.alerts for all to authenticated
  using (public.is_citypulse_admin()) with check (public.is_citypulse_admin());

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.reports to authenticated;
grant select, insert, update, delete on public.risk_scores to authenticated;
grant select, insert, update, delete on public.predictions to authenticated;
grant select, insert on public.admin_actions to authenticated;
grant select, insert, update, delete on public.alerts to authenticated;

create or replace function public.citypulse_apply_admin_report_action(
  p_report_id uuid,
  p_admin_id uuid,
  p_status text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_report public.reports;
  saved_action public.admin_actions;
  action_name text;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_admin_id and role = 'ADMIN'
  ) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;

  select * into target_report
  from public.reports
  where id = p_report_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'report_not_found';
  end if;

  if not (
    (target_report.status = 'PENDING_VERIFICATION' and p_status in ('VERIFIED', 'REJECTED'))
    or (target_report.status = 'VERIFIED' and p_status in ('ASSIGNED', 'IN_PROGRESS', 'RESOLVED'))
    or (target_report.status = 'ASSIGNED' and p_status in ('IN_PROGRESS', 'RESOLVED'))
    or (target_report.status = 'IN_PROGRESS' and p_status = 'RESOLVED')
  ) then
    raise exception using errcode = '22023', message = 'invalid_report_transition';
  end if;

  update public.reports
  set status = p_status,
      updated_at = now(),
      verified_at = case
        when p_status = 'VERIFIED' then coalesce(verified_at, now())
        else verified_at
      end
  where id = p_report_id
  returning * into target_report;

  action_name := case
    when p_status = 'VERIFIED' then 'VERIFY'
    when p_status = 'REJECTED' and target_report.duplicate_of is not null then 'MARK_DUPLICATE'
    when p_status = 'REJECTED' then 'REJECT'
    when p_status = 'ASSIGNED' then 'ASSIGN'
    when p_status = 'IN_PROGRESS' then 'IN_PROGRESS'
    else 'RESOLVE'
  end;

  insert into public.admin_actions (admin_id, report_id, action, notes)
  values (p_admin_id, p_report_id, action_name, p_notes)
  returning * into saved_action;

  return jsonb_build_object(
    'report', to_jsonb(target_report),
    'action', to_jsonb(saved_action)
  );
end;
$$;

revoke all on function public.citypulse_apply_admin_report_action(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.citypulse_apply_admin_report_action(uuid, uuid, text, text) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-images', 'report-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false, file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "Report image owners and admins can view files" on storage.objects;
create policy "Report image owners and admins can view files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'report-images'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_citypulse_admin()
    )
  );
drop policy if exists "Citizens can upload to their own report folder" on storage.objects;
create policy "Citizens can upload to their own report folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'report-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "Owners and admins can remove report images" on storage.objects;
create policy "Owners and admins can remove report images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'report-images'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_citypulse_admin()
    )
  );

-- All rows below are synthetic demonstration records, not government data.
insert into public.risk_scores (
  location_name, latitude, longitude, traffic_risk, flood_risk,
  infrastructure_risk, pollution_risk, verified_report_risk, overall_risk, risk_level
) values
  ('Central Junction', 12.9752, 77.6044, 100, 80, 88, 68, 100, 88, 'HIGH'),
  ('Metro Road', 12.9780, 77.5991, 78, 42, 72, 55, 70, 64, 'MEDIUM'),
  ('Lake View', 12.9630, 77.6120, 35, 91, 38, 44, 62, 54, 'MEDIUM'),
  ('Market Street', 12.9715, 77.5850, 66, 37, 58, 79, 55, 58, 'MEDIUM'),
  ('Tech Park', 12.9340, 77.6110, 52, 33, 41, 64, 30, 45, 'MEDIUM'),
  ('University Road', 12.9870, 77.5700, 39, 28, 32, 40, 22, 33, 'LOW')
on conflict (location_name) do nothing;

insert into public.reports (
  category, title, description, latitude, longitude, location_name,
  severity, status, ai_confidence, ai_category, ai_summary, suspicious,
  evidence_count, is_demo, created_at
) values
  ('Road Damage', 'Large pothole near Central Junction', 'A deep pothole near the junction is forcing vehicles to swerve and slowing traffic.', 12.9752, 77.6044, 'Central Junction', 'HIGH', 'VERIFIED', 0.94, 'Road Damage', 'Verified road damage may affect traffic flow.', false, 3, true, now() - interval '2 days'),
  ('Traffic', 'Signal timing causing a queue', 'Long queues are forming on the east approach during the evening peak.', 12.9752, 77.6044, 'Central Junction', 'HIGH', 'IN_PROGRESS', 0.91, 'Traffic', 'Traffic buildup is reported at a high-volume junction.', false, 2, true, now() - interval '1 day'),
  ('Streetlight', 'Streetlight out by the crossing', 'The pedestrian crossing is dark after sunset because the streetlight is not working.', 12.9752, 77.6044, 'Central Junction', 'MEDIUM', 'PENDING_VERIFICATION', 0.88, 'Streetlight', 'A reported lighting outage needs human verification.', false, 1, true, now() - interval '3 hours'),
  ('Flooding', 'Water pooling along Metro Road', 'Standing water covers part of the curb lane after recent rain.', 12.9780, 77.5991, 'Metro Road', 'HIGH', 'VERIFIED', 0.92, 'Flooding', 'Verified water pooling could reduce usable road width.', false, 2, true, now() - interval '4 days'),
  ('Road Damage', 'Broken pavement outside station', 'Uneven pavement near the station entrance is difficult for pedestrians and cyclists.', 12.9780, 77.5991, 'Metro Road', 'MEDIUM', 'ASSIGNED', 0.89, 'Road Damage', 'Verified pavement damage is assigned for inspection.', false, 1, true, now() - interval '6 days'),
  ('Garbage', 'Overflowing bins at Lake View', 'Waste is spilling out of public bins near the walking path.', 12.9630, 77.6120, 'Lake View', 'MEDIUM', 'PENDING_VERIFICATION', 0.90, 'Garbage', 'A reported waste overflow requires a site check.', false, 1, true, now() - interval '5 hours'),
  ('Flooding', 'Drainage blocked near Lake View', 'Water is draining slowly around the low-lying path after rainfall.', 12.9630, 77.6120, 'Lake View', 'HIGH', 'VERIFIED', 0.93, 'Flooding', 'Verified drainage concern at a low-lying location.', false, 2, true, now() - interval '5 days'),
  ('Pollution', 'Smoke near Market Street', 'Visible smoke and a strong smell were noticed near the market loading area.', 12.9715, 77.5850, 'Market Street', 'HIGH', 'PENDING_VERIFICATION', 0.78, 'Pollution', 'Potential air quality issue; confirm the source before action.', true, 1, true, now() - interval '7 hours'),
  ('Garbage', 'Collection missed on Market Street', 'Several bags of waste remain beside the public collection point.', 12.9715, 77.5850, 'Market Street', 'MEDIUM', 'VERIFIED', 0.95, 'Garbage', 'Verified waste collection issue.', false, 2, true, now() - interval '3 days'),
  ('Traffic', 'Congestion at Tech Park entrance', 'Vehicles are backing up across the entrance during the morning commute.', 12.9340, 77.6110, 'Tech Park', 'MEDIUM', 'VERIFIED', 0.90, 'Traffic', 'Verified commuter traffic buildup.', false, 4, true, now() - interval '8 days'),
  ('Streetlight', 'Lamp flickering on service lane', 'A streetlight on the service lane switches on and off repeatedly.', 12.9340, 77.6110, 'Tech Park', 'LOW', 'RESOLVED', 0.86, 'Streetlight', 'The lighting issue was resolved in this simulation.', false, 1, true, now() - interval '12 days'),
  ('Infrastructure', 'Loose barrier at University Road', 'A roadside barrier has shifted toward the cycle lane.', 12.9870, 77.5700, 'University Road', 'MEDIUM', 'VERIFIED', 0.88, 'Infrastructure', 'Verified barrier displacement needs a maintenance check.', false, 1, true, now() - interval '9 days'),
  ('Road Damage', 'Cracked surface near campus gate', 'A crack is spreading across the outer lane by the campus gate.', 12.9870, 77.5700, 'University Road', 'LOW', 'REJECTED', 0.31, 'Road Damage', 'Available evidence did not support this report in the simulation.', true, 1, true, now() - interval '10 days'),
  ('Traffic', 'Blocked turn lane at Central Junction', 'A temporary obstruction is narrowing the turn lane and slowing buses.', 12.9752, 77.6044, 'Central Junction', 'HIGH', 'RESOLVED', 0.87, 'Traffic', 'The simulated obstruction has been cleared.', false, 2, true, now() - interval '14 days'),
  ('Infrastructure', 'Damaged sign at Metro Road', 'A directional sign is tilted and difficult to read.', 12.9780, 77.5991, 'Metro Road', 'LOW', 'VERIFIED', 0.92, 'Infrastructure', 'Verified sign damage is awaiting scheduled maintenance.', false, 1, true, now() - interval '16 days'),
  ('Pollution', 'Dust from roadside work', 'Dust is reducing visibility beside a roadwork area.', 12.9715, 77.5850, 'Market Street', 'MEDIUM', 'IN_PROGRESS', 0.89, 'Pollution', 'Dust concern is being monitored in this simulation.', false, 2, true, now() - interval '18 days'),
  ('Flooding', 'Drain inlet covered by leaves', 'Leaves are covering a drain inlet near the park entrance.', 12.9630, 77.6120, 'Lake View', 'LOW', 'RESOLVED', 0.91, 'Flooding', 'The simulated drain blockage has been cleared.', false, 1, true, now() - interval '20 days'),
  ('Garbage', 'Overflow near transit stop', 'A public bin near the transit stop is full and waste has fallen around it.', 12.9340, 77.6110, 'Tech Park', 'MEDIUM', 'VERIFIED', 0.90, 'Garbage', 'Verified bin overflow is queued for collection.', false, 3, true, now() - interval '22 days')
on conflict do nothing;

insert into public.predictions (
  location_name, prediction_type, probability, expected_start, expected_end,
  contributing_factors, recommendation
) values
  ('Central Junction', 'Potential traffic congestion', 0.82, now() + interval '1 day', now() + interval '3 days',
   '["increasing verified traffic reports", "high traffic risk", "nearby infrastructure issue"]'::jsonb,
   'Inspect traffic flow and road condition. This is an AI-assisted prototype forecast.'),
  ('Lake View', 'Localized water pooling', 0.68, now() + interval '1 day', now() + interval '5 days',
   '["elevated flood risk", "verified drainage reports"]'::jsonb,
   'Check drainage inlets after rainfall. This is an AI-assisted prototype forecast.'),
  ('Market Street', 'Waste overflow recurrence', 0.61, now() + interval '2 days', now() + interval '7 days',
   '["recent verified waste reports", "market-day foot traffic"]'::jsonb,
   'Review collection timing and bin capacity. This is an AI-assisted prototype forecast.')
on conflict do nothing;

insert into public.alerts (title, message, severity, location_name, read)
values
  ('HIGH RISK AREA DETECTED', 'Central Junction prototype risk score is 88. Review the verified factors before prioritizing.', 'HIGH', 'Central Junction', false),
  ('NEW REPORT REQUIRES VERIFICATION', 'A simulated streetlight report is waiting for administrator review.', 'MEDIUM', 'Central Junction', false),
  ('PREDICTION ALERT', 'Potential traffic congestion forecast probability is 82% in the current prototype model.', 'MEDIUM', 'Central Junction', true)
on conflict do nothing;
