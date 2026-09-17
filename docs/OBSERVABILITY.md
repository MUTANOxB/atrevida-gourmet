# Observabilidade e monitoramento

## Endpoints

- `GET /health`: liveness do processo; não consulta dependências.
- `GET /ready`: readiness do Supabase; retorna somente `ok` e o nome do
  serviço, usa `no-store` e responde `503` quando a dependência falha.

Monitore externamente `/health` a cada 30 segundos e `/ready` a cada 60
segundos. Alerte por falhas consecutivas, não por uma única perda transitória.

## Métricas recomendadas

- latência e taxa de `2xx`, `4xx`, `429` e `5xx` por rota normalizada;
- duração e quantidade de conexões SSE;
- falhas de inscrição Realtime e reconexões;
- falhas de Auth, Storage e PostgREST;
- pedidos criados, cancelados e parados por status, sem dados pessoais;
- uso de CPU, memória, event loop e reinícios do processo;
- volume do banco e do bucket.

## Logs

O logger registra método, URL com tracking token redigido, IP e status. Não
registra payload completo. Authorization, cookies, idempotency key, senha,
tokens, nome/telefone do cliente, endereço e `Set-Cookie` estão na lista de
redaction.

Não envie corpos de checkout, headers de autenticação ou consultas com PII ao
CDN, APM, analytics ou error tracker. Restrinja acesso e retenção dos logs e
defina o prazo conforme a necessidade operacional e a política de privacidade.

## Alertas mínimos

- `/ready` falhando por 3 minutos;
- aumento sustentado de `5xx`;
- pico de `429` em checkout ou login;
- falha contínua do canal Realtime;
- crescimento anormal de pedidos pendentes;
- upload/Storage com falhas repetidas;
- alteração administrativa fora do padrão em `admin_audit_log`.
