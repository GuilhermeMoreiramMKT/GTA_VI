alter table public.video_jobs
  drop constraint video_jobs_score_check,
  add constraint video_jobs_score_check check (score between 0 and 100),
  add column if not exists instagram_due_at timestamptz,
  add column if not exists tiktok_due_at timestamptz;

CREATE OR REPLACE FUNCTION public.enqueue_radar_v2()
 RETURNS SETOF video_jobs
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare d date := (now() at time zone 'America/Sao_Paulo')::date;
begin
 perform pg_advisory_xact_lock(hashtext('radar-v2-limit'));
 return query insert into public.video_jobs(trend_id,title,score,source_url,rights_ref,target_day)
 select t.id,t.title,t.score,t.url,a.rights_ref,d from public.trends t join public.radar_assets a on a.trend_id=t.id
 where t.score>=0 and t.id not like 'demo-%' and t.published_at>now()-interval '2 days'
 and a.authorized and a.editorial_verified and a.expires_at>now()+interval '30 days'
 and length(trim(a.rights_ref))>0 and length(trim(a.notes))>0
 and not exists(select 1 from public.video_jobs j where j.trend_id=t.id)
 order by t.score desc limit greatest(0,4-(select count(*) from public.video_jobs where target_day=d))
 on conflict(trend_id) do nothing returning *;
end $function$;

CREATE OR REPLACE FUNCTION public.reserve_rendered_candidate(p_manifest jsonb, p_run text, p_authorized boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
 c jsonb := p_manifest->'candidate';
 k text := c->>'id';
 s integer := (c->>'score')::integer;
 d numeric := (p_manifest->>'duration')::numeric;
 start_at numeric := (c->>'start')::numeric;
 today date := (now() at time zone 'America/Sao_Paulo')::date;
 job public.video_jobs;
 ref text := case when p_authorized then 'User approved publication for the selected creator: ' || coalesce(c->>'channel','') else 'Publication authorization not attributed to this individual channel' end;
begin
 if k is null or k !~ '^(twitch-clip-|youtube-moment-|kick-clip-)[A-Za-z0-9_-]+$' or s is null or d is null or start_at is null or s not between 0 and 100 or d < 30 or d > 45.1 or start_at < 0 or p_manifest->>'subtitle_language' <> 'pt-BR' or (p_manifest->>'subtitle_segments')::integer < 1 or p_run !~ '^[0-9]+$' then
   raise exception 'Invalid candidate metadata';
 end if;
 perform pg_advisory_xact_lock(hashtext('radar-v2-limit'));
 select * into job from public.video_jobs where trend_id=k;
 if found then
   return jsonb_build_object('id',job.id,'status',job.status,'existing',true);
 end if;
 if (select count(*) from public.video_jobs where target_day=today) >= 4 then return jsonb_build_object('limit',true); end if;
 insert into public.trends(id,title,description,url,source,channel,published_at,views,score,category)
 values(k,c->>'title',c->>'evidence',c->>'url',c->>'source',c->>'channel',(c->>'publishedAt')::timestamptz,coalesce((c->>'views')::bigint,0),s,'completed-stream-clip')
 on conflict(id) do nothing;
 insert into public.radar_assets(trend_id,filename,rights_ref,authorized,editorial_verified,notes,expires_at,start_seconds,end_seconds)
 values(k,k||'.mp4',ref,p_authorized,false,'Technical validation; GitHub run '||p_run,case when p_authorized then 'infinity'::timestamptz else now() end,start_at,start_at+d)
 on conflict(trend_id) do nothing;
 insert into public.video_jobs(trend_id,title,score,source_url,target_day,status,rights_ref,script,caption)
 values(k,c->>'title',s,c->>'url',today,'rendering',ref,p_manifest::text,p_manifest->>'caption')
 returning * into job;
 return jsonb_build_object('id',job.id,'status',job.status,'existing',false);
end;
$function$;

create or replace function public.claim_radar_daily_delivery(p_id uuid, p_instagram_due timestamptz, p_tiktok_due timestamptz)
returns setof public.video_jobs
language plpgsql security invoker set search_path = '' as $$
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
    where j.id=p_id and j.status='rendered' and j.score between 0 and 100 and j.target_day<=local_today
      and j.delivery_day is null and j.video_url is not null and j.caption is not null
      and exists (select 1 from public.radar_assets a where a.trend_id=j.trend_id
        and a.authorized and a.editorial_verified and a.rights_ref=j.rights_ref
        and a.expires_at>now()+interval '30 days')
    returning j.*;
end; $$;
revoke all on function public.claim_radar_daily_delivery(uuid,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_radar_daily_delivery(uuid,timestamptz,timestamptz) to service_role;
