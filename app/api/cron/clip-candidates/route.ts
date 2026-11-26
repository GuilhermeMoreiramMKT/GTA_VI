import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

type Candidate = { id: string; title: string; url: string; channel: string; source: string; language: string; views: number; score: number; duration: number; start: number; publishedAt: string; evidence: string };

function authorized(request: Request) {
  const key = process.env.CRON_SECRET;
  if (!key) return false;
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from("Bearer " + key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function requestJson(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("Provider HTTP " + response.status);
  return response.json();
}

async function twitchCandidates(): Promise<Candidate[]> {
  const client = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!client || !secret) throw new Error("Twitch credentials missing");
  const token = await requestJson("https://id.twitch.tv/oauth2/token", { method: "POST", body: new URLSearchParams({ client_id: client, client_secret: secret, grant_type: "client_credentials" }) });
  const headers = { "Client-Id": client, Authorization: "Bearer " + token.access_token };
  const game = await requestJson("https://api.twitch.tv/helix/games?" + new URLSearchParams({ name: "Grand Theft Auto VI" }), { headers });
  const gameId = game.data?.[0]?.id;
  if (!gameId) throw new Error("GTA VI game category unavailable");
  const end = new Date(), start = new Date(end.getTime() - 7 * 86400000);
  const clips = await requestJson("https://api.twitch.tv/helix/clips?" + new URLSearchParams({ game_id: gameId, first: "100", started_at: start.toISOString(), ended_at: end.toISOString() }), { headers });
  const eligible = (clips.data || []).filter((clip: any) =>
    clip.video_id && Number.isFinite(clip.vod_offset) && clip.duration >= 30 && clip.duration <= 45 &&
    clip.view_count > 0 && !/strip club|private dance|nude|nsfw/i.test(clip.title || "")
  );
  const videoIds = [...new Set<string>(eligible.map((clip: any) => String(clip.video_id)))];
  if (!videoIds.length) return [];
  const videoParams = new URLSearchParams();
  for (const id of videoIds.slice(0, 100)) videoParams.append("id", id);
  const archives = await requestJson("https://api.twitch.tv/helix/videos?" + videoParams, { headers });
  const videoMap = new Map((archives.data || []).filter((video: any) => video.type === "archive").map((video: any) => [String(video.id), video]));
  const userParams = new URLSearchParams();
  for (const id of [...new Set<string>(eligible.map((clip: any) => String(clip.broadcaster_id)))].slice(0, 100)) userParams.append("user_id", id);
  const live = await requestJson("https://api.twitch.tv/helix/streams?" + userParams, { headers });
  const active = new Set((live.data || []).map((stream: any) => String(stream.id)));
  return eligible.flatMap((clip: any, index: number) => {
    const archive = videoMap.get(String(clip.video_id)) as any;
    if (!archive || (archive.stream_id && active.has(String(archive.stream_id)))) return [];
    const age = Math.max(0, (Date.now() - Date.parse(clip.created_at)) / 86400000);
    const reach = Math.min(50, 10 * Math.log10(1 + clip.view_count));
    const rank = 20 * (1 - index / Math.max(1, eligible.length));
    const freshness = 15 * Math.max(0, 1 - age / 7);
    const score = Math.round(reach + rank + freshness + 15);
    return [{ id: "twitch-clip-" + clip.id, title: clip.title, url: clip.url, channel: clip.broadcaster_name, source: "Twitch", language: clip.language || "unknown", views: clip.view_count, score, duration: clip.duration, start: 0, publishedAt: clip.created_at, evidence: "Official Twitch clip views, relative rank, recency and usable duration" }];
  });
}

async function youtubeCandidates(): Promise<Candidate[]> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YouTube API unavailable");
  const configured = (process.env.YOUTUBE_LIVE_VIDEO_IDS || "mQ4CfLekrFI,QhKWnCPIhiU,nTJ5Z9gZsZU").split(",").map(x => x.trim()).filter(x => /^[A-Za-z0-9_-]{11}$/.test(x));
  // Find current, popular completed GTA VI broadcasts rather than relying only on static IDs.
  let discovered: string[] = [];
  try {
    const search = await requestJson("https://www.googleapis.com/youtube/v3/search?" + new URLSearchParams({
      part:"snippet", type:"video", eventType:"completed", q:"GTA VI|GTA 6", order:"viewCount",
      publishedAfter:new Date(Date.now()-7*86400000).toISOString(), maxResults:"10", key
    }));
    discovered = (search.items || []).map((item: any) => item.id?.videoId).filter((id: any) => typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id));
  } catch { /* Fixed authorized archive IDs remain available when discovery is rate-limited. */ }
  const ids = [...new Set([...configured, ...discovered])].slice(0, 10);
  const videos = await requestJson("https://www.googleapis.com/youtube/v3/videos?" + new URLSearchParams({ part: "snippet,liveStreamingDetails,contentDetails", id: ids.join(","), key }));
  const candidates: Candidate[] = [];
  await Promise.allSettled((videos.items || []).map(async (video: any) => {
    if (!video.liveStreamingDetails?.actualEndTime || !/gta\s*(vi|6)|grand theft auto\s*(vi|6)/i.test(video.snippet.title)) return;
    const end = Date.parse(video.liveStreamingDetails.actualEndTime), start = Date.parse(video.liveStreamingDetails.actualStartTime);
    const available = (end - start) / 1000;
    if (!Number.isFinite(available) || available < 45) return;
    let comments;
    try {
      comments = await requestJson("https://www.googleapis.com/youtube/v3/commentThreads?" + new URLSearchParams({ part: "snippet", videoId: video.id, maxResults: "100", order: "relevance", textFormat: "plainText", key }));
    } catch { return; }
    const buckets = new Map<number, { authors: Set<string>; likes: number }>();
    for (const item of comments.items || []) {
      const comment = item.snippet?.topLevelComment?.snippet;
      if (!comment?.authorChannelId?.value) continue;
      for (const match of String(comment.textOriginal || "").matchAll(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g)) {
        const offset = Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        if (offset < 0 || offset > available - 35) continue;
        const bucket = Math.floor(offset / 30) * 30;
        const b = buckets.get(bucket) || { authors: new Set<string>(), likes: 0 };
        if (!b.authors.has(comment.authorChannelId.value)) {
          b.authors.add(comment.authorChannelId.value); b.likes += Math.max(0, Number(comment.likeCount) || 0);
        }
        buckets.set(bucket, b);
      }
    }
    for (const [offset, b] of buckets) {
      if (b.authors.size < 3) continue;
      const score = Math.round(Math.min(50, 12 * Math.log2(1 + b.authors.size)) + Math.min(35, 8 * Math.log10(1 + b.likes)) + 15);
      candidates.push({ id: "youtube-moment-" + video.id + "-" + offset, title: "Momento comentado da live de " + video.snippet.channelTitle, url: "https://www.youtube.com/watch?v=" + video.id, channel: video.snippet.channelTitle, source: "YouTube", language: video.snippet.defaultAudioLanguage || "unknown", views: 0, score, duration: 40, start: Math.max(0, offset - 5), publishedAt: video.liveStreamingDetails.actualEndTime, evidence: b.authors.size + " independent timestamp comments and " + b.likes + " likes" });
    }
  }));
  return candidates;
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const results = await Promise.allSettled([twitchCandidates(), youtubeCandidates()]);
  const candidates = results.flatMap(result => result.status === "fulfilled" ? result.value : []).filter(item => item.score >= 80).sort((a, b) => b.score - a.score).slice(0, 20);
  return NextResponse.json({ candidates, providers: { twitch: results[0].status, youtube: results[1].status }, scoreType: "heuristic engagement evidence, not guaranteed future performance" });
}
