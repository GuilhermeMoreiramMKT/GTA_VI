import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bucket = "radar-videos";
const platforms = ["instagram", "tiktok"] as const;
type Platform = typeof platforms[number];
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

async function destinations(config: Config): Promise<Record<Platform, string>> {
  const { account } = await bufferQuery<{ account: { organizations: { id: string }[] } }>(config, "query { account { organizations { id } } }");
  const pairs: Record<Platform, string>[] = [];
  for (const organization of account.organizations) {
    const data = await bufferQuery<{ channels: Channel[] }>(config, "query { channels(input: { organizationId: " + JSON.stringify(organization.id) + " }) { id service isDisconnected isLocked isQueuePaused } }");
    const selected = platforms.map(platform => data.channels.filter(channel => channel.service.toLowerCase() === platform));
    if (selected.every(channels => channels.length === 1 && !channels[0].isDisconnected && !channels[0].isLocked && !channels[0].isQueuePaused)) {
      pairs.push({ instagram: selected[0][0].id, tiktok: selected[1][0].id });
    }
  }
  if (pairs.length !== 1) throw new Error("Expected exactly one active Instagram and TikTok channel pair");
  return pairs[0];
}

async function send(config: Config, channelId: string, platform: Platform, caption: string, videoUrl: string, draft: boolean): Promise<string> {
  const metadata = platform === "instagram" ? ", metadata: { instagram: { type: reel, shouldShareToFeed: true } }" : "";
  const query = "mutation { createPost(input: { channelId: " + JSON.stringify(channelId) +
    ", text: " + JSON.stringify(caption) + ", schedulingType: automatic, mode: addToQueue, saveToDraft: " + draft +
    ", assets: [{ video: { url: " + JSON.stringify(videoUrl) + " } }]" + metadata +
    " }) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }";
  const response = await bufferQuery<{ createPost: { post?: { id?: string }; message?: string } }>(config, query);
  const id = response.createPost?.post?.id;
  if (!id) throw new Error("Buffer rejected " + platform + " post");
  return id;
}

const jobPath = (id: string) => "video_jobs?id=eq." + encodeURIComponent(id);

async function patchJob(config: Config, id: string, fields: object) {
  await database(config, jobPath(id), { method: "PATCH", body: JSON.stringify(fields) });
}

function today() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)?.value).join("-");
}

async function scheduleOne(config: Config, channels: Record<Platform, string>) {
  const jobs = await database<Job[]>(config, "video_jobs?status=eq.rendered&score=gte.80&target_day=lte." + today() + "&order=score.desc,created_at.asc&limit=4");
  for (const job of jobs) {
    const assets = await database<Asset[]>(config, "radar_assets?trend_id=eq." + encodeURIComponent(job.trend_id) + "&limit=1");
    const asset = assets[0];
    const prefix = config.url + "/storage/v1/object/public/" + bucket + "/";
    if (!asset?.authorized || !asset.editorial_verified || asset.rights_ref !== job.rights_ref || (asset.expires_at !== "infinity" && (!Number.isFinite(Date.parse(asset.expires_at)) || Date.parse(asset.expires_at) < Date.now() + 30 * 86400000)) || !job.caption || !job.video_url?.startsWith(prefix)) {
      await patchJob(config, job.id, { status: "blocked", error: "Media, rights, caption or score verification required" });
      continue;
    }
    const claimed = await database<Job[]>(config, "rpc/claim_radar_delivery", {
      method: "POST", body: JSON.stringify({ p_id: job.id }),
    });
    if (!claimed.length) continue;
    try {
      for (const platform of platforms) {
        const field = platform === "instagram" ? "instagram_id" : "tiktok_id";
        if (claimed[0][field]) continue;
        const id = await send(config, channels[platform], platform, job.caption, job.video_url, false);
        await patchJob(config, job.id, { [field]: id });
      }
      await patchJob(config, job.id, { status: "scheduled" });
      return { scheduled: 1 };
    } catch {
      // An ambiguous remote result must never be retried automatically.
      await patchJob(config, job.id, { status: "review", error: "Buffer scheduling needs reconciliation" });
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
  const [job] = await database<Job[]>(config, jobPath(receiptId) + "&status=eq.review&score=gte.80");
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
      r.manifest?.subtitle_method === "contextual-sentences-idiom-aware-v3" && r.manifest?.candidate?.score >= 80 &&
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
    if (action === "readiness") {
      const state = await publicationReadiness(config);
      const jobs = await database<{id:string}[]>(config,"video_jobs?status=eq.rendered&score=gte.80&select=id&limit=4");
      return NextResponse.json({ok:true,...state,readyJobs:jobs.length,instagram:true,tiktok:true});
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
