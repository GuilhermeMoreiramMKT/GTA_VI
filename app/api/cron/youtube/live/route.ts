import {NextResponse} from "next/server";
import {analyzeChat,type ChatMessage} from "../../../../../lib/twitch-chat";

const json=(data:unknown,status=200)=>NextResponse.json(data,{status});
export async function GET(req:Request){
 if(!process.env.CRON_SECRET||req.headers.get("authorization")!=="Bearer "+process.env.CRON_SECRET)return json({error:"Unauthorized"},401);
 const api=process.env.YOUTUBE_API_KEY,db=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!api||!db||!key)return json({error:"YOUTUBE_API_KEY or Supabase configuration missing"},503);
 const root=db.replace(/\/$/,"")+"/rest/v1/";
 const headers={apikey:key,Authorization:"Bearer "+key};
 const ids=[...new Set((process.env.YOUTUBE_LIVE_VIDEO_IDS||"mQ4CfLekrFI").split(",").map(x=>x.trim()).filter(x=>/^[a-zA-Z0-9_-]{11}$/.test(x)))].slice(0,5);
 if(!ids.length)return json({ok:true,monitored:0,reason:"No video IDs configured"});
 const results:unknown[]=[];
 try{
  for(const id of ids){
   const videoRes=await fetch("https://www.googleapis.com/youtube/v3/videos?"+new URLSearchParams({part:"snippet,liveStreamingDetails",id,key:api}),{cache:"no-store"});
   const videoBody=await videoRes.json();
   if(!videoRes.ok){results.push({videoId:id,error:"YouTube videos.list "+videoRes.status});continue}
   const video=videoBody.items?.[0],chatId=video?.liveStreamingDetails?.activeLiveChatId;
   if(!video){results.push({videoId:id,status:"not_found"});continue}
   const priorRes=await fetch(root+"youtube_live_monitor?video_id=eq."+encodeURIComponent(id)+"&select=next_page_token,next_poll_at,status",{headers,cache:"no-store"});
   if(!priorRes.ok)throw Error("Supabase state "+priorRes.status);
   const prior=(await priorRes.json())[0];
   const now=new Date();
   if(chatId&&prior?.next_poll_at&&new Date(prior.next_poll_at)>now){results.push({videoId:id,status:"waiting_for_poll_interval"});continue}
   let nextToken=prior?.next_page_token||null,wait=30000,processed=0,moments=0,status=chatId?"live":"offline";
   if(chatId){
    const params=new URLSearchParams({part:"snippet,authorDetails",liveChatId:chatId,maxResults:"200",key:api});
    if(nextToken)params.set("pageToken",nextToken);
    const chatRes=await fetch("https://www.googleapis.com/youtube/v3/liveChat/messages?"+params,{cache:"no-store"});
    const body=await chatRes.json();
    if(!chatRes.ok){results.push({videoId:id,error:"YouTube chat "+chatRes.status,detail:body.error?.message});continue}
    const messages:ChatMessage[]=(body.items||[]).filter((x:any)=>x.snippet?.publishedAt&&x.authorDetails?.channelId).map((x:any)=>({timestamp:x.snippet.publishedAt,userId:String(x.authorDetails.channelId),text:String(x.snippet.displayMessage||"").slice(0,500)}));
    processed=messages.length;nextToken=body.nextPageToken||nextToken;wait=Math.max(1000,Number(body.pollingIntervalMillis)||30000);
    // Reuse the Twitch scoring model, but persist YouTube moments separately.
    const scored=analyzeChat(messages,now);
    if(scored.length){
     const rows=scored.map(m=>({video_id:id,channel_id:video.snippet?.channelId||null,started_at:m.start,ended_at:m.end,score:m.score,messages:m.messages,unique_chatters:m.uniqueChatters,reactions:m.reactions,reason:m.reason}));
     const saved=await fetch(root+"youtube_chat_moments?on_conflict=video_id,started_at",{method:"POST",headers:{...headers,"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(rows),cache:"no-store"});
     if(!saved.ok)throw Error("Supabase moments "+saved.status);
     moments=scored.length;
    }
   }
   const row={video_id:id,channel_id:video.snippet?.channelId||null,title:video.snippet?.title||null,live_chat_id:chatId||null,next_page_token:chatId?nextToken:null,last_polled_at:now.toISOString(),next_poll_at:new Date(now.getTime()+wait).toISOString(),status,updated_at:now.toISOString()};
   const saved=await fetch(root+"youtube_live_monitor?on_conflict=video_id",{method:"POST",headers:{...headers,"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(row),cache:"no-store"});
   if(!saved.ok)throw Error("Supabase monitor "+saved.status);
   results.push({videoId:id,status,processed,moments,nextPollSeconds:Math.ceil(wait/1000)});
  }
  return json({ok:true,results});
 }catch(e){return json({error:e instanceof Error?e.message:"YouTube monitor error"},502)}
}
