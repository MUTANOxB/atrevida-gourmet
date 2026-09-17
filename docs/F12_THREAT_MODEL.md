# F12 / DevTools — Modelo de Ameaça

## O atacante consegue ver

No próprio navegador:

### Sources
- JavaScript;
- HTML;
- CSS;
- arquivos estáticos;
- source maps se existirem.

### Network
- URL;
- método HTTP;
- headers enviados pelo browser;
- request body;
- response body;
- status;
- timings.

### Application
- localStorage;
- sessionStorage;
- IndexedDB;
- cookies não-HttpOnly;
- cache.

## Portanto, nunca dependa de segredo no navegador

Errado:

```js
const ADMIN_PASSWORD = "123456";
const SERVICE_ROLE = "...";
```

Errado:

```js
fetch("/api/admin/orders?secret=minha-chave")
```

Errado:

```js
const orders = await api.getAllOrders();
renderOnlyMyOrder(orders);
```

Neste último caso, o frontend esconde os outros pedidos visualmente,
mas TODOS já chegaram ao navegador.

Certo:

```text
GET /api/public/orders/{opaqueTrackingToken}

resposta:
somente os campos daquele pedido permitidos ao cliente
```

## Endpoint visível não é vulnerabilidade

`/api/public/orders`

ser visível no Network é normal.

A proteção está em:

- autorização;
- validação;
- rate limiting;
- DTO;
- RLS;
- token não previsível;
- server-side business logic.

## IDs visíveis

UUID de produto pode ser público.

Não use conhecimento do ID como autorização.

Exemplo:

```text
produtoId = conhecido
```

isso NÃO significa:

```text
usuário pode editar produto
```

Rotas de edição devem verificar usuário + loja + permissão no servidor.

## Source maps

Em produção pública:

```text
app.js.map
```

pode facilitar muito a análise do código original.

Por isso o build deste projeto deve:

```text
sourcemap = false
```

e CI deve falhar se `.map` aparecer no artefato público.
