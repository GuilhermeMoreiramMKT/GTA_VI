import type {Trend} from "./radar";

export type EditorialDraft = {title:string;script:string;caption:string;mode:"local"|"ai";reviewRequired:boolean};

/** No model or external API needed. Never present unverified metadata as fact. */
export function localDraft(trend:Trend):EditorialDraft {
  const title=trend.title.trim().slice(0,120);
  const source=trend.url;
  const topic=trend.category==="Curiosidades"?"detalhes e possíveis descobertas":trend.category==="Comparativo"?"comparações e diferenças":"novidades e discussões";
  return {
    title:"GTA VI: "+title,
    script:[
      "GANCHO: Uma discussão sobre GTA VI chamou atenção: "+title+".",
      "CONTEXTO: O vídeo da fonte aborda "+topic+".",
      "ANÁLISE: Confira a fonte original e identifique o que foi confirmado, o que é especulação e o que merece uma comparação própria.",
      "FECHAMENTO: Qual detalhe você acha que merece uma investigação?",
      "NOTA EDITORIAL: Rascunho baseado apenas em título e descrição; verificar fatos, imagens e direitos antes de publicar."
    ].join("\n\n"),
    caption:"Discussão sobre GTA VI: "+title+". Confira a fonte original antes de compartilhar afirmações. Fonte: "+source+" #GTAVI #GTA6",
    mode:"local",reviewRequired:true
  };
}

export async function script(trend:Trend):Promise<EditorialDraft>{
  // Explicit opt-in only; leaving OPENAI_API_KEY configured does not incur token usage.
  if(process.env.EDITORIAL_ENGINE!=="openai" || !process.env.OPENAI_API_KEY)return localDraft(trend);
  const model=process.env.OPENAI_MODEL??"gpt-4.1-mini";
  const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+process.env.OPENAI_API_KEY},body:JSON.stringify({model,input:[{role:"system",content:"Você é editor brasileiro de jogos. Crie um roteiro ORIGINAL de 25 a 40 segundos inspirado apenas em informações verificáveis da fonte indicada. Não invente fatos; destaque incertezas; nunca copie trechos extensos. Responda em JSON com title, script, caption."},{role:"user",content:JSON.stringify({title:trend.title,description:trend.description,url:trend.url})}],text:{format:{type:"json_schema",name:"draft",strict:true,schema:{type:"object",properties:{title:{type:"string"},script:{type:"string"},caption:{type:"string"}},required:["title","script","caption"],additionalProperties:false}}}})});
  if(!r.ok)throw Error("IA: "+r.status);
  const d=await r.json();
  const output=d.output?.flatMap((x:any)=>x.content??[]).find((x:any)=>x.type==="output_text")?.text;
  if(!output)throw Error("Resposta sem texto");
  const parsed=JSON.parse(output);
  return {title:parsed.title,script:parsed.script,caption:parsed.caption,mode:"ai",reviewRequired:true};
}
