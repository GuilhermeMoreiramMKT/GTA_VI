import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function auth(req: Request) {
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(req.headers.get("authorization") || "");
  const expected = Buffer.from("Bearer " + (secret || ""));
  return !!secret && actual.length === expected.length && timingSafeEqual(actual, expected);
}
function config() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Database unavailable");
  const url = process.env.SUPABASE_URL.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, headers: { apikey: key, Authorization: "Bearer " + key } };
}
async function db(path: string, options: RequestInit = {}) {
  const { url, headers } = config();
  const r = await fetch(url + "/rest/v1/" + path, { ...options, cache: "no-store", headers: { ...headers, "Content-Type": "application/json", ...options.headers }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("Database HTTP " + r.status);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}
const day = () => new Intl.DateTimeFormat("sv-SE", {timeZone:"America/Sao_Paulo"}).format(new Date());
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function pathFor(job: any, asset: any) {
  return { bucket: asset.authorized ? "radar-videos" : "radar-validation", object: "production/" + job.id + ".mp4" };
}
async function jobAndAsset(id: string) {
  if (!idPattern.test(id)) throw new Error("Invalid job ID");
  const [job] = await db("video_jobs?id=eq." + id);
  if (!job) throw new Error("Job missing");
  const [asset] = await db("radar_assets?trend_id=eq." + encodeURIComponent(job.trend_id));
  if (!asset) throw new Error("Asset missing");
  return {job,asset};
}
export async function GET(req: Request) {
  if (!auth(req)) return NextResponse.json({error:"Unauthorized"},{status:401});
  try {
    const used = await db("video_jobs?select=trend_id,status,target_day&order=created_at.desc&limit=1000");
    return NextResponse.json({excluded: used.filter((j: any) => j.status !== "rendering").map((j: any) => j.trend_id), remaining: Math.max(0,4-used.filter((j: any) => j.target_day === day()).length)});
  } catch { return NextResponse.json({error:"Queue unavailable"},{status:502}); }
}

export async function POST(req: Request) {
  if (!auth(req)) return NextResponse.json({error:"Unauthorized"},{status:401});
  try {
    const {url,headers} = config();
    const body = await req.json();
    const action = new URL(req.url).searchParams.get("action");
    if (action === "release-user-batch") {
      // Explicit publication request for the three items after the initial test.
      // No other channel or future clip is granted publication rights by this action.
      const requested: Record<string,string> = {
        "291e9301-d2b9-4b1a-9962-f2c470bdfe35":"Ele assinou um NDA e não pode contar o que rolou nessa festa 👀 | Corte: Tminnzy #GTAVI #GTA6 #GTAViralRadar",
        "ae781fa8-f0f6-47b9-b61a-c025e7363e48":"A reação do IShowSpeed durante GTA VI 😂 | Corte: IShowSpeed #GTAVI #GTA6 #GTAViralRadar",
        "210ea188-8530-4ac7-b1fd-14515169dc88":"xQc comenta os relacionamentos em GTA VI. Você concorda com ele? | Corte: xQc #GTAVI #GTA6 #GTAViralRadar"
      };
      if (typeof body.id !== "string" || !Object.prototype.hasOwnProperty.call(requested,body.id)) return NextResponse.json({error:"Not selected for this batch"},{status:400});
      const {job,asset}=await jobAndAsset(body.id);
      if (job.status !== "review" || job.delivery_day || job.instagram_id || job.tiktok_id) return NextResponse.json({id:job.id,status:job.status,existing:true});
      const manifest=JSON.parse(job.script || "{}");
      if (job.score<80 || manifest.subtitle_language!=="pt-BR" || manifest.duration<30 || manifest.duration>45.1 || manifest.subtitle_segments<1) throw new Error("Technical validation missing");
      const object="production/"+job.id+".mp4";
      const download=await fetch(url+"/storage/v1/object/authenticated/radar-validation/"+object,{headers,cache:"no-store",signal:AbortSignal.timeout(15000)});
      if (!download.ok) throw new Error("Private render unavailable");
      const bytes=Buffer.from(await download.arrayBuffer());
      if (bytes.length<1000 || bytes.length>50000000 || bytes.toString("ascii",4,8)!=="ftyp") throw new Error("Invalid rendered file");
      const upload=await fetch(url+"/storage/v1/object/radar-videos/"+object,{method:"POST",headers:{...headers,"Content-Type":"video/mp4","x-upsert":"true"},body:bytes,signal:AbortSignal.timeout(20000)});
      if (!upload.ok) throw new Error("Publication storage HTTP "+upload.status);
      const videoUrl=url+"/storage/v1/object/public/radar-videos/"+object;
      const checked=await fetch(videoUrl,{method:"HEAD",cache:"no-store",signal:AbortSignal.timeout(10000)});
      if (!checked.ok || Number(checked.headers.get("content-length"))!==bytes.length) throw new Error("Publication media verification failed");
      const ref="User explicitly requested publication of this selected queued clip on 2026-11-25";
      await db("radar_assets?trend_id=eq."+encodeURIComponent(job.trend_id),{method:"PATCH",body:JSON.stringify({authorized:true,editorial_verified:true,rights_ref:ref,expires_at:"infinity",notes:asset.notes+"; selected by user for publication, technical verification performed; no independent rights verification"})});
      await db("video_jobs?id=eq."+job.id+"&status=eq.review",{method:"PATCH",body:JSON.stringify({status:"rendered",rights_ref:ref,caption:requested[job.id],video_url:videoUrl,error:null})});
      return NextResponse.json({id:job.id,status:"rendered",bytes:bytes.length});
    }
    if (action === "focus-receipt") {
      if (!/^\d+$/.test(String(body.run)) || body.editorialFocus !== "coringa" || JSON.stringify(body).length > 10000) {
        return NextResponse.json({error:"Invalid focus receipt"},{status:400});
      }
      const comparison = body.comparison === true;
      await db("drafts?on_conflict=id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},
        body:JSON.stringify({id:comparison?"619b1a5f-f97f-4b2d-a786-fd69dec07797":"f7275a41-371d-4a52-82d6-d115edc45409",trend_id:comparison?"radar-br-comparison":"radar-editorial-focus",title:comparison?"Comparativo de cortes brasileiros no Kick":"Monitoramento de cortes do Coringa",script:JSON.stringify(body),caption:"Resumo da busca automática",source_url:"https://github.com/GuilhermeMoreiramMKT/GTA_VI/actions/runs/"+body.run})});
      return NextResponse.json({ok:true});
    }
    if (action === "validation-receipt") {
      if (!/^\d+$/.test(String(body.run)) || !["success","failure","cancelled","skipped"].includes(body.result) ||
          JSON.stringify(body).length > 30000) return NextResponse.json({error:"Invalid validation receipt"},{status:400});
      const readiness = body.kind === "readiness";
      const id = readiness ? "5db95897-3d18-4dab-b9b9-ae4432b062da" : "f9292482-f4c5-40ba-a854-55e324707aa8";
      await db("drafts?on_conflict=id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},
        body:JSON.stringify({id,trend_id:readiness?"radar-publication-readiness":"radar-final-validation",title:readiness?"Verificação de prontidão (não publicar)":"Validação técnica automática (não publicar)",script:JSON.stringify(body),caption:"Relatório técnico interno",source_url:"https://github.com/GuilhermeMoreiramMKT/GTA_VI/actions/runs/"+body.run})});
      return NextResponse.json({ok:true});
    }
    if (action === "reserve") {
      const m = body.manifest, c = m?.candidate;
      if (!c || !Number.isInteger(c.score) || c.score < 80 || c.score > 100 || !Number.isFinite(m.duration) || m.duration < 30 || m.duration > 45.1 || !Number.isInteger(m.subtitle_segments) || m.subtitle_segments < 1 || m.subtitle_language !== "pt-BR" || m.public_post !== false || typeof m.caption !== "string" || !m.caption.trim() || !/^\d+$/.test(body.run)) return NextResponse.json({error:"Invalid manifest"},{status:400});
      const source = new URL(c.url);
      if (source.protocol !== "https:" || source.username || source.password || !["twitch.tv","www.twitch.tv","clips.twitch.tv","youtube.com","www.youtube.com","youtu.be","kick.com","www.kick.com"].includes(source.hostname)) return NextResponse.json({error:"Invalid source"},{status:400});
      // Match the creator identified in the user's publication-rights declaration.
      // Display names alone are not evidence of identity.
      const slug = String(c.channelSlug || "").toLowerCase();
      const firstPath = source.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
      const authorized =
        (c.source === "Kick" && ["kick.com","www.kick.com"].includes(source.hostname) && slug === "coringa" && firstPath === "coringa") ||
        (c.source === "Twitch" && ["twitch.tv","www.twitch.tv","clips.twitch.tv"].includes(source.hostname) && ["coringa","loud_coringa"].includes(slug)) ||
        (c.source === "YouTube" && ["youtube.com","www.youtube.com","youtu.be"].includes(source.hostname) &&
          (c.creatorId === "UCnYjd7cPNluC7Hi9AZrBNMw" || ["mQ4CfLekrFI","QhKWnCPIhiU"].includes(source.searchParams.get("v") || "")));

      if (!authorized) return NextResponse.json({error:"New production is focused on Coringa"},{status:400});
      const claim = await db("rpc/reserve_rendered_candidate",{method:"POST",body:JSON.stringify({p_manifest:m,p_run:String(body.run),p_authorized:authorized})});
      if (claim.limit || claim.status !== "rendering") return NextResponse.json(claim);
      const {job,asset} = await jobAndAsset(claim.id);
      const {bucket,object}=pathFor(job,asset);
      const signed = await fetch(url+"/storage/v1/object/upload/sign/"+bucket+"/"+object,{method:"POST",headers:{...headers,"Content-Type":"application/json","x-upsert":"true"},body:"{}",signal:AbortSignal.timeout(10000)});
      if (!signed.ok) throw new Error("Storage signing HTTP "+signed.status);
      const info=await signed.json();
      const target=new URL(info.url,url+"/storage/v1/");
      // The Storage API returns a relative /object/upload/sign/... URL.
      const uploadUrl = target.pathname.startsWith("/object/") ? url + "/storage/v1" + target.pathname + target.search : target.toString();
      if (new URL(uploadUrl).origin !== new URL(url).origin) throw new Error("Invalid storage origin");
      return NextResponse.json({id:job.id,uploadUrl,status:"rendering"});
    }
    if (action === "finalize") {
      const {job,asset}=await jobAndAsset(body.id);
      if (job.status !== "rendering") return NextResponse.json({id:job.id,status:job.status,existing:true});
      const {bucket,object}=pathFor(job,asset);
      const head=await fetch(url+"/storage/v1/object/authenticated/"+bucket+"/"+object,{method:"HEAD",headers,cache:"no-store",signal:AbortSignal.timeout(10000)});
      const size=Number(head.headers.get("content-length"));
      if (!head.ok || size<1000 || size!==body.bytes || size>50000000) throw new Error("Uploaded media verification failed");
      const verified = !!asset.authorized;
      if (verified) await db("radar_assets?trend_id=eq."+encodeURIComponent(job.trend_id),{method:"PATCH",body:JSON.stringify({editorial_verified:true,notes:asset.notes+"; automatic format, duration and subtitle verification"})});
      const status=verified?"rendered":"review";
      await db("video_jobs?id=eq."+job.id+"&status=eq.rendering",{method:"PATCH",body:JSON.stringify({status,video_url:verified?url+"/storage/v1/object/public/"+bucket+"/"+object:null,error:verified?null:"Private video prepared; publication rights not declared for this channel"})});
      return NextResponse.json({id:job.id,status,bytes:size});
    }
    return NextResponse.json({error:"Unknown action"},{status:400});
  } catch (e) {return NextResponse.json({error:e instanceof Error?e.message:"Queue error"},{status:502});}
}
