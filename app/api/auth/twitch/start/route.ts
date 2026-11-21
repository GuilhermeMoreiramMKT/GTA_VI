import {randomBytes} from "node:crypto";
import {NextResponse} from "next/server";
import {authorized} from "../../../../../lib/security";
export async function GET(){
 if(!await authorized())return NextResponse.json({error:"Faça login no GTA Viral Radar"},{status:401});
 const clientId=process.env.TWITCH_CLIENT_ID??"m7yt11itss0adqkyem9whv2hivnfnt";
 const redirect="https://gta-viral-radar.vercel.app/api/auth/twitch/callback";
 const state=randomBytes(24).toString("hex");
 const url=new URL("https://id.twitch.tv/oauth2/authorize");
 url.searchParams.set("client_id",clientId);
 url.searchParams.set("redirect_uri",redirect);
 url.searchParams.set("response_type","code");
 url.searchParams.set("scope","user:read:chat");
 url.searchParams.set("state",state);
 const response=NextResponse.redirect(url);
 response.cookies.set("twitch_oauth_state",state,{httpOnly:true,secure:true,sameSite:"lax",path:"/api/auth/twitch",maxAge:600});
 return response;
}
