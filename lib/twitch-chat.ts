/** Token-free Twitch chat signal analysis. Feed this module timestamped chat messages
 * from an authorized Twitch chat subscription; it does not connect to Twitch itself. */
export type ChatMessage={timestamp:string;userId:string;text:string};
export type ChatMoment={start:string;end:string;score:number;messages:number;uniqueChatters:number;peakPerMinute:number;reactions:string[];reason:string};
const reactions:Record<string,RegExp>={
 surprise:/\b(?:omg|wtf|nossa|caraca|mano|meu deus|mds|impossivel|insano|que isso|no way)\b/i,
 laughter:/\b(?:kkkk+|rsrs+|hahaha+|lol|lmao|morri)\b/i,
 hype:/\b(?:clipa|clip|corta|corte|salva|pog|poggers|crazy|absurdo|historico|recorde)\b/i
};
export function analyzeChat(messages:ChatMessage[],windowEnd:Date=new Date()):ChatMoment[]{
 const end=windowEnd.getTime(),start=end-600_000;
 const valid=messages.filter(m=>Number.isFinite(Date.parse(m.timestamp))&&Date.parse(m.timestamp)>=start&&Date.parse(m.timestamp)<end&&m.text.length<=500);
 const buckets=Array.from({length:10},(_,i)=>({minute:i,messages:[] as ChatMessage[]}));
 for(const m of valid){const index=Math.floor((Date.parse(m.timestamp)-start)/60_000);if(index>=0&&index<10)buckets[index].messages.push(m)}
 const counts=buckets.map(b=>b.messages.length);
 const sorted=[...counts].sort((a,b)=>a-b);
 const baseline=Math.max(1,(sorted[2]+sorted[3]+sorted[4]+sorted[5]+sorted[6])/5);
 const result:ChatMoment[]=[];
 for(let i=0;i<10;i++){
  const group=buckets[i].messages;if(group.length<8)continue;
  const unique=new Set(group.map(m=>m.userId)).size;
  const diversity=unique/group.length;
  const detected=Object.entries(reactions).filter(([,pattern])=>group.some(m=>pattern.test(m.text))).map(([name])=>name);
  const signal=group.filter(m=>Object.values(reactions).some(pattern=>pattern.test(m.text))).length;
  const rate=group.length/baseline;
  const score=Math.min(100,Math.round(Math.min(50,Math.max(0,rate-1)*20)+Math.min(25,signal/group.length*100)+Math.min(25,diversity*25)));
  if(score<60||diversity<0.2)continue;
  const center=start+i*60_000+30_000;
  result.push({start:new Date(center-20_000).toISOString(),end:new Date(center+20_000).toISOString(),score,messages:group.length,uniqueChatters:unique,peakPerMinute:group.length,reactions:detected,reason:"Pico de chat "+rate.toFixed(1)+"x acima da linha de base local"});
 }
 return result.sort((a,b)=>b.score-a.score);
}
