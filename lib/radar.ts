export type Trend={id:string;title:string;description:string;url:string;source:string;channel:string;publishedAt:string;views:number;likes:number;comments:number;thumbnail:string;score:number;category:string;demo?:boolean};
export function score(v:number,l:number,c:number,ageHours:number){const speed=Math.log10(1+v/Math.max(1,ageHours))*12;const engage=(l+c*3)/Math.max(1,v)*600;const freshness=Math.max(0,25-ageHours/8);return Math.round(Math.min(100,Math.max(0,speed+engage+freshness)))}
export const demo:Trend[]=[
{id:"demo-1",title:"Explorando cada detalhe de Vice City",description:"Ideia ilustrativa: investigar descobertas visuais e comparar com fontes oficiais.",url:"https://www.youtube.com/results?search_query=gta+vi+vice+city",source:"YouTube",channel:"Fonte demonstrativa",publishedAt:new Date().toISOString(),views:115000,likes:7200,comments:1400,thumbnail:"",score:95,category:"Curiosidades",demo:true},
{id:"demo-2",title:"GTA V versus GTA VI: o que realmente mudou?",description:"Ideia ilustrativa de comparativo com narração e análise originais.",url:"https://www.youtube.com/results?search_query=gta+vi+comparison",source:"YouTube",channel:"Fonte demonstrativa",publishedAt:new Date().toISOString(),views:86000,likes:5600,comments:900,thumbnail:"",score:88,category:"Comparativo",demo:true},
{id:"demo-3",title:"Jason e Lucia: teorias e fatos confirmados",description:"Ideia ilustrativa para separar informações oficiais de especulações.",url:"https://www.youtube.com/results?search_query=gta+vi+jason+lucia",source:"YouTube",channel:"Fonte demonstrativa",publishedAt:new Date().toISOString(),views:44000,likes:2500,comments:390,thumbnail:"",score:82,category:"Teorias",demo:true}
];
const normalize=(s:string)=>s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
export function priorityChannels(){return (process.env.RADAR_PRIORITY_CHANNELS??"Coringa").split(",").map(x=>x.trim()).filter(Boolean)}
export function priorityScore(channel:string){const name=normalize(channel);return priorityChannels().some(x=>name.includes(normalize(x)))?12:0}
async function search(key:string,q:string){
 const p=new URLSearchParams({part:"snippet",q,type:"video",order:"date",maxResults:"30",relevanceLanguage:"pt",key});
 const r=await fetch("https://www.googleapis.com/youtube/v3/search?"+p,{cache:"no-store"});
 if(!r.ok)throw Error("YouTube API: "+r.status);
 const data=await r.json();
 return (data.items??[]).map((x:any)=>x.id?.videoId).filter((x:unknown):x is string=>typeof x==="string");
}
export async function youtube():Promise<Trend[]>{
 const key=process.env.YOUTUBE_API_KEY;if(!key)return demo;
 // Two searches per cycle: one anchored to prioritized streamers, one open discovery.
 // At an hourly cadence, searches alone consume about 4,800 quota units/day.
 const names=priorityChannels();
 const primary=names.length?names.join(" OR ")+" GTA 6 live":"GTA 6 streamer live";
 const [prioritized,discovered]=await Promise.all([
  search(key,primary),
  search(key,"GTA 6 GTA VI live streamer gameplay cortes")
 ]);
 const ids=[...new Set([...prioritized,...discovered])].slice(0,50);
 if(!ids.length)return[];
 const p=new URLSearchParams({part:"statistics,snippet,contentDetails",id:ids.join(","),key});
 const r=await fetch("https://www.googleapis.com/youtube/v3/videos?"+p,{cache:"no-store"});
 if(!r.ok)throw Error("YouTube statistics: "+r.status);
 const data=await r.json();
 return (data.items??[]).filter((x:any)=>{
  const title=String(x.snippet?.title??"");
  const description=String(x.snippet?.description??"");
  return /gta\s*(vi|6)|grand theft auto\s*(vi|6)/i.test(title+" "+description);
 }).map((x:any)=>{
  const views=Number(x.statistics?.viewCount??0),likes=Number(x.statistics?.likeCount??0),comments=Number(x.statistics?.commentCount??0);
  const publishedAt=x.snippet?.publishedAt??new Date().toISOString();
  const hours=Math.max(1,(Date.now()-new Date(publishedAt).getTime())/3600000);
  const title=x.snippet?.title??"",channel=x.snippet?.channelTitle??"";
  const base=score(views,likes,comments,hours);
  return {id:x.id,title,description:(x.snippet?.description??"").slice(0,900),url:"https://www.youtube.com/watch?v="+x.id,source:"YouTube",channel,publishedAt,views,likes,comments,thumbnail:x.snippet?.thumbnails?.medium?.url??"",score:Math.min(100,base+priorityScore(channel)),category:/live|ao vivo|stream|vod/i.test(title)?"Lives":/corte|clip|melhores momentos/i.test(title)?"Cortes":"Gameplay"} as Trend;
 }).sort((a:Trend,b:Trend)=>b.score-a.score);
}
