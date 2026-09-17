# Proteção na borda (CDN/WAF)

O backend NÃO deve ser a primeira barreira contra um ataque volumétrico.

## Produção recomendada

```text
Cliente
  ↓
CDN/WAF
  ↓
Backend
  ↓
Supabase
```

No CDN/WAF, configurar:

- proteção DDoS;
- bot protection;
- limite por IP;
- challenge para tráfego claramente automatizado;
- bloquear países somente se houver razão operacional;
- bloquear user agents maliciosos conhecidos com cautela;
- limite específico para `/api/public/orders`;
- limite muito forte para rotas de autenticação;
- cache do catálogo público.

## Regra conceitual para checkout

Algo equivalente a:

```text
/path = /api/public/orders
AND method = POST
→ máximo ~5 requests/min/IP
```

## Não confundir

Rate limiting reduz abuso.

Ele NÃO substitui:

- autenticação;
- autorização;
- validação;
- RLS;
- secrets management;
- backup;
- monitoramento.
