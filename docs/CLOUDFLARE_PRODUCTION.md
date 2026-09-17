# Cloudflare na frente da aplicação

Este arquivo descreve a proteção de borda. Ele não substitui os limites e as
validações do Fastify.

## Topologia

```text
Internet -> Cloudflare (DNS/CDN/WAF) -> Fastify -> Supabase
```

Preferir uma destas opções para impedir acesso direto à origem:

1. Cloudflare Tunnel, sem porta pública de entrada; ou
2. firewall da origem aceitando somente os intervalos oficiais da Cloudflare,
   com IP da origem rotacionado depois da ativação do proxy.

Usar HTTPS de ponta a ponta. Quando houver uma origem HTTPS pública, selecionar
`Full (strict)` e instalar certificado válido/Origin CA. Nunca usar `Flexible`.

Configurar também:

- Always Use HTTPS;
- versão mínima TLS 1.2 e TLS 1.3 habilitado;
- Managed Rules e proteção DDoS da zona;
- origem sem acesso público direto, preferencialmente via Tunnel;
- `FRONTEND_ORIGIN` com o hostname HTTPS exato.

## Regras de rate limit

Criar regras por `ip.src`, com ação de bloqueio temporário ou managed challenge.
Os números abaixo espelham a proteção da aplicação:

| Escopo | Expressão Cloudflare | Limite |
| --- | --- | ---: |
| Checkout | `http.request.method eq "POST" and http.request.uri.path eq "/api/public/orders"` | 5/min/IP |
| Cotação | `http.request.method eq "POST" and http.request.uri.path eq "/api/public/delivery/quote"` | 20/min/IP |
| Tracking | `http.request.method eq "GET" and starts_with(http.request.uri.path, "/api/public/orders/") and not ends_with(http.request.uri.path, "/events")` | 20/min/IP |
| Login | `http.request.method eq "POST" and http.request.uri.path in {"/api/admin/auth/login" "/api/admin/session"}` | 5/min/IP |
| Admin | `starts_with(http.request.uri.path, "/api/admin/") and http.request.uri.path ne "/api/admin/events"` | 60/min/IP |

Contar por IP. Usar bloqueio temporário para APIs; desafios interativos em
`fetch` podem quebrar o checkout. Não elevar esses limites na borda sem revisar
os equivalentes no backend. Os limites Fastify continuam obrigatórios.

## Cache e streaming

- Não armazenar em cache `/api/admin/*`, tracking, checkout, cotação ou SSE.
- Criar Cache Rule `starts_with(http.request.uri.path, "/api/")` com **Bypass
  cache**. Criar outra para `starts_with(http.request.uri.path, "/admin/")` com
  bypass. Deixe essas regras por último quando houver regras conflitantes.
- Respeitar `Cache-Control: no-store` enviado pela aplicação.
- Não aplicar transformação/minificação a respostas `text/event-stream`.
- Excluir `/api/admin/events` e caminhos terminados em `/events` das regras de
  rate limit comuns. Não criar cache, challenge ou buffering específico nessas
  rotas; o backend limita conexões, envia heartbeat e força reconexão periódica.
- O catálogo pode receber cache curto somente depois de validar a invalidação de
  preço, disponibilidade e estado aberto/fechado. O padrão seguro é não cachear.
- Apenas `/assets/*` pode ser elegível para cache, respeitando o Cache-Control
  da origem. Os HTMLs devem revalidar.

## Origem e IP real

- Configure `TRUST_PROXY` somente quando a origem estiver efetivamente isolada
  atrás do proxy. O padrão da aplicação é não confiar em cabeçalhos encaminhados.
- Se o provedor adicionar outro proxy antes do Fastify, configure a quantidade
  ou a lista de proxies confiáveis explicitamente; não aceite qualquer
  `X-Forwarded-For` da internet.
- Teste que a origem não responde pelo IP/hostname interno depois da publicação.

## Checklist de ativação

- [ ] DNS está com proxy ativo.
- [ ] HTTPS está em `Full (strict)` ou o tráfego usa Tunnel.
- [ ] TLS mínimo 1.2 e TLS 1.3 estão ativos.
- [ ] WAF Managed Rules e DDoS estão ativos.
- [ ] origem não é acessível diretamente.
- [ ] regras de rate limit foram testadas sem bloquear assets.
- [ ] `/api/*` sensível e SSE não entram no cache.
- [ ] SSE permanece conectado por mais de um heartbeat e reconecta sem challenge.
- [ ] domínio HTTPS exato está em `FRONTEND_ORIGIN` (nunca `*`).
- [ ] logs do WAF não armazenam corpo de checkout ou credenciais.
- [ ] health check usa `/health` sem expor configuração.
