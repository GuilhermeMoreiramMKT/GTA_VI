import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import editorial from "../../../../config/editorial.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bucket = "radar-videos";
const platforms = ["instagram", "tiktok"] as const;
type Platform = typeof platforms[number];
type Destinations = Record<Platform, string> & { organizationId: string };
type Channel = { id: string; service: string; isDisconnected: boolean; isLocked: boolean; isQueuePaused: boolean };
type Job = { id: string; trend_id: string; title: string; score: number; caption: string | null; video_url: string | null; instagram_id: string | null; tiktok_id: string | null; rights_ref: string };
type Asset = { authorized: boolean; editorial_verified: boolean; expires_at: string; rights_ref: string };
type Config = { url: string; key: string; buffer: string };

function authenticated(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const desired = Buffer.from("Bearer " + expected);
  return actual.length === desired.length && timingSafeEqual(actual, desired);
}

function configuration(): Config {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const buffer = process.env.BUFFER_API_KEY;
  if (!url || !key || !buffer) throw new Error("Missing Supabase or Buffer server configuration");
  return { url: url.replace(/\/$/, ""), key, buffer };
}

async function database<T>(config: Config, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(config.url + "/rest/v1/" + path, {
    ...init,
    headers: { apikey: config.key, Authorization: "Bearer " + config.key, "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Database HTTP " + res.status);
  const body = await res.text();
  return (body ? JSON.parse(body) : []) as T;
}

async function bufferQuery<T>(config: Config, query: string, variables?: object): Promise<T> {
  const res = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.buffer, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!res.ok) throw new Error("Buffer HTTP " + res.status);
  const body = await res.json();
  if (body.errors || !body.data) throw new Error("Buffer GraphQL request rejected");
  return body.data as T;
}

async function destinations(config: Config): Promise<Destinations> {
  const { account } = await bufferQuery<{ account: { organizations: { id: string }[] } }>(config, "query { account { organizations { id } } }");
  const pairs: Destinations[] = [];
  const availability: string[] = [];
  for (const organization of account.organizations) {
    const data = await bufferQuery<{ channels: Channel[] }>(config, "query { channels(input: { organizationId: " + JSON.stringify(organization.id) + " }) { id service isDisconnected isLocked isQueuePaused } }");
    const selected = platforms.map(platform => data.channels.filter(channel => channel.service.toLowerCase() === platform));
    availability.push(selected.map((channels, index) => {
      const states = channels.map(channel => [channel.isDisconnected && "disconnected", channel.isLocked && "locked", channel.isQueuePaused && "paused"].filter(Boolean).join("+") || "active");
      return platforms[index] + "=" + (states.join(",") || "missing");
    }).join("; "));
    if (selected.every(channels => channels.length === 1 && !channels[0].isDisconnected && !channels[0].isLocked && !channels[0].isQueuePaused)) {
      pairs.push({ instagram: selected[0][0].id, tiktok: selected[1][0].id, organizationId: organization.id });
    }
  }
  if (pairs.length !== 1) throw new Error("Expected exactly one active Instagram and TikTok channel pair (" + (availability.join(" | ") || "no organization") + ")");
  return pairs[0];
}

async function send(config: Config, channelId: string, platform: Platform, caption: string, videoUrl: string, draft: boolean, dueAt?: string): Promise<string> {
  const metadata = platform === "instagram" ? ", metadata: { instagram: { type: reel, shouldShareToFeed: true } }" : "";
  const scheduling = dueAt ? ", mode: customScheduled, dueAt: " + JSON.stringify(dueAt) : ", mode: addToQueue";
  const query = "mutation { createPost(input: { channelId: " + JSON.stringify(channelId) +
    ", text: " + JSON.stringify(caption) + ", schedulingType: automatic" + scheduling + ", saveToDraft: " + draft +
    ", assets: [{ video: { url: " + JSON.stringify(videoUrl) + " } }]" + metadata +
    " }) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }";
  const response = await bufferQuery<{ createPost: { post?: { id?: string }; message?: string } }>(config, query);
  const id = response.createPost?.post?.id;
  if (!id) throw new Error("Buffer rejected " + platform + " post" + (response.createPost?.message ? ": " + response.createPost.message.slice(0, 200) : ""));
  return id;
}

const jobPath = (id: string) => "video_jobs?id=eq." + encodeURIComponent(id);

async function patchJob(config: Config, id: string, fields: object) {
  await database(config, jobPath(id), { method: "PATCH", body: JSON.stringify(fields) });
}

function localDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)?.value).join("-");
}

type ScheduledPost = { id: string; channelId: string; dueAt: string | null };
type Reservation = {
  instagram_id: string | null;
  instagram_due_at: string | null;
  tiktok_id: string | null;
  tiktok_due_at: string | null;
};

async function publicationSlots(config: Config, channels: Destinations) {
  const now = new Date();
  const days = [localDay(now), localDay(new Date(now.getTime() + 86400000))];
  const start = new Date(days[0] + "T00:00:00-03:00").toISOString();
  const end = new Date(days[1] + "T23:59:59.999-03:00").toISOString();
  const posts: ScheduledPost[] = [];
  let cursor: string | null = null;
  do {
    const after: string = cursor ? ", after: " + JSON.stringify(cursor) : "";
    const query = "query { posts(first: 50" + after + ", input: { organizationId: " + JSON.stringify(channels.organizationId) +
      ", filter: { channelIds: " + JSON.stringify(platforms.map(platform => channels[platform])) +
      ", status: [scheduled, sending, sent], dueAt: { start: " + JSON.stringify(start) + ", end: " + JSON.stringify(end) +
      " } } }) { edges { node { id channelId dueAt } } pageInfo { hasNextPage endCursor } } }";
    const { posts: page } = await bufferQuery<{posts:{edges:{node:ScheduledPost}[];pageInfo:{hasNextPage:boolean;endCursor:string|null}}}>(config, query);
    posts.push(...page.edges.map(edge => edge.node));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  const reservations = await database<Reservation[]>(config, "video_jobs?select=instagram_id,instagram_due_at,tiktok_id,tiktok_due_at" +
    "&or=(and(instagram_due_at.gte." + encodeURIComponent(start) + ",instagram_due_at.lte." + encodeURIComponent(end) +
    "),and(tiktok_due_at.gte." + encodeURIComponent(start) + ",tiktok_due_at.lte." + encodeURIComponent(end) + "))");
  const slots = {} as Record<Platform, string | undefined>;
  for (const platform of platforms) {
    const remote = posts.filter(post => post.channelId === channels[platform] && post.dueAt);
    const occupied = remote.map(post => new Date(post.dueAt!));
    const remoteIds = new Set(remote.map(post => post.id));
    for (const reservation of reservations) {
      const due = reservation[`${platform}_due_at`];
      const id = reservation[`${platform}_id`];
      if (due && (!id || !remoteIds.has(id))) occupied.push(new Date(due));
    }
    for (const day of days) {
      const sameDay = occupied.filter(due => localDay(due) === day);
      const remaining = editorial.dailyPublicationTarget - sameDay.length;
      if (remaining <= 0) continue;
      const available = (date: Date) => date.getTime() >= now.getTime() + 10 * 60000 &&
        sameDay.every(due => Math.abs(due.getTime() - date.getTime()) >= 30 * 60000);
      const preferred = editorial.publicationTimes.map(time => new Date(day + "T" + time + ":00-03:00")).filter(available);
      if (preferred.length >= remaining) {
        slots[platform] = preferred[0].toISOString();
        break;
      }
      // Recover missed slots with half-hour spacing while the publication day is still open.
      const extra = Array.from({length: 8}, (_, index) => new Date(new Date(day + "T20:00:00-03:00").getTime() + index * 30 * 60000))
        .filter(date => available(date) && preferred.every(due => Math.abs(due.getTime() - date.getTime()) >= 30 * 60000));
      const next = [...preferred, ...extra].sort((a, b) => a.getTime() - b.getTime())[0];
      if (next) {
        slots[platform] = next.toISOString();
        break;
      }
    }
  }
  return { slots, today: days[0] };
}

async function scheduleOne(config: Config, channels: Destinations) {
  const { slots, today } = await publicationSlots(config, channels);
  if (!slots.instagram || !slots.tiktok) return { scheduled: 0 };
  const jobs = await database<Job[]>(config, "video_jobs?status=eq.rendered&score=gte." + editorial.fallbackMinScore + "&target_day=lte." + today + "&order=score.desc,created_at.asc&limit=4");
  for (const job of jobs) {
    const fallback = job.score < editorial.minScore;
    if (fallback && platforms.every(platform => localDay(new Date(slots[platform]!)) !== today)) return { scheduled: 0, fallbackHeld: true };
    const assets = await database<Asset[]>(config, "radar_assets?trend_id=eq." + encodeURIComponent(job.trend_id) + "&limit=1");
    const asset = assets[0];
    const prefix = config.url + "/storage/v1/object/public/" + bucket + "/";
    if (!asset?.authorized || !asset.editorial_verified || asset.rights_ref !== job.rights_ref || (asset.expires_at !== "infinity" && (!Number.isFinite(Date.parse(asset.expires_at)) || Date.parse(asset.expires_at) < Date.now() + 30 * 86400000)) || !job.caption || !job.video_url?.startsWith(prefix)) {
      await patchJob(config, job.id, { status: "blocked", error: "Media, rights or caption verification required" });
      continue;
    }
    const claimed = await database<Job[]>(config, "rpc/claim_radar_daily_delivery", {
      method: "POST", body: JSON.stringify({ p_id: job.id, p_instagram_due: slots.instagram, p_tiktok_due: slots.tiktok }),
    });
    if (!claimed.length) continue;
    try {
      for (const platform of platforms) {
        const field = platform === "instagram" ? "instagram_id" : "tiktok_id";
        if (claimed[0][field]) continue;
        const id = await send(config, channels[platform], platform, job.caption, job.video_url, false, slots[platform]);
        await patchJob(config, job.id, { [field]: id });
      }
      await patchJob(config, job.id, { status: "scheduled" });
      return { scheduled: 1, score: job.score, fallback, dueAt: slots };
    } catch (error) {
      // An ambiguous remote result must never be retried automatically.
      const detail = error instanceof Error ? error.message : "Unconfirmed provider result";
      await patchJob(config, job.id, { status: "review", error: "Buffer scheduling needs reconciliation: " + detail });
      return { scheduled: 0, review: true };
    }
  }
  return { scheduled: 0 };
}

async function smokeTest(config: Config, request: Request, channels: Record<Platform, string>) {
  const length = Number(request.headers.get("content-length"));
  if (request.headers.get("content-type") !== "video/mp4" || !Number.isFinite(length) || length < 1000 || length > 3_900_000) {
    return NextResponse.json({ error: "Expected an MP4 below 3.9 MB" }, { status: 400 });
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length !== length || bytes.toString("ascii", 4, 8) !== "ftyp") {
    return NextResponse.json({ error: "Invalid MP4" }, { status: 400 });
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const receiptId = "8d31631d-672f-4e98-bca9-8eedaf706983";
  const receiptPath = "drafts?id=eq." + receiptId;
  const previous = await database<{ script: string }[]>(config, receiptPath + "&select=script");
  if (previous.length) {
    const saved = JSON.parse(previous[0].script);
    return NextResponse.json({ ok: Boolean(saved.instagram && saved.tiktok), instagram: Boolean(saved.instagram), tiktok: Boolean(saved.tiktok), existing: true });
  }
  const object = "integration-tests/" + hash + ".mp4";
  const videoUrl = config.url + "/storage/v1/object/public/" + bucket + "/" + object;
  const upload = await fetch(config.url + "/storage/v1/object/" + bucket + "/" + object, {
    method: "POST", headers: { apikey: config.key, Authorization: "Bearer " + config.key, "Content-Type": "video/mp4", "x-upsert": "true" },
    body: bytes, cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!upload.ok) throw new Error("Media storage HTTP " + upload.status);
  const caption = "A reação do Coringa no GTA VI! 🎮 #GTA6 #GTAVI #Coringa #GTAViralRadar";
  // Claim a durable unique receipt before any external post is created.
  const inserted = await database<{ id: string }[]>(config, "drafts?on_conflict=id", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ id: receiptId, trend_id: "buffer-integration-test", title: "Teste de integração Buffer — Coringa", script: JSON.stringify({}), caption, source_url: "https://kick.com/coringa/clips/clip_01M7V8SCRC2ZP81Y679PV8X30N" }),
  });
  if (!inserted.length) return NextResponse.json({ error: "Integration test already claimed" }, { status: 409 });
  const receipt: Partial<Record<Platform, string>> = {};
  try {
    for (const platform of platforms) {
      receipt[platform] = await send(config, channels[platform], platform, caption, videoUrl, true);
      await database(config, receiptPath, { method: "PATCH", body: JSON.stringify({ script: JSON.stringify(receipt) }) });
    }
    return NextResponse.json({ ok: true, instagram: true, tiktok: true });
  } catch {
    return NextResponse.json({ ok: false, instagram: Boolean(receipt.instagram), tiktok: Boolean(receipt.tiktok), review: true }, { status: 502 });
  }
}

async function verifyRenderedDraft(config: Config, channels: Record<Platform, string>) {
  // One fixed validation receipt; never create a public post or retry an ambiguous remote mutation.
  const receiptId = "df9a4cdb-b26e-4564-89fa-68efd564edc3";
  const receiptPath = "drafts?id=eq." + receiptId;
  const existing = await database<{script:string}[]>(config, receiptPath + "&select=script");
  if (existing.length) {
    const receipt = JSON.parse(existing[0].script);
    return NextResponse.json({ok:!!receipt.instagram && !!receipt.tiktok,instagram:!!receipt.instagram,tiktok:!!receipt.tiktok,existing:true,draft:true});
  }
  const [job] = await database<Job[]>(config, jobPath(receiptId) + "&status=eq.review&score=gte." + editorial.minScore);
  if (!job?.caption) return NextResponse.json({error:"Validated test asset unavailable"},{status:404});
  const object = "production/" + job.id + ".mp4";
  const response = await fetch(config.url+"/storage/v1/object/sign/radar-validation/"+object,{
    method:"POST",headers:{apikey:config.key,Authorization:"Bearer "+config.key,"Content-Type":"application/json"},
    body:JSON.stringify({expiresIn:86400}),cache:"no-store",signal:AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Validation media signing HTTP "+response.status);
  const result = await response.json();
  const signed = new URL(result.signedURL || result.signedUrl, config.url+"/storage/v1/");
  const videoUrl = signed.pathname.startsWith("/object/") ? config.url+"/storage/v1"+signed.pathname+signed.search : signed.toString();
  if (new URL(videoUrl).origin !== new URL(config.url).origin) throw new Error("Unexpected validation media origin");
  const inserted = await database<{id:string}[]>(config,"drafts?on_conflict=id",{
    method:"POST",headers:{Prefer:"resolution=ignore-duplicates,return=representation"},
    body:JSON.stringify({id:receiptId,trend_id:job.trend_id,title:"Teste de produção automática — não publicar",script:"{}",caption:job.caption,source_url:"https://www.twitch.tv/tminnzy/clip/AntsyPolishedKoupreyBibleThump-NHTlUqUqyb4BUNY3"})
  });
  if (!inserted.length) return NextResponse.json({error:"Validation receipt already claimed"},{status:409});
  const receipt:Partial<Record<Platform,string>>={};
  try {
    for (const platform of platforms) {
      receipt[platform]=await send(config,channels[platform],platform,job.caption,videoUrl,true);
      await database(config,receiptPath,{method:"PATCH",body:JSON.stringify({script:JSON.stringify(receipt)})});
    }
    return NextResponse.json({ok:true,instagram:true,tiktok:true,draft:true});
  } catch {
    return NextResponse.json({ok:false,instagram:!!receipt.instagram,tiktok:!!receipt.tiktok,review:true,draft:true},{status:502});
  }
}

async function publicationReadiness(config: Config) {
  const [validation] = await database<{script:string}[]>(config,"drafts?id=eq.f9292482-f4c5-40ba-a854-55e324707aa8&select=script");
  const receipts = await database<{id:string,script:string}[]>(config,"drafts?id=in.(8d31631d-672f-4e98-bca9-8eedaf706983,df9a4cdb-b26e-4564-89fa-68efd564edc3)&select=id,script");
  let verified = false;
  try {
    const r = JSON.parse(validation?.script || "{}");
    verified = r.result === "success" && r.providers?.twitch === "fulfilled" && r.providers?.youtube === "fulfilled" &&
      r.kick?.provider === "ok" && r.social?.instagram === true && r.social?.tiktok === true &&
      r.manifest?.subtitle_method === "contextual-sentences-idiom-aware-v3" && r.manifest?.candidate?.score >= editorial.fallbackMinScore &&
      r.manifest?.public_post === false && receipts.length === 2 &&
      receipts.every(row => {const test=JSON.parse(row.script);return !!test.instagram && !!test.tiktok;});
  } catch { verified = false; }
  const explicitlyPaused = process.env.RADAR_AUTO_PUBLISH === "false";
  return {verified,autoEnabled:verified && !explicitlyPaused,explicitlyPaused};
}

export async function POST(request: Request) {
  if (!authenticated(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const config = configuration();
    const channels = await destinations(config);
    const action = new URL(request.url).searchParams.get("action");
    if (action === "batch-status") {
      const profiles: Record<string,unknown> = {};
      for (const platform of platforms) {
        const data = await bufferQuery<{channel:{displayName:string|null;externalLink:string|null}}>(config,"query { channel(input:{id:"+JSON.stringify(channels[platform])+"}) { displayName externalLink } }");
        profiles[platform]=data.channel;
      }
      const jobs = await database<Job[]>(config,"video_jobs?id=in.(291e9301-d2b9-4b1a-9962-f2c470bdfe35,ae781fa8-f0f6-47b9-b61a-c025e7363e48,210ea188-8530-4ac7-b1fd-14515169dc88)&order=created_at.asc");
      const posts=[];
      for (const job of jobs) {
        const result:Record<string,unknown>={title:job.title,id:job.id};
        for (const platform of platforms) {
          const id=platform==="instagram"?job.instagram_id:job.tiktok_id;
          if (!id) continue;
          const data=await bufferQuery<{post:{status:string;dueAt:string|null}}>(config,"query { post(input:{id:"+JSON.stringify(id)+"}) { status dueAt } }");
          result[platform]=data.post;
        }
        posts.push(result);
      }
      const receipt={profiles,posts,checkedAt:new Date().toISOString()};
      await database(config,"drafts?on_conflict=id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({id:"cbb66fd0-aad0-4f4d-b3c2-3d400b92f7cc",trend_id:"radar-user-batch-status",title:"Confirmação dos posts do primeiro lote",script:JSON.stringify(receipt),caption:"Relatório interno",source_url:"https://publish.buffer.com/"})});
      return NextResponse.json({ok:true,...receipt});
    }
    if (action === "readiness") {
      const state = await publicationReadiness(config);
      const jobs = await database<{id:string}[]>(config,"video_jobs?status=eq.rendered&score=gte." + editorial.fallbackMinScore + "&select=id&limit=4");
      return NextResponse.json({ok:true,...state,readyJobs:jobs.length,dailyTarget:editorial.dailyPublicationTarget,instagram:true,tiktok:true});
    }
    if (action === "schedule") {
      const state = await publicationReadiness(config);
      if (!state.autoEnabled) return NextResponse.json({ok:true,scheduled:0,paused:true,reason:state.explicitlyPaused?"Explicitly paused":"Production validation pending"});
      return NextResponse.json({ ok: true, ...await scheduleOne(config, channels) });
    }
    if (action === "verify-rendered") return await verifyRenderedDraft(config, channels);
    if (action === "smoke") return await smokeTest(config, request, channels);
    if (action === "health") return NextResponse.json({ ok: true, instagram: true, tiktok: true });
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Integration failed" }, { status: 502 });
  }
}
