import {NextResponse} from "next/server";
export async function GET(req:Request){
 if(!process.env.CRON_SECRET||req.headers.get("authorization")!=="Bearer "+process.env.CRON_SECRET)return NextResponse.json({error:"Unauthorized"},{status:401});
 const id=process.env.TWITCH_CLIENT_ID,secret=process.env.TWITCH_CLIENT_SECRET,db=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!id||!secret||!db||!key)return NextResponse.json({error:"Twitch/Supabase configuration missing"},{status:503});
 try{
  const auth=await fetch("https://id.twitch.tv/oauth2/token",{method:"POST",body:new URLSearchParams({client_id:id,client_secret:secret,grant_type:"client_credentials"}),cache:"no-store"});
  if(!auth.ok)throw Error("Twitch app token "+auth.status);
  const token=(await auth.json()).access_token;
  const headers={"Client-Id":id,Authorization:"Bearer "+token};
  const names=(process.env.RADAR_PRIORITY_CHANNELS??"Coringa").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
  const streamQuery=new URLSearchParams({first:"100"});for(const name of names)streamQuery.append("user_login",name);
  const [priority,discovery]=await Promise.all([
   fetch("https://api.twitch.tv/helix/streams?"+streamQuery,{headers,cache:"no-store"}),
   fetch("https://api.twitch.tv/helix/search/channels?"+new URLSearchParams({query:"GTA VI",live_only:"true",first:"50"}),{headers,cache:"no-store"})
  ]);
  if(!priority.ok||!discovery.ok)throw Error("Twitch Helix "+priority.status+"/"+discovery.status);
  const a=(await priority.json()).data??[],b=(await discovery.json()).data??[];
  const result=new Map<string,any>();
  for(const s of a)result.set(s.user_id,{id:s.id,user_id:s.user_id,user_login:s.user_login,user_name:s.user_name,title:s.title,viewer_count:s.viewer_count,game_name:s.game_name,started_at:s.started_at});
  for(const s of b){if(!/gta\s*(vi|6)|grand theft auto\s*(vi|6)/i.test(s.title+" "+s.game_name))continue;
   if(!result.has(s.id))result.set(s.id,{id:"channel-"+s.id,user_id:s.id,user_login:s.broadcaster_login,user_name:s.display_name,title:s.title,viewer_count:0,game_name:s.game_name,started_at:s.started_at??null});
  }
  const rows=[...result.values()].map(x=>({...x,checked_at:new Date().toISOString()}));
  if(rows.length){const saved=await fetch(db.replace(/\/$/,"")+"/rest/v1/twitch_live_streams?on_conflict=id",{method:"POST",headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(rows),cache:"no-store"});if(!saved.ok)throw Error("Supabase "+saved.status)}
  return NextResponse.json({ok:true,live:rows.length,priority:a.length,discovered:b.length});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Twitch discovery error"},{status:502})}
}
