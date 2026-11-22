import {createDecipheriv,createCipheriv,createHash,randomBytes} from "node:crypto";
type TwitchTokens={access_token:string;refresh_token:string;expires_at:number};
function config(){const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY,secret=process.env.SESSION_SECRET;if(!url||!key||!secret)throw Error("Twitch persistence not configured");return {url:url.replace(/\/$/,""),key,cryptoKey:createHash("sha256").update(secret+":twitch").digest()}}
async function database(path:string,init:RequestInit={}){const c=config();const r=await fetch(c.url+"/rest/v1/"+path,{...init,headers:{apikey:c.key,Authorization:"Bearer "+c.key,"Content-Type":"application/json",...(init.headers??{})},cache:"no-store"});if(!r.ok)throw Error("Twitch database "+r.status);{const body=await r.text();if(!body.trim())return [];try{return JSON.parse(body)}catch{throw Error("Twitch database returned invalid JSON")}}}
function decrypt(value:string):TwitchTokens{const c=config();const raw=Buffer.from(value,"base64url");const decipher=createDecipheriv("aes-256-gcm",c.cryptoKey,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString("utf8"))}
function encrypt(tokens:TwitchTokens){const c=config();const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",c.cryptoKey,iv);const body=Buffer.concat([cipher.update(JSON.stringify(tokens),"utf8"),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString("base64url")}
export async function getTwitchToken():Promise<string|null>{
 const rows=await database("twitch_connections?select=encrypted_tokens&id=eq.primary&limit=1") as {encrypted_tokens:string}[];
 if(!rows.length)return null;
 const tokens=decrypt(rows[0].encrypted_tokens);
 if(tokens.expires_at>Date.now()+120000)return tokens.access_token;
 const clientId=process.env.TWITCH_CLIENT_ID,clientSecret=process.env.TWITCH_CLIENT_SECRET;
 if(!clientId||!clientSecret)throw Error("Twitch client credentials missing");
 const params=new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:"refresh_token",refresh_token:tokens.refresh_token});
 const r=await fetch("https://id.twitch.tv/oauth2/token",{method:"POST",body:params,cache:"no-store"});
 if(!r.ok)throw Error("Twitch refresh "+r.status);
 const raw=await r.text();if(!raw.trim())throw Error("Twitch refresh returned an empty response");let data;try{data=JSON.parse(raw)}catch{throw Error("Twitch refresh returned invalid JSON")}
 const refreshed:TwitchTokens={access_token:data.access_token,refresh_token:data.refresh_token??tokens.refresh_token,expires_at:Date.now()+Number(data.expires_in??3600)*1000};
 await database("twitch_connections?on_conflict=id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify([{id:"primary",encrypted_tokens:encrypt(refreshed),updated_at:new Date().toISOString()}])});
 return refreshed.access_token;
}
