// Twitch EventSub WebSocket collector. Runs for up to 8 minutes in GitHub Actions.
// Never logs OAuth tokens or chat text. Requires a valid user:read:chat OAuth grant.
const base=process.env.RADAR_BASE_URL?.replace(/\/$/,"");
const secret=process.env.CRON_SECRET;
if(!base?.startsWith("https://")||!secret)throw Error("RADAR_BASE_URL/CRON_SECRET missing");
const headers={Authorization:"Bearer "+secret};
async function api(path,options={}){const r=await fetch(base+path,{...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error(path+" HTTP "+r.status+" "+(await r.text()).slice(0,300));return r.json()}
const config=await api("/api/cron/twitch/bootstrap");
if(!config.scopes?.includes("user:read:chat"))throw Error("Twitch authorization missing user:read:chat");
const channels=config.channels.slice(0,10);
if(!channels.length){console.log("No recently discovered live channels; exiting");process.exit(0)}
const messages=new Map(channels.map(c=>[c.user_id,[]]));
let ws,connected=false,subscriptions=0;
const endAt=Date.now()+8*60*1000;
async function subscribe(sessionId){
 for(const channel of channels){
  const payload={type:"channel.chat.message",version:"1",condition:{broadcaster_user_id:channel.user_id,user_id:config.userId},transport:{method:"websocket",session_id:sessionId}};
  const r=await fetch("https://api.twitch.tv/helix/eventsub/subscriptions",{method:"POST",headers:{"Client-Id":config.clientId,Authorization:"Bearer "+config.token,"Content-Type":"application/json"},body:JSON.stringify(payload)});
  if(r.ok){subscriptions++;console.log("Subscribed:",channel.user_login)}
  else{const body=await r.text();console.error("Subscription rejected for",channel.user_login,"status",r.status,body.slice(0,250))}
 }
}
async function flush(){
 for(const channel of channels){
  const queue=messages.get(channel.user_id);
  if(!queue?.length)continue;
  const batch=queue.splice(0,queue.length);
  try{const r=await api("/api/cron/twitch/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({channel:channel.user_login,messages:batch})});console.log("Analyzed",channel.user_login,batch.length,"moments",r.moments)}
  catch(e){console.error("Analysis failed",channel.user_login,String(e))}
 }
}
let flushing=false;
async function safeFlush(){if(flushing)return;flushing=true;try{await flush()}finally{flushing=false}}
function connect(url){
 ws=new WebSocket(url);
 ws.addEventListener("open",()=>{connected=true;console.log("EventSub socket opened")});
 ws.addEventListener("message",async e=>{
  try{
   const packet=JSON.parse(e.data);
   if(packet.metadata?.message_type==="session_welcome")await subscribe(packet.payload.session.id);
   if(packet.metadata?.message_type==="session_reconnect"){console.log("Twitch requested reconnect");ws.close();connect(packet.payload.session.reconnect_url)}
   if(packet.metadata?.message_type==="notification"){
    const event=packet.payload.event;
    const queue=messages.get(event.broadcaster_user_id);
    if(queue)queue.push({timestamp:packet.metadata.message_timestamp??new Date().toISOString(),userId:event.chatter_user_id,text:event.message?.text??""});
   }
  }catch(err){console.error("EventSub message error",String(err))}
 });
 ws.addEventListener("error",()=>console.error("EventSub WebSocket error"));
 ws.addEventListener("close",()=>{connected=false;console.log("EventSub socket closed")});
}
connect("wss://eventsub.wss.twitch.tv/ws");
const interval=setInterval(()=>{safeFlush().catch(e=>console.error(String(e)))},60_000);
while(Date.now()<endAt){await new Promise(resolve=>setTimeout(resolve,5000));if(!connected&&Date.now()<endAt-30_000){console.log("WebSocket disconnected; retrying");connect("wss://eventsub.wss.twitch.tv/ws")}}
clearInterval(interval);ws?.close();await safeFlush();console.log("Collector finished; subscriptions",subscriptions);
if(!subscriptions)process.exitCode=1;
