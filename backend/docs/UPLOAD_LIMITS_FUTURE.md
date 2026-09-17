# Uploads futuros

Hoje o delivery não precisa receber arquivos do cliente.

Se futuramente houver upload de foto/comprovante:

## Nunca aceitar upload arbitrário.

Aplicar:

- máximo de 5 MB por arquivo;
- no máximo 3 arquivos por requisição;
- whitelist de MIME real;
- validar magic bytes, não apenas extensão;
- renomear arquivo com UUID;
- nunca manter nome original como path;
- não executar arquivos;
- armazenar fora do filesystem do backend;
- reprocessar imagens no servidor;
- remover EXIF quando não for necessário;
- bloquear SVG enviado pelo usuário;
- bloquear HTML;
- bloquear executáveis;
- proteção contra zip bomb;
- antivírus/scanner quando o risco justificar.

Para comprovante:
JPEG/PNG/WebP apenas.
