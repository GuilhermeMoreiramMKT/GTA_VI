import { NextResponse } from "next/server";
import { authorized } from "../../../lib/security";
export const dynamic="force-dynamic";
export async function GET(){
 if(!await authorized())return NextResponse.json({error:"Não autorizado"},{status:401});
 const base=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 const config={intervalMinutes:60,dailyLimit:4,minScore:80,duration:[30,45],instagram:true,tiktok:true,mode:"auto"};
 if(!base||!key)return NextResponse.json({config,jobs:[],ready:false,error:"Configure Supabase e execute automation_v2.sql."});
 try{
 const r=await fetch(base.replace(/\/$/,"")+"/rest/v1/video_jobs?select=id,title,score,status,target_day,instagram_id,tiktok_id,error,created_at&order=created_at.desc&limit=100",{headers:{apikey:key,Authorization:"Bearer "+key},cache:"no-store"});
 if(!r.ok)throw Error();
 return NextResponse.json({config,jobs:await r.json(),ready:true});
 }catch{return NextResponse.json({config,jobs:[],ready:false,error:"Banco ou migração V2 indisponível."})}
}
