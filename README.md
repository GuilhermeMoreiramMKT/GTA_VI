# GTA Viral Radar — V1

Painel privado Next.js para monitorar vídeos internacionais de GTA VI, identificar tendências e preparar roteiros originais.

## Funcionalidades presentes
- Autenticação de administrador com senha por variável de ambiente e cookie HttpOnly.
- Radar com busca, filtros, score heurístico, fontes e métricas.
- YouTube Data API v3. Sem chave, são exibidos exemplos explicitamente demonstrativos.
- Geração de roteiro via OpenAI. Sem chave, retorna apenas um rascunho de demonstração.
- Persistência opcional em Supabase via REST e schema SQL.
- Endpoint protegido `/api/cron/discover` para o coletor.
- Estúdio, histórico editorial e visão inicial de analytics.

## Deploy Preview — Vercel
- **Framework Preset:** Next.js
- **Root Directory:** raiz do repositório (`./`).
- **Output Directory:** sem override (não definir `public`, `out` nem `.next`).
- **Build Command e Install Command:** usar os padrões do framework.
- **Branch de desenvolvimento:** `feature/gta-viral-radar-v1`.
- Uma atualização desta branch deve disparar um deployment de **Preview** se a integração Git estiver habilitada.
- A branch `main` não deve ser publicada com esta V1 antes de revisão.

### Variáveis necessárias para ativar o login
Configure no ambiente **Preview** da Vercel:
- `ADMIN_PASSWORD`: senha forte de administrador.
- `SESSION_SECRET`: segredo aleatório com no mínimo 32 caracteres.

O aplicativo exibe uma tela de configuração enquanto essas variáveis estiverem ausentes. Configure as credenciais **na Vercel, nunca em commits**.

### Integrações opcionais
- `YOUTUBE_API_KEY` — tendências reais.
- `OPENAI_API_KEY` e `OPENAI_MODEL` — geração de roteiros com IA.
- `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` — persistência após executar `supabase/schema.sql`.
- `CRON_SECRET` — autenticação do coletor programático.

## Executar localmente
1. `npm install`
2. Copie `.env.example` para `.env.local`.
3. Preencha `ADMIN_PASSWORD` e `SESSION_SECRET`.
4. `npm run typecheck && npm run build`
5. `npm run dev` e abra `http://localhost:3000`.

## Estado e limitações
O workflow GitHub Actions já concluiu o typecheck e o build da V1 com sucesso na branch de desenvolvimento. Renderização de vídeo, publicação automática e OAuth de redes sociais ainda não foram implementados. O sistema não verifica automaticamente direitos autorais ou a veracidade de todos os conteúdos; mantenha revisão editorial.

**Segurança:** o repositório é público. Não commitar tokens, senhas ou segredos. Implantar apenas como Preview até concluir testes de acesso e integrações.
