# Atrevida Gourmet Delivery

Delivery próprio white-label com frontend HTML/CSS/JavaScript e backend
Node.js, TypeScript, Fastify e Supabase. O navegador acessa dados operacionais
somente por `/api/*`; chaves privilegiadas permanecem no backend.

## Requisitos

- Node.js 20+
- npm
- projeto Supabase para Auth, PostgreSQL, Realtime e Storage
- Supabase CLI para aplicar migrations remotas

## Instalação

```bash
npm ci
cp backend/.env.example backend/.env
npm run dev
```

O servidor de desenvolvimento gera o frontend, inicia o Fastify e publica a
aplicação em `http://127.0.0.1:3333` por padrão.

## Ambiente

Preencha `backend/.env` sem versioná-lo:

| Variável | Uso |
| --- | --- |
| `SUPABASE_URL` | URL HTTPS do projeto |
| `SUPABASE_ANON_KEY` | chave pública usada pelo backend somente para Auth |
| `SUPABASE_SECRET_KEY` | chave secreta exclusiva do backend |
| `FRONTEND_ORIGIN` | origens explícitas separadas por vírgula; nunca `*` |
| `PRODUCT_IMAGE_BUCKET` | `product-images` |
| `DEFAULT_STORE_SLUG` | loja padrão |
| `TRUST_PROXY` | `true` apenas atrás de proxy confiável |
| `SERVE_STATIC` | servir o build pelo Fastify |

`SUPABASE_SERVICE_ROLE_KEY` existe apenas como compatibilidade para projetos
legados. Prefira `SUPABASE_SECRET_KEY`. Consulte
[SUPABASE_REMOTE_CHECKLIST.md](docs/SUPABASE_REMOTE_CHECKLIST.md).

## Banco e migrations

```bash
cd backend
supabase login
supabase link --project-ref SEU_PROJECT_REF
supabase db push --dry-run
supabase db push
```

As migrations ficam em `backend/supabase/migrations` e devem ser aplicadas em
ordem. Nunca use `db reset --linked` em produção e não aplique o seed comercial
em produção.

## Primeiro administrador

1. Crie uma conta individual em Supabase Auth.
2. Obtenha os UUIDs do usuário e da loja.
3. Insira o vínculo em `store_members` com papel `owner`, `manager` ou `staff`.
4. Ative MFA para `owner` e `manager`.

```sql
insert into public.store_members (store_id, user_id, role)
values ('UUID_DA_LOJA', 'UUID_DO_USUARIO', 'owner');
```

Nunca compartilhe contas administrativas.

## Comandos de validação

```bash
npm run typecheck
npm test
npm run test:frontend
npm run test:scanner
npm run build
npm run scan:build
npm run check
```

O build público é gerado em `dist/`; o backend compilado fica em
`backend/dist/`. Source maps de produção permanecem desabilitados.

## Produção

```bash
docker build -t atrevida-delivery .
docker run --env-file backend/.env -p 3333:3333 atrevida-delivery
```

Topologia recomendada: `Internet -> CDN/WAF -> Fastify -> Supabase`. Use
Cloudflare Tunnel ou restrinja a origem aos IPs da Cloudflare, TLS `Full
(strict)`, cache apenas para assets e bypass para `/api/*` e `/admin/*`.

- [Cloudflare e borda](docs/CLOUDFLARE_PRODUCTION.md)
- [Checklist de deploy](docs/DEPLOY_SECURITY_CHECKLIST.md)
- [Backup e recuperação](docs/BACKUP_RECOVERY.md)
- [Observabilidade](docs/OBSERVABILITY.md)
- [Resposta a incidente](docs/INCIDENT_RESPONSE.md)
- [Teste F12](docs/F12_MANUAL_TEST.md)

`GET /health` é liveness local. `GET /ready` verifica acesso ao Supabase e deve
ser usado para alerta/readiness, sem cache.
