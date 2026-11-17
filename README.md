# GTA Viral Radar — V1
Painel privado Next.js para monitorar vídeos internacionais de GTA VI, identificar tendências e preparar roteiros originais.

## Implementado
- Autenticação de administrador por senha de ambiente e cookie assinado.
- Radar com busca, filtros, scores, fontes e métricas.
- YouTube Data API v3; sem chave, exibe exemplos com aviso de demonstração.
- Geração de roteiro por OpenAI; sem chave, gera apenas modelo sinalizado.
- Persistência opcional Supabase via REST e schema SQL.
- Endpoint protegido /api/cron/discover para coletor agendado.
- Estúdio, histórico editorial e visão de analytics básica.

## Não implementado
Renderização de vídeo, postagem automática, OAuth de redes sociais, medição do próprio perfil ou validação do build em CI.

## Executar
1. `npm install`
2. Copie `.env.example` para `.env.local`.
3. Configure `ADMIN_PASSWORD` e `SESSION_SECRET` com pelo menos 32 caracteres no segundo.
4. `npm run dev`; acesse `http://localhost:3000`.
5. Para fontes reais: `YOUTUBE_API_KEY`.
6. Para persistência: rode `supabase/schema.sql` e configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
7. Para roteiros IA: `OPENAI_API_KEY`.
8. Antes de agendar a coleta, configure `CRON_SECRET` e a API do YouTube + Supabase.
9. Execute `npm run typecheck && npm run build`.

**Segurança:** nunca commitar segredos. Repositório é público; use variáveis protegidas no provedor. Não há publicação automática nem deploy de produção configurados. Revisão editorial e direitos de uso são obrigatórios.
