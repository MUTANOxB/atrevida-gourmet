# Backend Fastify

Backend privado do delivery. Ele concentra Auth, RBAC, catálogo, checkout,
tracking, administração, horários, upload para Storage e relay Realtime por
SSE. O frontend nunca recebe a chave secreta do Supabase.

## Desenvolvimento

```bash
cp .env.example .env
npm ci
npm run dev
```

## Scripts

```bash
npm run typecheck
npm test
npm run build
npm start
```

## Supabase

As migrations estão em `supabase/migrations` e os testes SQL controlados em
`supabase/tests`. Para um projeto remoto:

```bash
supabase login
supabase link --project-ref SEU_PROJECT_REF
supabase db push --dry-run
supabase db push
```

Use uma conta Auth individual e associe-a a uma loja em `store_members`.
Papéis aceitos: `owner`, `manager` e `staff`.

Documentação operacional completa: [README principal](../README.md).
