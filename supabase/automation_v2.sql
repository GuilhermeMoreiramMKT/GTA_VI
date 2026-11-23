create table if not exists public.radar_assets (
 trend_id text primary key, filename text not null, rights_ref text not null,
 authorized boolean not null default false, editorial_verified boolean not null default false,
 notes text not null, expires_at timestamptz not null, start_seconds numeric not null default 0,
 end_seconds numeric not null, check(start_seconds>=0 and end_seconds-start_seconds>=30)
);
create table if not exists public.video_jobs (
 id uuid primary key default gen_random_uuid(), trend_id text not null unique references public.radar_assets(trend_id),
 title text not null, score integer not null check(score between 80 and 100), source_url text not null,
 target_day date not null default ((now() at time zone 'America/Sao_Paulo')::date),
 status text not null default 'queued' check(status in ('queued','rendering','rendered','scheduling','scheduled','failed','review','blocked')),
 rights_ref text not null, script text, caption text, video_url text, instagram_id text, tiktok_id text, error text,
 created_at timestamptz not null default now()
);
alter table public.radar_assets enable row level security;
alter table public.video_jobs enable row level security;
revoke all on public.radar_assets,public.video_jobs from anon,authenticated;
grant all on public.radar_assets,public.video_jobs to service_role;
create or replace function public.enqueue_radar_v2() returns setof public.video_jobs
language plpgsql security invoker set search_path='' as $$
declare d date := (now() at time zone 'America/Sao_Paulo')::date;
begin
 perform pg_advisory_xact_lock(hashtext('radar-v2-limit'));
 return query insert into public.video_jobs(trend_id,title,score,source_url,rights_ref,target_day)
 select t.id,t.title,t.score,t.url,a.rights_ref,d from public.trends t join public.radar_assets a on a.trend_id=t.id
 where t.score>=80 and t.id not like 'demo-%' and t.published_at>now()-interval '2 days'
 and a.authorized and a.editorial_verified and a.expires_at>now()+interval '30 days'
 and length(trim(a.rights_ref))>0 and length(trim(a.notes))>0
 and not exists(select 1 from public.video_jobs j where j.trend_id=t.id)
 order by t.score desc limit greatest(0,4-(select count(*) from public.video_jobs where target_day=d))
 on conflict(trend_id) do nothing returning *;
end $$;
create or replace function public.claim_radar_v2() returns setof public.video_jobs
language sql security invoker set search_path='' as $$
 update public.video_jobs set status='rendering' where id=(select id from public.video_jobs where status='queued' and target_day=(now() at time zone 'America/Sao_Paulo')::date order by score desc for update skip locked limit 1) returning *;
$$;
revoke all on function public.enqueue_radar_v2(),public.claim_radar_v2() from public,anon,authenticated;
grant execute on function public.enqueue_radar_v2(),public.claim_radar_v2() to service_role;
