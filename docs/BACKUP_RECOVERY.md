# Backup e recuperação

## Banco

1. Habilite os backups gerenciados do plano Supabase escolhido e defina o RPO
   e o RTO aceitos pela loja.
2. Para produção com baixa tolerância a perda, habilite PITR.
3. Além do backup gerenciado, gere periodicamente um dump lógico criptografado
   em um executor protegido e armazene-o fora do projeto Supabase.
4. Nunca coloque a connection string, senha ou dump no Git, logs ou artefatos
   públicos.
5. Teste a restauração primeiro em um projeto isolado. Valide migrations,
   constraints, RLS, grants, Auth, pedidos, Realtime e contagens antes do corte.

Backups do banco preservam os metadados de Storage, mas não os bytes dos
objetos. O bucket precisa de uma rotina separada.

## Storage

1. Copie periodicamente o bucket `product-images` para armazenamento privado e
   versionado usando a API/S3 compatível do Supabase.
2. Preserve `object_path`, checksum, tamanho e data do backup.
3. Na recuperação, restaure primeiro os objetos e depois valide as referências
   de `product_images` e `products.image_url`.
4. Faça uma amostragem real de download e decodificação; listar objetos não
   comprova que os bytes são recuperáveis.

## Exercício de restauração

- [ ] restaurar banco em staging isolado;
- [ ] restaurar objetos do Storage;
- [ ] aplicar migrations ainda pendentes;
- [ ] confirmar RLS/grants e funções `security definer`;
- [ ] autenticar uma conta de teste;
- [ ] criar e acompanhar um pedido de teste configurado;
- [ ] validar upload e leitura de imagem;
- [ ] registrar duração real, RPO e RTO obtidos.

## Rotação e revogação

Ao rotacionar a chave secreta, atualize o secret manager do backend, reinicie as
instâncias gradualmente e revogue a chave anterior somente após confirmar
`/ready`. Nunca mova a nova chave para o frontend.

Para revogar um administrador, remova imediatamente o vínculo em
`store_members`, encerre/revogue suas sessões no Supabase Auth e revise
`admin_audit_log`. Em suspeita de comprometimento, siga
[INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md).
