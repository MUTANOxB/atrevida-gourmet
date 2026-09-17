# Política de Segredos

## Nunca versionar

- `SUPABASE_SERVICE_ROLE_KEY`
- tokens de deploy
- chaves de API privadas
- tokens de sessão
- senhas
- backup de banco
- `.env`
- chaves privadas TLS
- credenciais de e-mail

## Onde guardar

Preferência:

1. Secret manager da hospedagem;
2. variáveis de ambiente do provedor;
3. secret manager dedicado.

Nunca:

- JavaScript do frontend;
- HTML;
- GitHub público;
- banco em coluna de texto;
- print;
- README;
- mensagem de WhatsApp.

## Frontend

O frontend pode conhecer:

- URL pública da API;
- IDs públicos;
- chaves explicitamente classificadas como públicas.

O frontend NÃO pode conhecer:

- service role;
- credenciais do banco;
- segredo JWT;
- credencial de painel;
- senha SMTP.

## Rotação

Se um segredo aparecer em commit, log, print ou chat público:

1. considere comprometido;
2. revogue imediatamente;
3. gere outro;
4. apague do histórico;
5. revise logs;
6. procure uso indevido.

Apenas apagar o arquivo do Git NÃO resolve: o segredo continua no histórico.
