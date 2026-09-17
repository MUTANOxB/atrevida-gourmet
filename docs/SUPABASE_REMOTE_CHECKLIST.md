# Validação do Supabase remoto

Este checklist deve ser executado no projeto Supabase definitivo. Nenhuma
credencial real deve ser gravada no repositório ou enviada ao navegador.

## 1. Variáveis do backend

- [ ] Preencher `SUPABASE_URL` com a URL do projeto.
- [ ] Preencher `SUPABASE_ANON_KEY` com a chave pública usada apenas pelo
  cliente de Auth criado no servidor.
- [ ] Preencher `SUPABASE_SECRET_KEY` com a chave secreta do projeto somente no
  ambiente protegido do backend. Usar `SUPABASE_SERVICE_ROLE_KEY` apenas em
  projetos legados.
- [ ] Confirmar `PRODUCT_IMAGE_BUCKET=product-images`.
- [ ] Configurar `FRONTEND_ORIGIN` apenas com origens HTTPS reais, sem `*`.
- [ ] Manter `TRUST_PROXY=true` somente atrás do proxy/CDN confiável.

## 2. Banco e segurança

- [ ] Aplicar, em ordem, todas as migrations de
  `backend/supabase/migrations/001_*.sql` até `006_*.sql`.
- [ ] Verificar que `stores`, `store_hours`, `store_schedule_exceptions`,
  `store_payment_methods`, `product_images`, `orders` e `store_members` existem.
- [ ] Confirmar RLS habilitado e ausência de grants comerciais para `anon` e
  `authenticated`.
- [ ] Confirmar que somente o papel de servidor executa
  `create_order_with_items` e `store_is_open_at`.
- [ ] Executar `backend/supabase/tests/remote_security_assertions.sql` com uma
  conexão administrativa e `ON_ERROR_STOP=1`; o script é somente leitura.
- [ ] Cadastrar pelo admin os horários, exceções, modalidades, zonas e formas de
  pagamento confirmadas. Não publicar valores provisórios.

## 3. Auth administrativo

- [ ] Criar uma conta individual no Supabase Auth para cada pessoa.
- [ ] Inserir o `user_id`, `store_id` e o papel `owner`, `manager` ou `staff` em
  `store_members`.
- [ ] Ativar MFA para `owner` e `manager`.
- [ ] Fazer login em `/admin/login/` e confirmar que a sessão fica apenas em
  cookies `HttpOnly`, nunca em `localStorage` ou `sessionStorage`.
- [ ] Confirmar que `staff` não acessa configurações nem upload de imagens.

## 4. Storage de imagens

- [ ] Confirmar o bucket público `product-images`, limite de 5 MiB e tipos
  JPEG, PNG, WebP e AVIF.
- [ ] Confirmar que `anon` e `authenticated` não podem inserir, alterar ou
  apagar objetos; todo upload deve passar por `/api/admin/uploads/product-images`.
- [ ] Enviar uma imagem válida no formulário de produto e conferir o arquivo
  WebP em caminho `{store_id}/{uuid}.webp` e o registro em `product_images`.
- [ ] Tentar SVG, HTML renomeado, executável, conteúdo inválido e arquivo acima
  de 5 MiB; todos devem ser rejeitados.
- [ ] Substituir e remover uma imagem e confirmar que o cardápio usa o
  placeholder quando a URL estiver ausente ou indisponível.

## 5. Operação e realtime

- [ ] Criar um pedido real pelo checkout e confirmar `orders`, `order_items` e
  o total recalculado no banco.
- [ ] Com a loja fechada, confirmar rejeição de entrega/retirada imediata.
- [ ] Criar um agendamento dentro do horário e dos limites configurados; testar
  também feriado fechado e faixa que atravessa meia-noite.
- [ ] Abrir `/admin/pedidos/`, criar outro pedido e confirmar o evento remoto
  Supabase -> backend -> SSE -> navegador sem refresh.
- [ ] Alterar o status no painel e confirmar a atualização imediata do tracking
  público pelo token correto.
- [ ] Confirmar que outra loja, outro tracking token e uma sessão sem vínculo
  não recebem os eventos.
- [ ] Desconectar a rede brevemente e confirmar reconexão SSE e fallback.

## 6. Inspeção final

- [ ] Em DevTools, revisar Network, Application e Sources e procurar por
  chaves secretas, tokens administrativos, dados de outros clientes e `.map`.
- [ ] Rodar `npm run check` com as variáveis do projeto remoto.
- [ ] Rodar `npm run scan:build` no artefato que será publicado.

## 7. Evidência do teste ponta a ponta

- [ ] Registrar ambiente, data, commit e responsável sem copiar credenciais.
- [ ] Registrar o número do pedido de teste, nunca telefone/endereço/token.
- [ ] Confirmar no painel: novo -> confirmado -> em preparo -> pronto ->
  concluído para retirada.
- [ ] Confirmar que cada mudança chegou ao tracking por SSE sem refresh.
- [ ] Repetir com entrega somente quando zona, endereço de teste e pagamento
  estiverem previamente configurados e autorizados.
- [ ] Confirmar que o pedido aparece uma única vez após replay e concorrência.
- [ ] Apagar ou anonimizar os dados do teste conforme a política de retenção.

## 8. Pré-requisitos externos ainda obrigatórios

- URL e chaves do projeto no secret manager do backend;
- connection string administrativa temporária para assertions SQL;
- domínio HTTPS definitivo em `FRONTEND_ORIGIN`;
- conta Auth de teste individual e vínculo `store_members`;
- produto, horário, pagamento e, para entrega, zona/endereço de teste já
  configurados pela loja;
- zona Cloudflare, origem/Tunnel e regras descritas em
  `CLOUDFLARE_PRODUCTION.md`.
