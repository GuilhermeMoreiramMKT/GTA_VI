alter table public.video_jobs add column if not exists delivery_day date;
create or replace function public.claim_radar_delivery(p_id uuid)
returns setof public.video_jobs
language plpgsql security invoker set search_path = '' as $$
declare today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  perform pg_advisory_xact_lock(hashtext('radar-v2-delivery-limit'));
  if (select count(*) from public.video_jobs where delivery_day=today) >= 4 then
    return;
  end if;
  return query update public.video_jobs j
    set status='scheduling', delivery_day=today, error=null
    where j.id=p_id and j.status='rendered' and j.score>=80 and j.target_day<=today
      and j.delivery_day is null and j.video_url is not null and j.caption is not null
      and exists (select 1 from public.radar_assets a where a.trend_id=j.trend_id
        and a.authorized and a.editorial_verified and a.rights_ref=j.rights_ref
        and a.expires_at>now()+interval '30 days')
    returning j.*;
end; $$;
revoke all on function public.claim_radar_delivery(uuid) from public, anon, authenticated;
grant execute on function public.claim_radar_delivery(uuid) to service_role;