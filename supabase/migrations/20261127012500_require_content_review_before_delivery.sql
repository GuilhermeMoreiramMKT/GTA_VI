alter table public.video_jobs
  add column if not exists content_review text not null default 'pending'
  check (content_review in ('pending','approved','rejected'));

CREATE OR REPLACE FUNCTION public.claim_radar_daily_delivery(p_id uuid, p_instagram_due timestamp with time zone, p_tiktok_due timestamp with time zone)
 RETURNS SETOF video_jobs
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  local_today date := (now() at time zone 'America/Sao_Paulo')::date;
  instagram_day date := (p_instagram_due at time zone 'America/Sao_Paulo')::date;
  tiktok_day date := (p_tiktok_due at time zone 'America/Sao_Paulo')::date;
begin
  if p_instagram_due is null or p_tiktok_due is null or p_instagram_due <= now() or p_tiktok_due <= now()
    or instagram_day not between local_today and local_today + 1
    or tiktok_day not between local_today and local_today + 1 then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('radar-v2-delivery-limit'));
  if exists (select 1 from public.video_jobs where instagram_due_at = p_instagram_due or tiktok_due_at = p_tiktok_due)
    or (select count(*) from public.video_jobs where (instagram_due_at at time zone 'America/Sao_Paulo')::date = instagram_day) >= 3
    or (select count(*) from public.video_jobs where (tiktok_due_at at time zone 'America/Sao_Paulo')::date = tiktok_day) >= 3 then
    return;
  end if;
  return query update public.video_jobs j
    set status='scheduling', delivery_day=local_today, instagram_due_at=p_instagram_due, tiktok_due_at=p_tiktok_due, error=null
    where j.id=p_id and j.status='rendered' and j.content_review='approved' and j.score between 0 and 100 and j.target_day<=local_today
      and j.delivery_day is null and j.video_url is not null and j.caption is not null
      and exists (select 1 from public.radar_assets a where a.trend_id=j.trend_id
        and a.authorized and a.editorial_verified and a.rights_ref=j.rights_ref
        and a.expires_at>now()+interval '30 days')
    returning j.*;
end; $function$;

CREATE OR REPLACE FUNCTION public.claim_radar_delivery(p_id uuid)
 RETURNS SETOF video_jobs
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  perform pg_advisory_xact_lock(hashtext('radar-v2-delivery-limit'));
  if (select count(*) from public.video_jobs where delivery_day=today) >= 4 then
    return;
  end if;
  return query update public.video_jobs j
    set status='scheduling', delivery_day=today, error=null
    where j.id=p_id and j.status='rendered' and j.content_review='approved' and j.score>=70 and j.target_day<=today
      and j.delivery_day is null and j.video_url is not null and j.caption is not null
      and exists (select 1 from public.radar_assets a where a.trend_id=j.trend_id
        and a.authorized and a.editorial_verified and a.rights_ref=j.rights_ref
        and a.expires_at>now()+interval '30 days')
    returning j.*;
end; $function$;