import {NextResponse} from "next/server";
import {analyzeChat,type ChatMessage} from "../../../../../lib/twitch-chat";
export async function POST(req:Request){
 if(!process.env.CRON_SECRET||req.headers.get("authorization")!=="Bearer "+process.env.CRON_SECRET)return NextResponse.json({error:"Unauthorized"},{status:401});
 const db=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!db||!key)return NextResponse.json({error:"Database unavailable"},{status:503});
 try{
  const body=await req.json();
  const channel=body?.channel;
  if(typeof channel!=="string"||!/^[a-zA-Z0-9_]{3,25}$/.test(channel)||!Array.isArray(body.messages)||body.messages.length>10000)return NextResponse.json({error:"Invalid payload"},{status:400});
  const messages:ChatMessage[]=body.messages.filter((x:any)=>typeof x?.timestamp==="string"&&typeof x?.userId==="string"&&typeof x?.text==="string").map((x:any)=>({timestamp:x.timestamp,userId:x.userId.slice(0,80),text:x.text.slice(0,500)}));
  const moments=analyzeChat(messages,new Date());
  if(moments.length){
   const rows=moments.map(m=>({channel,started_at:m.start,ended_at:m.end,score:m.score,messages:m.messages,unique_chatters:m.uniqueChatters,reactions:m.reactions,reason:m.reason}));
   const response=await fetch(db.replace(/\/$/,"")+"/rest/v1/twitch_chat_moments",{method:"POST",headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json",Prefer:"return=minimal"},body:JSON.stringify(rows),cache:"no-store"});
   if(!response.ok)throw Error("Supabase "+response.status);
  }
  return NextResponse.json({ok:true,channel,analyzed:messages.length,moments:moments.length});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Invalid request"},{status:502})}
}
