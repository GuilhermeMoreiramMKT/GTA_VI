create or replace function public.reserve_rendered_candidate(p_manifest jsonb, p_run text, p_authorized boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare
 c jsonb := p_manifest->'candidate';
 k text := c->>'id';
 s integer := (c->>'score')::integer;
 d numeric := (p_manifest->>'duration')::numeric;
 start_at numeric := (c->>'start')::numeric;
 today date := (now() at time zone 'America/Sao_Paulo')::date;
 job public.video_jobs;
 ref text := case when p_authorized then 'User-declared Coringa authorization; no expiry declared' else 'Publication authorization not attributed to this individual channel' end;
begin
 if k is null or k !~ '^(twitch-clip-|youtube-moment-|kick-clip-)[A-Za-z0-9_-]+$' or s not between 80 and 100 or d < 30 or d > 45.1 or start_at < 0 or p_manifest->>'subtitle_language' <> 'pt-BR' or (p_manifest->>'subtitle_segments')::integer < 1 or p_run !~ '^[0-9]+$' then
   raise exception 'Invalid candidate metadata';
 end if;
 perform pg_advisory_xact_lock(hashtext('radar-production-intake'));
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
$$;
revoke all on function public.reserve_rendered_candidate(jsonb,text,boolean) from public, anon, authenticated;
grant execute on function public.reserve_rendered_candidate(jsonb,text,boolean) to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('radar-validation','radar-validation',false,50000000,array['video/mp4']) on conflict(id) do nothing;