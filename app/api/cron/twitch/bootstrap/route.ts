import {NextResponse} from "next/server";
import {getTwitchToken} from "../../../../../lib/twitch-auth";
export async function GET(req:Request){
 if(!process.env.CRON_SECRET||req.headers.get("authorization")!=="Bearer "+process.env.CRON_SECRET)return NextResponse.json({error:"Unauthorized"},{status:401});
 try{
  const token=await getTwitchToken();
  if(!token)return NextResponse.json({error:"Twitch OAuth not connected"},{status:503});
  const id=process.env.TWITCH_CLIENT_ID;
  if(!id)return NextResponse.json({error:"TWITCH_CLIENT_ID missing"},{status:503});
  const validation=await fetch("https://id.twitch.tv/oauth2/validate",{headers:{Authorization:"OAuth "+token},cache:"no-store"});
  if(!validation.ok)return NextResponse.json({error:"Twitch token invalid"},{status:502});
  const user=await validation.json();
  const db=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!db||!key)return NextResponse.json({error:"Supabase unavailable"},{status:503});
  const response=await fetch(db.replace(/\/$/,"")+"/rest/v1/twitch_live_streams?select=user_id,user_login,checked_at&order=checked_at.desc&limit=30",{headers:{apikey:key,Authorization:"Bearer "+key},cache:"no-store"});
  if(!response.ok)throw Error("Supabase "+response.status);
  const channels=(await response.json()).filter((x:{checked_at:string})=>Date.now()-Date.parse(x.checked_at)<20*60*1000);
  return NextResponse.json({clientId:id,token,userId:user.user_id,scopes:user.scopes,channels},{headers:{"Cache-Control":"no-store"}});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Collector bootstrap failed"},{status:502})}
}
