# Teste manual no F12 antes de publicar

Abra Chrome/Edge → F12.

## Network

Faça:

- abrir catálogo;
- adicionar produto;
- calcular entrega;
- finalizar pedido;
- acompanhar pedido.

Em CADA resposta procure por:

```text
service_role
sb_secret_
SUPABASE_SECRET_KEY
password
database
postgres://
customer_phone de terceiros
delivery_street de terceiros
store_members
user_id administrativo
```

Nenhum deve aparecer.

## Application

Verifique:

- Local Storage
- Session Storage
- IndexedDB
- Cookies

Nunca deve existir:

- senha;
- token admin em Web Storage;
- secret key;
- connection string;
- dados de outros clientes.

Sessão administrativa deve preferir:

```text
HttpOnly
Secure
SameSite=Strict
```

## Sources

Pesquise globalmente por:

```text
secret
service_role
password
postgres
SUPABASE
JWT_SECRET
```

Procure arquivos:

```text
*.map
```

Build público não deve conter source maps.

## Erros

Provoque:

- JSON inválido;
- ID inválido;
- 404;
- 500 controlado;
- produto inexistente.

A resposta NÃO deve conter:

- stack trace;
- path local do servidor;
- query SQL;
- nome interno de tabela desnecessário;
- credencial;
- erro bruto do Supabase/Postgres.
