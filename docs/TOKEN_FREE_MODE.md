# GTA Viral Radar — modo sem tokens pagos

## Ativação
O gerador editorial usa `EDITORIAL_ENGINE=local` por padrão, mesmo que `OPENAI_API_KEY` esteja presente. Não há chamadas de geração para OpenAI ou Claude no modo local. Para voltar voluntariamente à API paga, configurar `EDITORIAL_ENGINE=openai` na Vercel e fazer redeploy.

## O que funciona
- Coleta via YouTube Data API, limitada pela cota do Google.
- Score heurístico calculado sem LLM.
- Rascunho de roteiro e legenda local, **sem compreensão do áudio ou vídeo**, com aviso de revisão editorial.
- Persistência de rascunhos pelo endpoint existente.

## O que NÃO está resolvido
- O modo local não transcreve, não identifica timecodes e não seleciona melhores 30–45 segundos.
- Whisper local requer **arquivo de mídia com acesso autorizado**, CPU, memória e tempo suficientes.
- FFmpeg exige mídia autorizada; a API YouTube Data v3 não disponibiliza download dos vídeos.
- Publicação Instagram/TikTok requer integrações oficiais, contas elegíveis e autorização.
- GitHub Actions tem cotas e limites de execução; zero tokens não significa infraestrutura ilimitada.

## Próxima etapa técnica
Adicionar processamento de mídia **somente de arquivos fornecidos/autorizados**, transcrição local, extração de segmentos e edição FFmpeg em um workflow isolado. Testar com amostra curta antes de ativar qualquer rotina recorrente.

## Descoberta de streamers
A busca agora consulta dois grupos por ciclo: streamers prioritários e descoberta aberta de GTA VI. Configure na Vercel a variável opcional `RADAR_PRIORITY_CHANNELS=Coringa,Nome do Canal 2` (nomes separados por vírgula). O padrão é Coringa. Vídeos cujo nome de canal corresponda a um prioritário recebem +12 pontos no ranking (limitado a 100). O score mede popularidade e prioridade, **não** comprova a existência de um trecho viral dentro da live.

A implementação atual usa nomes de canais como heurística; para precisão contra homônimos, uma evolução deve usar IDs oficiais de canal. Busca de YouTube custa cerca de 100 unidades por chamada: duas buscas por hora consomem aproximadamente 4.800 unidades/dia, sem contar consultas de estatísticas, dentro da cota padrão de 10.000 unidades/dia caso não haja outros consumos.

Apenas a descoberta está implementada aqui; não há download, clipagem nem postagem automática.

## Twitch: detecção de momentos pelo chat (módulo inicial)
O módulo `lib/twitch-chat.ts` aceita mensagens com horário, identificador do participante e texto. Analisa os últimos dez minutos em intervalos de um minuto, compara a intensidade com uma linha de base local, mede diversidade de participantes e procura sinais de surpresa, risada e pedidos de corte. Retorna horários candidatos de 40 segundos, pontuação e justificativa. **É um detector heurístico, não uma IA que assiste ao vídeo.**

**Ainda não está conectado à Twitch**: é necessário registrar um aplicativo na Twitch, obter credenciais OAuth apropriadas, assinar eventos de chat pela API/EventSub com as permissões necessárias, executar um coletor persistente, armazenar mensagens com retenção mínima e chamar `analyzeChat` a cada dez minutos. O GitHub Actions horário não é um coletor persistente adequado para chat em tempo real. Também é preciso correlacionar o timestamp do chat com a gravação/VOD antes de gerar o corte; clips e VODs dependem de disponibilidade e permissões da plataforma. Evitar armazenar texto de chat desnecessariamente após a análise.

O score de chat não garante que o conteúdo seja relevante para GTA VI nem que o corte esteja pronto para publicar. Testar o algoritmo em chats reais, ajustar limiares por streamer e validar visualmente antes da automação de postagem.
