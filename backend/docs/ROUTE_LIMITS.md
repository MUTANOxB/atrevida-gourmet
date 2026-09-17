# Limites por rota

Use os limites abaixo como ponto de partida.

## GET catálogo

```ts
config: {
  rateLimit: {
    max: 60,
    timeWindow: "1 minute"
  }
}
```

## POST delivery quote

```ts
config: {
  rateLimit: {
    max: 20,
    timeWindow: "1 minute"
  }
}
```

## POST criar pedido

```ts
config: {
  rateLimit: {
    max: 5,
    timeWindow: "1 minute"
  }
},
preHandler: [
  requireJson,
  rejectOversizedOrder,
  rejectDeepJson,
  requireCheckoutHeaders,
  reserveIdempotencyKey
]
```

## GET tracking

```ts
config: {
  rateLimit: {
    max: 20,
    timeWindow: "1 minute"
  }
}
```

## Admin

```ts
config: {
  rateLimit: {
    max: 60,
    timeWindow: "1 minute"
  }
}
```

## Login próprio

Caso um endpoint próprio seja criado:

```text
5 tentativas / 15 minutos
```

Idealmente limitar por:

```text
IP + hash(normalized_email)
```

Não devolver:

```text
"usuário existe"
```

Preferir mensagem genérica:

```text
"credenciais inválidas"
```

Isso reduz enumeração de usuários.
