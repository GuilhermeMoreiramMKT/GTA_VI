# GTA Viral Radar V2
Configuração: 60 minutos; até 4 reservas de produção por dia (America/Sao_Paulo); score >=80; 30–45 segundos; Instagram e TikTok; modo automático após habilitação explícita. Nenhuma postagem real durante os testes.

## Instalação
1. Use banco Supabase isolado para Preview. Execute supabase/schema.sql e supabase/automation_v2.sql no SQL Editor.
2. Crie bucket público radar-videos exclusivamente para vídeos finais autorizados; nunca exponha mídia bruta, documentos de licença ou segredos. Configure retenção adequada à agenda.
3. Configure YOUTUBE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e CRON_SECRET na Vercel. Use segredo de sessão privado e aleatório, diferente daquele compartilhado em conversa.
4. Num servidor Linux com Docker, clone a branch. Crie arquivo de ambiente privado fora do Git usando worker/.env.example. Configure RADAR_URL para o ambiente correto acessível pelo worker, CRON_SECRET igual ao do painel, Supabase e OpenAI.
5. Cadastre na tabela radar_assets os registros de direitos de uso por ID real do vídeo/tendência do YouTube. Campos: trend_id, filename (arquivo local relativo a /assets), rights_ref (referência documental), authorized=true, editorial_verified=true, notes (fatos apurados), expires_at (validade), start_seconds e end_seconds (intervalo autorizado). Use apenas conteúdo próprio ou comprovadamente licenciado. A declaração do operador não é verificação jurídica automática. Não baixar vídeo do YouTube, não presumir que trailers e gameplays de terceiros sejam reutilizáveis.
6. Construa e teste:
   docker build -t gta-radar-worker worker
   docker run --rm gta-radar-worker python -m unittest -v
   docker run --rm --env-file /secure/worker.env -e RUN_ONCE=true -e ENABLE_SOCIAL_PUBLISH=false -v /secure/assets:/assets:ro gta-radar-worker
7. Revise vídeo final e fatos. Confira com documentação e conta Buffer o contrato GraphQL, permissões de publicação, formatos, rotulagem de IA e canais. Configure BUFFER_API_KEY, BUFFER_INSTAGRAM_CHANNEL e BUFFER_TIKTOK_CHANNEL (IDs distintos) e horários. Verifique validade da autorização até a postagem. Só então habilite ENABLE_SOCIAL_PUBLISH=true e execute uma réplica:
   docker run -d --restart unless-stopped --name gta-radar-worker --env-file /secure/worker.env -v /secure/assets:/assets:ro gta-radar-worker
8. Para pausar: docker stop gta-radar-worker. Posts já agendados precisam ser cancelados no Buffer.

## Limites e segurança operacional
- A fila reserva até quatro trabalhos por dia, não garante quatro postagens diárias; o horário de publicação é definido pelo Buffer.
- O worker só processa tendências recentes com mídia registrada e notas verificadas. Não baixa mídias externas.
- Clipagem inicial utiliza intervalo autorizado, corte, crop central, marca fixa, narração TTS e MP4 vertical. Seleção semântica de melhores cenas, legendas sincronizadas e análise visual ainda não implementadas.
- Duração da voz fora de 30–45s bloqueia o trabalho. Não há retry automático. Falhas de renderização ou agendamento parcial exigem reconciliação manual.
- Estado scheduled indica ID de agendamento confirmado, não publicação efetiva. Não reenviar sem conferir Buffer.
- Renderizações feitas com envio desativado não são reagendadas automaticamente.
- O worker não está hospedado pela Vercel. A frequência de 60 min depende de servidor ligado e APIs configuradas. Um ciclo demorado pode atrasar o próximo.
- O painel exibe fila e parâmetros fixos; ainda não permite alterar regras, cadastrar mídias ou ativar o worker pelo navegador.
- A API do Buffer precisa ser validada com credenciais reais e schema vigente; postagem real permanece desabilitada por padrão.
- Não usar segredos em commits. Não ativar produção enquanto testes e revisão de direitos estiverem incompletos.
