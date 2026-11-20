"use client";
import{useEffect,useState}from"react";
type Job={id:string;title:string;score:number;status:string;target_day:string;instagram_id:string|null;tiktok_id:string|null;error:string|null};
export default function Automation(){
 const[data,setData]=useState<{ready:boolean;jobs:Job[];error?:string}|null>(null);
 const[loading,setLoading]=useState(false);
 async function refresh(){setLoading(true);try{const r=await fetch("/api/automation",{cache:"no-store"});if(!r.ok)throw Error();setData(await r.json())}catch{setData({ready:false,jobs:[],error:"Não foi possível consultar a fila."})}finally{setLoading(false)}}
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),30000);return()=>clearInterval(timer)},[]);
 return <><div className="heading"><div><span className="eyebrow">OPERAÇÃO AUTOMÁTICA V2</span><h1>Produção e distribuição<span className="accent">.</span></h1><p>Fila persistente de vídeos originais e agendamentos.</p></div><button className="action" disabled={loading} onClick={refresh}>Atualizar fila</button></div>
 <div className="metric-grid"><div className="metric"><span>INTERVALO CONFIGURADO</span><strong>60 min</strong><small>Worker externo necessário</small></div><div className="metric"><span>LIMITE / DIA DE PRODUÇÃO</span><strong>4</strong><small>Score mínimo: 80</small></div><div className="metric"><span>FORMATO</span><strong>9:16</strong><small>30–45 s · Instagram / TikTok</small></div></div>
 <div className="panel settings"><h2>Modo automático solicitado</h2><p>A fila conectada não confirma que o worker esteja ativo. O agendamento depende de mídia autorizada e contas conectadas.</p><p>{data?.ready?"Banco da fila conectado":data?.error??"Verificando banco..."}</p></div>
 <div className="panel"><div className="panelhead"><h2>Fila de produção</h2></div>{!data?.jobs.length?<div className="empty">Nenhum trabalho registrado.</div>:data.jobs.map(j=><article key={j.id} className="trend"><div className="rank"><span>{j.score}</span><small>SCORE</small></div><div className="trend-info"><h3>{j.title}</h3><p>{j.target_day} · {j.status} · Instagram: {j.instagram_id?"agendado":"não confirmado"} · TikTok: {j.tiktok_id?"agendado":"não confirmado"}</p>{j.error&&<p>{j.error}</p>}</div></article>)}</div></>
}
