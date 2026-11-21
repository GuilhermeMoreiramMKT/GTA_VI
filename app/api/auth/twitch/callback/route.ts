import {createCipheriv,createHash,randomBytes,timingSafeEqual} from "node:crypto";
import {NextRequest,NextResponse} from "next/server";
import {authorized} from "../../../../../lib/security";
export async function GET(req:NextRequest){
 const origin="https://gta-viral-radar.vercel.app";
 const state=req.nextUrl.searchParams.get("state")??"";
 const expected=req.cookies.get("twitch_oauth_state")?.value??"";
 const valid=state.length===48&&expected.length===48&&timingSafeEqual(Buffer.from(state),Buffer.from(expected));
 const fail=(reason:string)=>{const r=NextResponse.redirect(origin+"/?twitch="+reason);r.cookies.delete("twitch_oauth_state");return r};
 if(!valid)return fail("invalid_state");
 if(!await authorized())return fail("login_required");
 const code=req.nextUrl.searchParams.get("code");
 if(!code)return fail("access_denied");
 const secret=process.env.TWITCH_CLIENT_SECRET,session=process.env.SESSION_SECRET;
 if(!secret||!session||session.length<32)return fail("server_not_configured");
 const clientId=process.env.TWITCH_CLIENT_ID??"m7yt11itss0adqkyem9whv2hivnfnt";
 const params=new URLSearchParams({client_id:clientId,client_secret:secret,code,grant_type:"authorization_code",redirect_uri:origin+"/api/auth/twitch/callback"});
 try{
  const tokenResponse=await fetch("https://id.twitch.tv/oauth2/token",{method:"POST",body:params,cache:"no-store"});
  if(!tokenResponse.ok)return fail("token_exchange_failed");
  const data=await tokenResponse.json();
  if(typeof data.access_token!=="string"||typeof data.refresh_token!=="string")return fail("invalid_token");
  // Encrypted, HTTP-only cookie for the initial account-link flow. Not a durable collector credential.
  const key=createHash("sha256").update(session+":twitch").digest();
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,iv);
  const plaintext=JSON.stringify({access_token:data.access_token,refresh_token:data.refresh_token,expires_at:Date.now()+Number(data.expires_in??3600)*1000});
  const encrypted=Buffer.concat([cipher.update(plaintext,"utf8"),cipher.final()]);
  const value=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString("base64url");
  const r=NextResponse.redirect(origin+"/?twitch=connected");
  r.cookies.delete("twitch_oauth_state");
  r.cookies.set("twitch_oauth_link",value,{httpOnly:true,secure:true,sameSite:"lax",path:"/",maxAge:3600});
  return r;
 }catch{return fail("connection_failed")}
}
