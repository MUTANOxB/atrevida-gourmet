# Checklist de Segurança antes do Deploy

## Segredos

- [ ] `.env` não está no Git.
- [ ] `SUPABASE_SECRET_KEY` existe apenas no backend/secret manager.
- [ ] chave legada `SUPABASE_SERVICE_ROLE_KEY`, se necessária, existe apenas no backend.
- [ ] nenhum token aparece em HTML/JS público.
- [ ] chaves de teste e produção são separadas.
- [ ] secrets foram configurados no provedor.

## Banco

- [ ] RLS está habilitado.
- [ ] migrations `001` até `006` aparecem no histórico remoto.
- [ ] `anon` não tem acesso direto a `orders`.
- [ ] `anon` não tem acesso direto a `order_items`.
- [ ] `authenticated` não tem grants comerciais diretos.
- [ ] backups automáticos estão ativos.
- [ ] restauração de backup já foi testada.
- [ ] objetos do Storage possuem backup separado do banco.

## Backend

- [ ] HTTPS obrigatório.
- [ ] CORS contém apenas domínios reais.
- [ ] CORS `*` NÃO é usado.
- [ ] bodyLimit está configurado.
- [ ] Helmet está ativo.
- [ ] rate limit está ativo.
- [ ] endpoint de criação de pedido tem limite próprio.
- [ ] preços são recalculados no servidor.
- [ ] opções/adicionais são validados no servidor.
- [ ] zona/taxa de entrega é validada no servidor.
- [ ] stack trace não é devolvido ao cliente.
- [ ] Authorization/cookies são redigidos dos logs.
- [ ] admin exige Supabase Auth.
- [ ] cada admin possui sua própria conta.
- [ ] `/health` e `/ready` foram configurados no monitoramento.
- [ ] encerramento por SIGTERM foi validado sem conexões órfãs.

## Checkout

- [ ] `Idempotency-Key` é enviado em cada checkout.
- [ ] replay de pedido é bloqueado.
- [ ] não existe confiança no `total` vindo do frontend.
- [ ] produto inativo não pode ser comprado.
- [ ] produto sem preço não pode ser comprado.
- [ ] quantidade tem limite.
- [ ] tamanho da observação tem limite.

## Frontend

- [ ] headers de segurança estão configurados.
- [ ] CSP está ativa.
- [ ] clickjacking bloqueado.
- [ ] nenhuma informação sensível está em `localStorage`.
- [ ] tokens administrativos NÃO ficam em `localStorage`.
- [ ] build público não contém `.env`, `.map`, SQL ou chave privada.
- [ ] admin e cliente são aplicações/rotas separadas.
- [ ] dependências externas desnecessárias foram removidas.

## Admin

- [ ] MFA está ativado para contas administrativas.
- [ ] senha forte e única.
- [ ] sessão expira.
- [ ] logout invalida sessão.
- [ ] ações importantes geram auditoria.
- [ ] acesso de ex-funcionário pode ser revogado imediatamente.

## LGPD / Privacidade

- [ ] coletar somente dados necessários.
- [ ] definir prazo de retenção.
- [ ] possuir política de privacidade.
- [ ] dados de clientes não aparecem em URL.
- [ ] dados pessoais não entram em logs de analytics.
- [ ] exportação de pedidos exige autenticação.

## Testes

- [ ] `npm audit` sem vulnerabilidade crítica/alta não tratada.
- [ ] scanner de segredos executado.
- [ ] teste de autorização em `/api/admin/*`.
- [ ] teste de rate limit.
- [ ] teste de pedido com preço adulterado.
- [ ] teste de produto de outra loja.
- [ ] teste de option ID de outro produto.
- [ ] teste de tracking token aleatório.
- [ ] replay e checkout concorrente retornam um único pedido.
- [ ] upload falso/SVG/HTML/executável/oversize foi rejeitado.
- [ ] isolamento entre lojas foi validado para pedido, tracking, SSE e Storage.
- [ ] fluxo remoto pedido -> painel -> status -> tracking passou sem refresh.

## Borda

- [ ] DNS está proxied pela Cloudflare e a origem não é acessível diretamente.
- [ ] SSL/TLS está em `Full (strict)`, TLS mínimo 1.2 e Always Use HTTPS ativo.
- [ ] WAF/DDoS e limites de checkout/login estão ativos.
- [ ] cache está restrito a assets; `/api/*`, `/admin/*` e SSE usam bypass.
- [ ] regras de borda não desafiam, transformam ou interrompem SSE.
