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
  // Encrypt OAuth tokens at rest, then persist server-side.
  const key=createHash("sha256").update(session+":twitch").digest();
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,iv);
  const plaintext=JSON.stringify({access_token:data.access_token,refresh_token:data.refresh_token,expires_at:Date.now()+Number(data.expires_in??3600)*1000});
  const encrypted=Buffer.concat([cipher.update(plaintext,"utf8"),cipher.final()]);
  const value=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString("base64url");
  const dbUrl=process.env.SUPABASE_URL,dbKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!dbUrl||!dbKey)return fail("database_not_configured");
  const stored=await fetch(dbUrl.replace(/\/$/,"")+"/rest/v1/twitch_connections?on_conflict=id",{
   method:"POST",headers:{apikey:dbKey,Authorization:"Bearer "+dbKey,"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=minimal"},
   body:JSON.stringify([{id:"primary",encrypted_tokens:value,updated_at:new Date().toISOString()}]),cache:"no-store"
  });
  if(!stored.ok)return fail("database_write_failed");
  const response=NextResponse.redirect(origin+"/?twitch=connected");
  response.cookies.delete("twitch_oauth_state");
  response.cookies.delete("twitch_oauth_link");
  return response;
 }catch{return fail("connection_failed")}
}
