# Segurança do Painel Administrativo

## Recomendado

- Supabase Auth;
- MFA obrigatório para owner/manager;
- conta individual por funcionário;
- RBAC por `store_members.role`;
- sessão curta;
- reautenticação para ações críticas;
- logout em todos os dispositivos;
- registro de auditoria.

## Não fazer

- senha única compartilhada pela loja;
- URL secreta como única proteção;
- token admin em `localStorage`;
- login sem rate limit;
- painel acessível sem HTTPS;
- usar CPF/telefone como senha.

## Auditoria futura

Criar tabela:

```sql
admin_audit_log (
  id uuid,
  store_id uuid,
  user_id uuid,
  action text,
  target_type text,
  target_id uuid,
  metadata jsonb,
  ip inet,
  created_at timestamptz
)
```

Registrar:

- login;
- alteração de preço;
- exclusão/desativação de produto;
- mudança de taxa;
- cancelamento de pedido;
- exportação de dados;
- criação/remoção de administrador.
