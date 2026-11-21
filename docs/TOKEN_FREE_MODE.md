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
