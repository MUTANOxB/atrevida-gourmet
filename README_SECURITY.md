# Atrevida Delivery — Security Pack

Este pacote foi feito para ser aplicado sobre o frontend/backend do projeto.

## Objetivo

Reduzir fortemente o risco de:

- vazamento de chaves;
- acesso direto ao banco;
- abuso da API;
- scraping agressivo;
- brute force;
- XSS;
- clickjacking;
- MIME sniffing;
- CSRF em fluxos futuros com cookies;
- exposição de stack traces;
- logs com dados pessoais;
- pedidos duplicados/replay;
- dependências vulneráveis;
- deploy acidental com `.env`.

## Importante

Nenhum sistema conectado à internet pode ser considerado "impossível de vazar".

O alvo deste pacote é:

1. **não expor segredos no frontend**;
2. **não permitir acesso direto público ao banco**;
3. **validar todo pedido no servidor**;
4. **limitar abuso**;
5. **registrar o mínimo de dados sensíveis possível**;
6. **detectar falhas antes do deploy**;
7. **ter um plano para reagir rápido**.

## Ordem de aplicação

1. Copiar os arquivos de `backend/` para o backend.
2. Instalar dependências de segurança.
3. Rodar a migration `002_security_hardening.sql`.
4. Aplicar os headers do frontend.
5. Configurar variáveis de ambiente SOMENTE no provedor de hospedagem.
6. Rodar `scripts/security-check.sh`.
7. Executar o checklist em `docs/DEPLOY_SECURITY_CHECKLIST.md`.

## Dependências adicionais do backend

```bash
npm install @fastify/helmet @fastify/rate-limit
```

## Regras que não podem ser quebradas

- Nunca colocar `SUPABASE_SERVICE_ROLE_KEY` no frontend.
- Nunca subir `.env` para Git.
- Nunca confiar em preço/total enviado pelo navegador.
- Nunca dar `SELECT/INSERT/UPDATE/DELETE` direto para `anon` nas tabelas de pedidos.
- Nunca logar `Authorization`, cookies, chaves ou payloads completos de checkout.
- Nunca usar CORS `*` em produção.
- Nunca usar senha compartilhada para painel admin.
- Nunca colocar tokens de admin em `localStorage`.
