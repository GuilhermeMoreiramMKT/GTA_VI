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
 is_archive boolean := p_authorized and coalesce((p_manifest->>'archiveReview')::boolean,false)
   and k ~ '^kick-clip-coringa-vod-[0-9a-f-]+-[0-9]+$';
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
 if not is_archive and (select count(*) from public.video_jobs where target_day=today) >= 4 then return jsonb_build_object('limit',true); end if;
 insert into public.trends(id,title,description,url,source,channel,published_at,views,score,category)
 values(k,c->>'title',c->>'evidence',c->>'url',c->>'source',c->>'channel',(c->>'publishedAt')::timestamptz,coalesce((c->>'views')::bigint,0),s,'completed-stream-clip')
 on conflict(id) do nothing;
 insert into public.radar_assets(trend_id,filename,rights_ref,authorized,editorial_verified,notes,expires_at,start_seconds,end_seconds)
 values(k,k||'.mp4',ref,p_authorized,false,'Technical validation; GitHub run '||p_run,case when p_authorized then 'infinity'::timestamptz else now() end,start_at,start_at+d)
 on conflict(trend_id) do nothing;
 insert into public.video_jobs(trend_id,title,score,source_url,target_day,status,rights_ref,script,caption)
 values(k,c->>'title',s,c->>'url',case when is_archive then (c->>'publishedAt')::date else today end,'rendering',ref,p_manifest::text,p_manifest->>'caption')
 returning * into job;
 return jsonb_build_object('id',job.id,'status',job.status,'existing',false);
end;
$function$;

update public.video_jobs
set target_day = date '2026-11-19'
where trend_id like 'youtube-moment-QhKWnCPIhiU-%' and content_review = 'approved';
