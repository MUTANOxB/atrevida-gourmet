# Resposta a Incidente

## Se houver suspeita de vazamento

### 1. Conter

- colocar painel admin em manutenção;
- revogar sessões administrativas;
- rotacionar chaves;
- trocar service role se houver exposição;
- bloquear origem/IP abusiva no provedor/CDN;
- preservar logs.

### 2. Identificar

Determinar:

- o que vazou;
- quando começou;
- quais usuários foram afetados;
- qual endpoint foi explorado;
- se houve alteração de pedido/preço;
- se houve download de dados.

### 3. Erradicar

- corrigir a falha;
- remover acesso indevido;
- atualizar dependências;
- revisar grants/RLS;
- rodar scanner de segredos;
- revisar commits.

### 4. Recuperar

- restaurar dados se necessário;
- reabrir serviços gradualmente;
- monitorar anomalias;
- invalidar tokens antigos.

### 5. Pós-incidente

- registrar linha do tempo;
- documentar causa raiz;
- criar teste automatizado para evitar regressão;
- avaliar obrigações legais/LGPD aplicáveis.

## Chaves expostas

Segredo exposto = segredo comprometido.

Nunca confiar em:
"ninguém deve ter visto".

Rotacione.
