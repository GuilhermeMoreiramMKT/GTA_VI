import editorial from "../config/editorial.json";

const creators = ["LOUD Coringa", "Alanzoka", "Paulinho o Loko", "Bistecone", "Gabepeixe"];
const videoId = /^[\w-]{11}$/;
const channelId = /^UC[\w-]{22}$/;
const gta = /\b(?:gta|grand theft auto)\s*(?:vi|6)\b/i;
const day = 86400000;

type Item = {
  id: string;
  snippet: { title: string; description: string; channelId: string; channelTitle: string; publishedAt: string; defaultAudioLanguage?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string; subscriberCount?: string };
  liveStreamingDetails?: { actualEndTime?: string; actualStartTime?: string };
  status?: { privacyStatus?: string };
};

function originalOffsets(description: string) {
  const references = new Map<string, { id: string; start: number }>();
  for (const match of description.matchAll(/https:\/\/[^\s<>()]+/g)) {
    let url: URL;
    try { url = new URL(match[0].replace(/[.,;!]+$/, "")); } catch { continue; }
    if (url.username || url.password) continue;
    let id: string | null = null;
    if (url.hostname === "youtu.be") id = url.pathname.slice(1);
    if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
      id = url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/live\/([\w-]+)$/)?.[1] ?? null;
    }
    const offset = url.searchParams.get("t") ?? url.searchParams.get("start") ?? new URLSearchParams(url.hash.slice(1)).get("t");
    if (!id || !videoId.test(id) || offset === null) continue;
    const plain = offset.match(/^(\d+)s?$/);
    const clock = offset.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    const start = plain ? Number(plain[1]) : clock && offset ? Number(clock[1] || 0) * 3600 + Number(clock[2] || 0) * 60 + Number(clock[3] || 0) : NaN;
    if (Number.isSafeInteger(start)) references.set(id + ":" + start, { id, start });
  }
  return [...references.values()];
}

export async function discoverClipChannels(fetchData: (url: string) => Promise<any>, now = Date.now()) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YouTube API unavailable");
  const api = (resource: string, params: Record<string, string>) =>
    fetchData("https://www.googleapis.com/youtube/v3/" + resource + "?" + new URLSearchParams({ ...params, key }));
  const searches = await Promise.allSettled(creators.map(creator => api("search", {
    part: "snippet", type: "video", q: creator + " cortes GTA VI", maxResults: "10",
    publishedAfter: new Date(now - 7 * day).toISOString(), regionCode: "BR", relevanceLanguage: "pt",
  })));
  if (searches.every(result => result.status === "rejected")) throw new Error("Clip channel searches unavailable");
  const ids = [...new Set<string>(searches.flatMap(result => result.status === "fulfilled"
    ? (result.value.items || []).map((item: any) => item.id?.videoId) : []).filter(id => videoId.test(id || "")))];
  if (!ids.length) return { channels: [], candidates: [], unresolved: 0 };
  const response = await api("videos", { part: "snippet,statistics", id: ids.join(",") });
  const signals = ((response.items || []) as Item[]).filter(item => {
    const age = now - Date.parse(item.snippet.publishedAt);
    return channelId.test(item.snippet.channelId) && !editorial.youtube.includes(item.snippet.channelId) &&
      age >= 0 && age <= 7 * day && gta.test(item.snippet.title + " " + item.snippet.description) &&
      Number(item.statistics?.viewCount) > 0;
  }).map(item => {
    const views = Number(item.statistics?.viewCount);
    const likes = Number(item.statistics?.likeCount) || 0;
    const comments = Number(item.statistics?.commentCount) || 0;
    const ageHours = Math.max(2, (now - Date.parse(item.snippet.publishedAt)) / 3600000);
    const engagement = (views + 4 * likes + 8 * comments) / ageHours;
    return { item, views, likes, comments, engagement, references: originalOffsets(item.snippet.description) };
  }).sort((a, b) => b.engagement - a.engagement);
  if (!signals.length) return { channels: [], candidates: [], unresolved: 0 };

  const channelIds = [...new Set(signals.map(signal => signal.item.snippet.channelId))];
  const originalIds = [...new Set(signals.flatMap(signal => signal.references.map(ref => ref.id)))].slice(0, 50);
  const [channelData, liveData] = await Promise.all([
    api("channels", { part: "statistics", id: channelIds.join(",") }),
    originalIds.length ? api("videos", { part: "snippet,status,liveStreamingDetails", id: originalIds.join(",") }) : { items: [] },
  ]);
  const subscribers = new Map<string, number>(((channelData.items || []) as Item[])
    .map(item => [item.id, Number(item.statistics?.subscriberCount) || 0]));
  const channels = channelIds.map(id => {
    const clips = signals.filter(signal => signal.item.snippet.channelId === id);
    return { id, name: clips[0].item.snippet.channelTitle, subscribers: subscribers.get(id) || 0,
      recentClipsFound: clips.length, latest: clips.map(clip => clip.item.snippet.publishedAt).sort().reverse()[0],
      bestEngagementPerHour: Math.round(clips[0].engagement) };
  }).sort((a, b) => b.subscribers - a.subscribers || String(b.latest).localeCompare(String(a.latest)));
  const archives = new Map<string, Item>(((liveData.items || []) as Item[]).filter(item =>
    editorial.youtube.includes(item.snippet.channelId) && item.status?.privacyStatus === "public" && gta.test(item.snippet.title)
  ).map(item => [item.id, item]));
  const candidates = [];
  const accepted: { id: string; start: number }[] = [];
  let unresolved = 0;
  for (const signal of signals) {
    const matches = signal.references.filter(ref => {
      const live = archives.get(ref.id)?.liveStreamingDetails;
      const end = Date.parse(live?.actualEndTime || "");
      const duration = (end - Date.parse(live?.actualStartTime || "")) / 1000;
      return end <= Date.parse(signal.item.snippet.publishedAt) && duration >= ref.start + 40;
    });
    if (matches.length !== 1) {
      unresolved++;
      continue;
    }
    const [{ id, start }] = matches;
    if (accepted.some(ref => ref.id === id && Math.abs(ref.start - start) < 35)) continue;
    accepted.push({ id, start });
    const archive = archives.get(id)!;
    const score = Math.round(Math.min(95, 40 + 13 * Math.log10(1 + signal.engagement)));
    candidates.push({
      id: "youtube-moment-" + id + "-" + Math.floor((start + 5) / 30) * 30,
      title: signal.item.snippet.title, url: "https://www.youtube.com/watch?v=" + id, source: "YouTube",
      channel: archive.snippet.channelTitle, creatorId: archive.snippet.channelId, language: archive.snippet.defaultAudioLanguage || "unknown",
      duration: 40, start, publishedAt: signal.item.snippet.publishedAt, views: signal.views, score,
      discovery: "third-party-clip", evidence: "Atribuição externa com timestamp; confirmar correspondência na revisão de mídia",
      referenceClip: { id: signal.item.id, channelId: signal.item.snippet.channelId, views: signal.views, likes: signal.likes, comments: signal.comments },
    });
  }
  return { channels, candidates: candidates.slice(0, 10), unresolved };
}
