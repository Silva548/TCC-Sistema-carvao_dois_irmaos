# Requisitos e Funcionalidades — Sistema de Vendas Carvão Dois Irmãos

Documento temporário de levantamento. Descreve o que o sistema faz hoje, as regras
de negócio aplicadas no código, os requisitos não funcionais e os limites conhecidos.

---

## 1. Visão geral

O sistema é uma aplicação web de vendas e gestão para a empresa Carvão Especial Dois
Irmãos. Ele atende dois públicos em uma única aplicação:

- Administrador da loja: gerencia clientes, categorias, produtos, pedidos,
  usuários e consulta o relatório de vendas.
- Cliente comum: cria conta, navega pelo catálogo, monta carrinho, faz pedidos,
  acompanha e gerencia os próprios pedidos e dados de contato.
- Visitante anônimo: vê a apresentação da loja, a página de localização e as telas
  de login/cadastro.

Tecnologias: Node.js, Express, PostgreSQL, Sequelize (ORM e migrations), EJS,
Bootstrap 4, JavaScript no navegador para o carrinho e preenchimento de CEP.

O schema é controlado exclusivamente por migrations. O sistema não usa
`sequelize.sync()`.

---

## 2. Perfis de acesso e permissões

### 2.1 Visitante (não autenticado)

Pode:
- Abrir a home pública.
- Abrir a página "Onde estamos" com endereço, contato, horários e mapa.
- Acessar as telas de login e de cadastro.
- Consultar a sonda de saúde `/health`.

Não pode:
- Acessar catálogo, pedidos, clientes, produtos, categorias, usuários ou perfil.
- Criar pedidos.

### 2.2 Cliente comum (role `user`)

Pode:
- Fazer login e logout.
- Ver a home com catálogo de produtos e seus pedidos recentes.
- Abrir a ficha de produto em `/catalogo/:id`.
- Montar carrinho no navegador e finalizar pedido.
- Criar pedido somente para o cliente vinculado à própria conta.
- Listar e visualizar apenas os próprios pedidos.
- Editar os próprios pedidos enquanto estiverem pendentes e dentro do prazo de
  3 dias.
- Cancelar os próprios pedidos enquanto o status permitir e dentro do prazo de
  3 dias.
- Editar os próprios dados de contato em `/meus-dados` (nome, e-mail, telefone).

Não pode:
- Acessar ou alterar clientes, categorias, produtos e usuários.
- Ver pedidos de outros clientes.
- Alterar status de pedido (operação da loja).
- Excluir pedidos.
- Alterar documento ou tipo do cliente.

### 2.3 Administrador (role `admin`)

Pode:
- Tudo que o cliente comum pode, com os recortes de tela próprios.
- Gerenciar clientes (CRUD e busca).
- Gerenciar categorias (CRUD).
- Gerenciar produtos (CRUD, filtros, upload de imagem).
- Gerenciar usuários (CRUD, busca, vínculo com cliente).
- Criar pedidos para qualquer cliente, inclusive sem contato obrigatório.
- Ver todos os pedidos, filtrar por status e paginar.
- Alterar status de qualquer pedido.
- Cancelar pedido de qualquer cliente, sem prazo.
- Editar pedido pendente de qualquer cliente, sem prazo.
- Excluir pedidos.
- Consultar o relatório de vendas em JSON.

Regras de proteção:
- O sistema nunca pode ficar sem administrador: não é permitido rebaixar nem
  excluir o último admin.
- O admin não pode excluir a própria conta enquanto estiver autenticado.
- A gestão de usuários exige a role `admin`.

---

## 3. Requisitos funcionais

### 3.1 Autenticação e sessão

RF-AUT-01 — Login com usuário e senha.
- Formulário em `/login`.
- Senhas armazenadas com hash bcrypt (custo 12).
- Comparação de senha em tempo constante; usuário inexistente usa hash fictício
  para não vazar existência por tempo de resposta.
- Sessão regenerada após login bem-sucedido (proteção contra session fixation).
- Redirecionamento pós-login apenas para caminho interno seguro; URL externa,
  protocol-relative, barra invertida ou esquema absoluto é descartada.

RF-AUT-02 — Logout.
- Encerra a sessão, limpa o cookie e redireciona para `/login`.

RF-AUT-03 — Cadastro público de cliente.
- Formulário em `/registrar`.
- Campos: nome de usuário, senha, nome, e-mail, WhatsApp e CPF/CNPJ.
- Cria, na mesma transação, um registro em `clientes` (tipo B2C) e um em `users`
  com role `user` e vínculo ao cliente criado.
- O papel `user` é definido no servidor e nunca lido do corpo da requisição.
- Documento é normalizado para somente dígitos e validado como CPF (11) ou CNPJ
  (14).
- Senha mínima de 8 caracteres.
- E-mail validado por expressão regular.
- WhatsApp obrigatório no cadastro.
- Mensagem de conflito é genérica para não confirmar existência de usuário,
  e-mail ou documento.
- Contas criadas por esse fluxo já nascem vinculadas a um cliente e conseguem
  comprar.

RF-AUT-04 — Sessão persistente.
- Sessões armazenadas no PostgreSQL pela tabela de sessões do
  `connect-pg-simple`.
- Cookie `sessionId` com `httpOnly`, `sameSite=lax`, `secure` em produção e
  validade de 2 horas.
- Identidade do usuário é reidratada do banco a cada requisição; se a conta foi
  removida, a sessão é encerrada; se o papel ou vínculo mudou, a mudança vale
  imediatamente.

RF-AUT-05 — Proteção de login.
- Limite por IP: 10 tentativas por 15 minutos (configurável).
- Limite por conta: 20 falhas por 15 minutos (configurável), independente do IP.
- Somente falhas contam; login bem-sucedido zera o contador da conta.
- Contadores persistidos no PostgreSQL.
- Bloqueio por conta responde com tempo restante e não consome bcrypt nem
  consulta de usuário.

RF-AUT-06 — Credencial padrão em produção.
- Em produção, o servidor recusa iniciar se o usuário `admin` ainda usar senha
  padrão conhecida (`admin123`).
- O seed respeita `ADMIN_SENHA`; em produção ela é obrigatória quando o admin
  ainda não existe.

### 3.2 Usuários (somente admin)

RF-USR-01 — Listar usuários com paginação.
RF-USR-02 — Buscar usuários por nome de usuário via JSON.
RF-USR-03 — Criar usuário.
- Campos: username, senha, role (`admin` ou `user`) e cliente vinculado.
- Role inválida cai em `user`.
- Para role `user`, o vínculo com um cliente existente é obrigatório.
- Para role `admin`, o vínculo é sempre nulo.
- Username único; senha mínima de 8 caracteres; hash bcrypt.
- Senha nunca é devolvida ao formulário em caso de erro.

RF-USR-04 — Visualizar usuário.
RF-USR-05 — Editar usuário.
- Pode alterar username, role e vínculo com cliente.
- Senha só é alterada quando uma nova é informada e válida.
- Não permite rebaixar o último administrador.
- Não permite username duplicado.
- Atualização feita em transação com lock.

RF-USR-06 — Excluir usuário.
- Não permite excluir a própria conta logada.
- Não permite excluir o último administrador.
- Exclusão segue para a listagem com mensagem em caso de recusa.

### 3.3 Clientes (somente admin)

RF-CLI-01 — Listar clientes com paginação.
RF-CLI-02 — Buscar clientes por nome via JSON.
RF-CLI-03 — Criar cliente.
- Campos: nome, e-mail, documento, telefone e tipo (B2C/B2B).
- Nome e e-mail obrigatórios; e-mail válido e único.
- Documento obrigatório, normalizado (somente dígitos) e único.
- Telefone opcional.
- Tipo padrão B2C.
- Limites de tamanho são validados antes do banco.

RF-CLI-04 — Visualizar cliente.
RF-CLI-05 — Editar cliente.
RF-CLI-06 — Excluir cliente com proteção de integridade.
- Bloqueia exclusão quando existem pedidos vinculados; a mensagem orienta excluir
  os pedidos, pois cancelar não libera a exclusão.
- Bloqueia exclusão quando existe usuário de acesso vinculado; a mensagem orienta
  remover ou trocar o vínculo.
- A corrida entre a contagem e o DELETE também é tratada como recusa amigável.

### 3.4 Categorias (somente admin)

RF-CAT-01 — Listar categorias com paginação.
RF-CAT-02 — Criar categoria.
- Nome obrigatório, com limite de tamanho e único.
RF-CAT-03 — Visualizar categoria.
RF-CAT-04 — Editar categoria.
- Nome obrigatório e único.
RF-CAT-05 — Excluir categoria.
- Bloqueia exclusão quando existem produtos vinculados; orienta alterar a
  categoria dos produtos antes.

### 3.5 Produtos (somente admin)

RF-PRO-01 — Listar produtos com paginação.
- Filtros: categoria, embalagem (`premium`/`basica`) e peso.
- Filtros ativos são preservados ao trocar de página.

RF-PRO-02 — Criar produto.
- Campos: nome, descrição, preço de entrega, preço de retirada, embalagem, peso
  em kg, estoque, categoria (opcional) e imagem (opcional).
- Preços devem ser maiores que zero e respeitar o limite da coluna.
- Embalagem deve ser `premium` ou `basica`.
- Peso deve ser maior que zero e respeitar o limite da coluna.
- Estoque deve ser inteiro maior ou igual a zero, dentro do limite do INTEGER.
- Categoria inválida ou inexistente retorna erro amigável, não 500.

RF-PRO-03 — Visualizar produto.
RF-PRO-04 — Editar produto.
- Pode trocar a imagem, manter a atual ou removê-la.
- Imagem antiga é apagada após a atualização bem-sucedida.
- Se o update falhar, a imagem nova gravada é removida.
RF-PRO-05 — Excluir produto.
- Bloqueia exclusão de produto com pedidos registrados.
- A imagem só é removida após o sucesso da exclusão.
RF-PRO-06 — Upload de imagem.
- Aceita JPG, PNG e WEBP.
- Tamanho máximo de 2 MB.
- Apenas uma imagem por requisição.
- Conteúdo é validado pela assinatura binária, não só pelo Content-Type.
- O arquivo fica em memória até a validação do formulário; só depois é gravado em
  `public/uploads/produtos`.
- Nome do arquivo é gerado pelo servidor.
- O upload é restrito a admin e ocorre antes da validação CSRF porque o token vem
  no corpo multipart.

### 3.6 Catálogo e carrinho do cliente

RF-CATALOGO-01 — Home por perfil.
- Visitante: apresentação, botões de entrar/criar conta.
- Admin: atalhos para clientes, produtos e pedidos.
- Cliente: catálogo em cards e aba "Meus pedidos" com os 10 pedidos mais recentes.

RF-CATALOGO-02 — Catálogo.
- Lista todos os produtos, inclusive sem estoque.
- Produto esgotado aparece marcado como "Esgotado" e com botão desabilitado.
- Card mostra dados do produto e seletor de quantidade.
- Ficha do produto em `/catalogo/:id` mostra imagem, categoria, preços de entrega e
  retirada, descrição, peso, embalagem e estoque.

RF-CATALOGO-03 — Carrinho.
- Estado mantido em `localStorage` do navegador, chave `cdi_carrinho`.
- Adicionar, somar quantidades, alterar, remover e limpar itens.
- Quantidade limitada ao estoque exibido.
- Quantidade digitável, arredondada e limitada no evento de alteração.
- Total exibido no cliente é apenas visual; o servidor recalcula tudo.
- Formulário de finalização pede forma de pagamento, entrega/retirada, endereço
  (quando entrega) e contato.
- Endereço de entrega aparece apenas na modalidade entrega.
- Preenchimento de endereço por CEP via ViaCEP no navegador.
- Finalização envia POST JSON para `/pedidos?format=json` com token CSRF.
- Sem JavaScript não há carrinho, mas o admin ainda cria pedidos pelo formulário
  HTML tradicional.

### 3.7 Pedidos

RF-PED-01 — Listar pedidos.
- Admin vê todos; cliente vê apenas os do próprio vínculo.
- Filtro por status.
- Paginação.
- Exibição de cliente, data, status, pagamento, entrega/retirada e total.

RF-PED-02 — Criar pedido pelo formulário HTML.
- Formulário em `/pedidos/new`.
- Admin escolhe o cliente; cliente comum usa o cliente vinculado à conta, sem
  escolha.
- Formulário tem 6 linhas fixas de item, sem exigir JavaScript.
- Linhas em branco são ignoradas; meia linha preenchida é erro.
- Mesmo produto repetido em várias linhas é somado antes da validação de estoque.
- Produtos sem estoque não aparecem no formulário do admin.
- Campos: cliente, forma de pagamento, tipo de entrega, contato (cliente comum) e
  endereço (entrega).
- Cliente comum deve informar nome, e-mail e WhatsApp de contato.
- Endereço é obrigatório na entrega e ignorado/limpo na retirada.
- Pedido nasce com status `pendente`.

RF-PED-03 — Criar pedido pela API JSON.
- `POST /pedidos` com `cliente_id`, `forma_pagamento`, `tipo_entrega`, `itens`
  (`produto_id`, `quantidade`), contato e endereço.
- Retorna 201 em caso de sucesso.
- Contato é opcional no fluxo de API/admin, mas contato parcialmente preenchido é
  recusado.

RF-PED-04 — Regras de criação.
- Cliente deve existir.
- Forma de pagamento deve ser uma de: crédito, débito, pix, boleto, dinheiro.
- Tipo de entrega deve ser `entrega` ou `retirada`; padrão `entrega`.
- Pedido deve ter ao menos um item.
- Quantidade deve ser inteira maior que zero.
- Produto deve existir.
- Estoque deve ser suficiente para a soma agregada por produto.
- Total calculado em centavos com o preço da modalidade escolhida.
- Total validado contra o limite da coluna `valor_total`.
- Preço unitário é congelado em `itens_pedidos.preco_unitario`.
- Estoque é decrementado.
- Tudo ocorre em uma transação.
- Linhas de produto são travadas com lock pessimista em ordem crescente de id para
  evitar deadlock entre pedidos concorrentes.

RF-PED-05 — Visualizar pedido.
- Admin vê qualquer pedido; cliente vê somente o próprio.
- Mostra resumo, contato, endereço, status, itens, preço unitário, subtotais e
  total.
- Admin vê os botões de transição de status e exclusão.
- Botão de editar e cancelar aparecem conforme permissão.

RF-PED-06 — Alterar status (somente admin).
- Transições permitidas:
  - pendente -> processando ou cancelado
  - processando -> enviado ou cancelado
  - enviado -> entregue ou cancelado
  - entregue -> nenhuma
  - cancelado -> nenhuma
- Transição inválida retorna erro de negócio e reexibe o pedido.
- Cancelamento devolve os itens ao estoque.
- Operação feita em transação com lock na linha do pedido.

RF-PED-07 — Editar pedido.
- Admin pode editar pedido pendente de qualquer cliente, sem prazo.
- Cliente comum pode editar o próprio pedido pendente somente até 3 dias após a
  data do pedido.
- Edição pode alterar forma de pagamento, tipo de entrega, itens, contato e
  endereço.
- Antes de validar os novos itens, o estoque dos itens antigos é devolvido; assim,
  a troca de produtos não falha indevidamente por falta de estoque.
- Itens antigos são substituídos, total é recalculado e preço unitário é regravado
  com a modalidade final.
- Contato não reenviado é preservado.
- Endereço não reenviado é preservado.
- Trocar para entrega exige endereço; trocar para retirada limpa o endereço.
- Pedido não pendente não pode ser editado, nem pelo admin.

RF-PED-08 — Cancelar pedido.
- Admin cancela qualquer pedido sem prazo, desde que o status permita.
- Cliente comum cancela o próprio pedido dentro do prazo de 3 dias e se o status
  permitir.
- Status canceláveis: pendente, processando e enviado.
- Entregue e cancelado não podem ser cancelados.
- Cancelamento devolve estoque.
- Cancelamento é irreversível.
- O botão de cancelar é rota separada da mudança de status, pois aceita o dono do
  pedido e não exige admin.

RF-PED-09 — Excluir pedido (somente admin).
- Exclusão definitiva.
- Se o pedido não estiver cancelado, devolve os itens ao estoque antes de excluir.
- Se já estiver cancelado, não devolve estoque novamente.
- Itens são removidos em cascata.
- Operação feita em transação com lock.

RF-PED-10 — Relatório de vendas (somente admin, somente JSON).
- Rota `GET /pedidos/relatorio/vendas`.
- Filtro opcional por período; se um dos limites for informado, ambos são
  obrigatórios.
- Intervalo semiaberto: início incluído, fim excluído.
- Pedidos cancelados não entram no resumo nem na listagem.
- Retorna resumo com total de vendas, total de pedidos e valor médio arredondado.
- Retorna paginação e lista de pedidos com cliente.
- Agregações calculadas no banco.

### 3.8 Perfil do cliente

RF-PERF-01 — Editar dados de contato em `/meus-dados`.
- Campos editáveis: nome, e-mail e telefone.
- Nome obrigatório.
- E-mail obrigatório, válido e único.
- Telefone opcional.
- Documento e tipo não são editáveis pelo cliente.
- Vínculo usuário/cliente vem da sessão, nunca da URL.
- Admin sem vínculo recebe mensagem orientando procurar administrador.
- Conta sem vínculo não consegue editar.

### 3.9 Páginas públicas e institucionais

RF-INST-01 — Home pública com apresentação da loja.
RF-INST-02 — Página "Onde estamos" com:
- Endereço completo.
- Link para abrir no Google Maps.
- Telefone/WhatsApp e e-mail.
- Horário de funcionamento.
- Botão de contato por WhatsApp com mensagem pronta.

RF-INST-03 — Dados da empresa centralizados em `config/empresa.js` e
disponibilizados a todas as views.

### 3.10 Interface e experiência

RF-UI-01 — Layout responsivo com Bootstrap 4.
RF-UI-02 — Tema claro e escuro, com preferência salva no navegador.
RF-UI-03 — Navbar e rodapé com contato e endereço.
RF-UI-04 — Mensagens de sucesso por query string (`msg`) e de erro (`erro`).
RF-UI-05 — Paginação reutilizável, com filtros preservados.
RF-UI-06 — Páginas de erro 400, 403, 404 e 500.
RF-UI-07 — Exclusões e cancelamentos com botões explicitamente rotulados; sem
confirmação em JavaScript inline por restrição de CSP.

---

## 4. Regras de negócio consolidadas

- Um pedido pertence a um cliente.
- Um cliente pode ter vários pedidos e vários usuários de acesso.
- Um usuário `user` pode estar vinculado a no máximo um cliente, por meio de
  `users.cliente_id`.
- Um admin não é cliente e não possui vínculo.
- Produtos têm dois preços: entrega e retirada.
- O preço aplicado ao pedido depende da modalidade escolhida.
- O total do pedido é sempre recalculado no servidor.
- O preço unitário é congelado no item do pedido.
- O estoque só é decrementado em criação ou edição de pedido.
- O estoque é devolvido em cancelamento, exclusão ou edição.
- Estoque nunca pode ficar negativo: há validação na aplicação e CHECK no banco.
- Linhas repetidas do mesmo produto são agregadas antes de validar estoque.
- Pedido com status diferente de pendente não pode ter itens reescritos.
- Cliente comum tem prazo de 3 dias para editar ou cancelar o próprio pedido.
- Admin não tem prazo, mas respeita os status permitidos.
- Cliente com pedidos ou usuários vinculados não pode ser excluído.
- Categoria com produtos vinculados não pode ser excluída.
- Produto com pedidos vinculados não pode ser excluído.
- O sistema não pode ficar sem administrador.
- Documento de cliente e username de usuário são únicos.
- E-mail de cliente é único.
- Nome de categoria é único.

---

## 5. API e negociação de conteúdo

As rotas de pedidos atendem HTML e JSON no mesmo caminho.

Decisão do formato:
1. `?format=html` ou `?format=json` força o formato.
2. Cabeçalho `Accept` decide quando não há `format`.
3. Rotas marcadas como JSON por natureza (`/pedidos`) priorizam JSON.
4. Navegadores que citam `text/html` recebem HTML.

Rotas principais:

- `GET /pedidos` — lista; HTML com filtro e paginação, ou JSON com
  `{ pedidos, paginacao }`.
- `GET /pedidos/new` — somente HTML.
- `POST /pedidos` — cria; HTML redireciona, JSON responde 201.
- `GET /pedidos/:id` — detalhe em HTML ou JSON.
- `GET /pedidos/:id/edit` — somente HTML.
- `PUT /pedidos/:id` — edita pedido; HTML redireciona, JSON responde.
- `PUT /pedidos/:id/status` — altera status; somente admin.
- `PUT /pedidos/:id/cancelar` — cancela; admin ou dono do pedido.
- `DELETE /pedidos/:id` — exclui; somente admin.
- `GET /pedidos/relatorio/vendas` — somente JSON; somente admin.

Respostas de erro:
- JSON com `{ error }` para clientes que esperam JSON.
- Texto puro para erros intermediários de rotas web.
- Páginas 400, 403, 404 e 500 para navegação.
- Erros 500 incluem `requestId` na resposta e no log do servidor.

Paginação:
- Limite padrão: 20.
- Limite máximo: 50.
- Página mínima: 1.
- Página máxima: 10000.
- Metadados: página, limite, total e total de páginas.

Busca:
- `GET /clientes/search?nome=...` retorna JSON com clientes e paginação.
- `GET /users/search?search=...` retorna JSON com usuários e paginação.
- Busca usa `ILIKE` com escape de `%`, `_` e `\`.

---

## 6. Modelo de dados

### clientes
- `id` inteiro, chave primária.
- `nome` varchar(255), obrigatório.
- `email` varchar(255), obrigatório, único.
- `documento` varchar(20), obrigatório, único, normalizado para dígitos.
- `telefone` varchar(20), opcional.
- `tipo` enum B2C/B2B, padrão B2C.
- Timestamps de criação e atualização.

### categorias
- `id` inteiro, chave primária.
- `nome` varchar(255), obrigatório, único.
- Timestamps.

### produtos
- `id` inteiro, chave primária.
- `nome` varchar(255), obrigatório.
- `descricao` texto, opcional.
- `preco_entrega` decimal(10,2), obrigatório.
- `preco_retirada` decimal(10,2), obrigatório.
- `embalagem` varchar(20), padrão `basica`.
- `peso_kg` decimal(8,2), obrigatório.
- `estoque` inteiro, padrão 0, com CHECK de não negatividade.
- `categoria_id` inteiro opcional, FK para categorias com ON DELETE RESTRICT.
- `imagem` varchar(255), opcional.
- Timestamps.

### pedidos
- `id` inteiro, chave primária.
- `cliente_id` inteiro, obrigatório, FK para clientes com ON DELETE RESTRICT.
- `data` timestamp, padrão agora.
- `status` enum: pendente, processando, enviado, entregue, cancelado.
- `valor_total` decimal(12,2), obrigatório.
- `forma_pagamento` enum: credito, debito, pix, boleto, dinheiro.
- `tipo_entrega` varchar(20), padrão `entrega`.
- `contato_nome`, `contato_email`, `contato_telefone` opcionais (snapshot do
  contato informado no pedido).
- Endereço de entrega: `endereco_cep`, `endereco_logradouro`, `endereco_numero`,
  `endereco_complemento`, `endereco_bairro`, `endereco_cidade`, `endereco_uf`.
- Timestamps.

### itens_pedidos
- `id` inteiro, chave primária.
- `pedido_id` inteiro, obrigatório, FK para pedidos com ON DELETE CASCADE.
- `produto_id` inteiro, obrigatório, FK para produtos com ON DELETE RESTRICT.
- `quantidade` inteiro, mínimo 1.
- `preco_unitario` decimal(10,2), obrigatório.
- Timestamps.

### users
- `id` inteiro, chave primária.
- `username` varchar(100), obrigatório, único.
- `password` varchar(255), obrigatório, hash bcrypt.
- `role` enum admin/user, padrão user.
- `cliente_id` inteiro opcional, FK para clientes com ON DELETE RESTRICT.
- Timestamps.

### rate_limit
- `id` inteiro, chave primária.
- `chave` varchar(255), única, prefixada por limitador.
- `total_hits` inteiro.
- `reset_at` timestamp.
- `created_at` e `updated_at`.
- Índice em `reset_at`.
- Limpeza periódica de registros expirados.

### Tabela de sessões
- Criada e gerenciada pelo `connect-pg-simple`.

---

## 7. Requisitos não funcionais

### 7.1 Segurança

RNF-SEG-01 — Senhas com bcrypt de custo 12 e mínimo de 8 caracteres.
RNF-SEG-02 — Proteção CSRF em todos os métodos que alteram estado (POST, PUT,
PATCH, DELETE), com token comparado em tempo constante.
RNF-SEG-03 — Cabeçalhos de segurança com Helmet e CSP restritiva.
RNF-SEG-04 — Recursos de CDN com Subresource Integrity e origem única
(cdn.jsdelivr.net).
RNF-SEG-05 — Sessão regenerada após login e destruída no logout.
RNF-SEG-06 — Rate limiting global, por IP no login, por conta no login e por IP no
cadastro.
RNF-SEG-07 — CORS same-origin por padrão; origens externas somente se listadas em
`CORS_ORIGINS`.
RNF-SEG-08 — Proteção contra open redirect em redirecionamentos pós-login.
RNF-SEG-09 — Upload de imagem com validação de MIME, tamanho, assinatura binária e
nome gerado pelo servidor.
RNF-SEG-10 — Validação de entrada antes do banco, evitando 500 por tipo ou tamanho
inválido.
RNF-SEG-11 — `TRUST_PROXY` só é habilitado com valor explícito `true`, evitando
confiança em `X-Forwarded-For` forjado.
RNF-SEG-12 — Erros internos não vazam stack para o cliente; o log do servidor
guarda a stack completa com `requestId`.
RNF-SEG-13 — O servidor recusa iniciar em produção com admin de senha padrão
conhecida.
RNF-SEG-14 — Templates EJS escapam dados por padrão; mensagens refletidas em
texto puro usam `text/plain`.
RNF-SEG-15 — Consultas via Sequelize/parâmetros evitam SQL injection; buscas
escapam curingas de `LIKE`.
RNF-SEG-16 — A role do cadastro público não pode ser definida pelo usuário.
RNF-SEG-17 — Usuário comum não acessa dados de outro cliente; verificações são
feitas no servidor, não só escondendo botões.

### 7.2 Integridade e consistência

RNF-INT-01 — Operações de escrita de pedido ocorrem em transações.
RNF-INT-02 — Locks pessimistas em pedidos e produtos.
RNF-INT-03 — Produtos travados em ordem crescente de id para evitar deadlock.
RNF-INT-04 — Itens duplicados agregados antes da validação de estoque.
RNF-INT-05 — Estoque não pode ficar negativo (validação + CHECK no banco).
RNF-INT-06 — FKs com ON DELETE RESTRICT para clientes, categorias, produtos e
usuários.
RNF-INT-07 — Itens de pedido removidos em cascata com o pedido.
RNF-INT-08 — Documento e username únicos após normalização.
RNF-INT-09 — Limites de VARCHAR, DECIMAL e INTEGER espelhados no código.
RNF-INT-10 — Violações de FK são reconhecidas pelo SQLSTATE do PostgreSQL e
convertidas em mensagens amigáveis.

### 7.3 Operação e confiabilidade

RNF-OPS-01 — Schema aplicado por migrations (`npm run migrate`), nunca por sync.
RNF-OPS-02 — Seed idempotente, com dados de demonstração e usuários admin e
cliente.
RNF-OPS-03 — Sonda de saúde pública `/health` verifica o banco e responde 200 ou
503.
RNF-OPS-04 — O boot verifica a existência da tabela `rate_limit` e falha cedo se
as migrations não foram aplicadas.
RNF-OPS-05 — Encerramento gracioso em SIGTERM/SIGINT, fechando servidor, Sequelize
e pool de sessões.
RNF-OPS-06 — Handlers globais para rejeições não tratadas e exceções não
capturadas, com log.
RNF-OPS-07 — `requestId` aceito ou gerado por requisição, presente no header de
resposta e nos logs.
RNF-OPS-08 — Pool de conexões configurável por variáveis de ambiente.
RNF-OPS-09 — Suporte a `DATABASE_URL` com precedência sobre variáveis `DB_*` e TLS
via `sslmode=require` ou `DB_SSL`.
RNF-OPS-10 — Sessões e rate limit persistidos no PostgreSQL, sobrevivendo a
restarts e funcionando com múltiplas instâncias.

### 7.4 Desempenho e escalabilidade

RNF-PERF-01 — Paginação em todas as listagens relevantes.
RNF-PERF-02 — Agregações do relatório calculadas no banco.
RNF-PERF-03 — Devolução de estoque em uma única leitura com `IN`, evitando N+1.
RNF-PERF-04 — Limite de página para evitar offsets absurdos.
RNF-PERF-05 — Rate limit compartilhado no banco em vez de memória por processo.
RNF-PERF-06 — Upload limitado a 2 MB e um arquivo por requisição.

### 7.5 Usabilidade e acessibilidade

RNF-USAB-01 — Interface em português do Brasil.
RNF-USAB-02 — Layout responsivo.
RNF-USAB-03 — Tema claro/escuro persistido.
RNF-USAB-04 — Formulários com rótulos, limites e mensagens de erro claras.
RNF-USAB-05 — Produto esgotado permanece visível e identificado.
RNF-USAB-06 — Carrinho com confirmação visual ao adicionar item.
RNF-USAB-07 — Paginação com elo desabilitado quando não aplicável.
RNF-USAB-08 — Páginas de erro amigáveis.
RNF-USAB-09 — O formulário HTML de pedido funciona sem JavaScript.

### 7.6 Qualidade e manutenção

RNF-QUAL-01 — ESLint configurado e limpo.
RNF-QUAL-02 — Validação de sintaxe dos templates EJS com `npm run lint:views`.
RNF-QUAL-03 — Suíte de testes unitários e de integração com o runner nativo do
Node.
RNF-QUAL-04 — Testes de integração sobem a aplicação real e falam HTTP.
RNF-QUAL-05 — Banco de teste separado, criado pelo `pretest` e recusado se tiver
o mesmo nome do banco de desenvolvimento.
RNF-QUAL-06 — CI no GitHub Actions executando lint, lint de views e testes contra
PostgreSQL de serviço.
RNF-QUAL-07 — Código organizado em camadas: rotas, controllers, services, models,
middleware e utils.
RNF-QUAL-08 — Regras de pedido centralizadas em `services/pedidoService.js` e
compartilhadas entre API e HTML.
RNF-QUAL-09 — Regras puras de pedido em `utils/pedidoRules.js`.
RNF-QUAL-10 — Autorização centralizada em `utils/permissoes.js`.

---

## 8. Configuração e ambiente

Variáveis principais:
- Banco: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT` ou
  `DATABASE_URL`.
- TLS: `sslmode=require` na URL ou `DB_SSL=true`.
- Pool: `DB_POOL_MAX`, `DB_SESSION_POOL_MAX`, `DB_POOL_IDLE_MS`.
- Aplicação: `NODE_ENV`, `PORT`, `SESSION_SECRET`, `ADMIN_SENHA`,
  `CLIENTE_SENHA`.
- Rate limit: `RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT`, `LOGIN_CONTA_RATE_LIMIT`,
  `CADASTRO_RATE_LIMIT`.
- Proxy: `TRUST_PROXY=true`.
- CORS: `CORS_ORIGINS`.
- Testes: `DB_NAME_TEST`, `DB_ADMIN_NAME`.

Padrões de desenvolvimento criados pelo seed:
- Admin: usuário `admin`, senha `admin123`.
- Cliente: usuário `cliente`, senha `cliente123`.
- Em produção, `ADMIN_SENHA` é obrigatória quando o admin ainda não existe; o
  seed não gera nem exibe senha aleatória.

Comandos:
- `npm start` — inicia o servidor.
- `npm run dev` — inicia com nodemon.
- `npm run migrate` — aplica migrations.
- `npm run migrate:status` — status das migrations.
- `npm run migrate:undo` — desfaz a última migration.
- `npm run seed` — popula o banco.
- `npm test` — testes unitários e de integração.
- `npm run test:unit` — somente unitários.
- `npm run test:integration` — somente integração.
- `npm run lint` — ESLint.
- `npm run lint:views` — validação dos templates EJS.

---

## 9. Fluxos principais

### 9.1 Cadastro e primeiro pedido do cliente

1. Visitante abre `/registrar`.
2. Informa usuário, senha, nome, e-mail, WhatsApp e CPF/CNPJ.
3. Sistema cria cliente e usuário vinculado na mesma transação.
4. Cliente faz login.
5. Home mostra catálogo e carrinho.
6. Cliente adiciona produtos, escolhe pagamento, entrega/retirada, endereço e
   contato.
7. Sistema valida estoque, calcula total, grava pedido e itens, baixa estoque.
8. Cliente acompanha o pedido na aba "Meus pedidos" e em `/pedidos`.

### 9.2 Pedido criado pelo admin

1. Admin acessa `/pedidos/new`.
2. Escolhe cliente, pagamento, entrega/retirada e até 6 linhas de itens.
3. Informa endereço se for entrega.
4. Sistema valida e cria o pedido com status pendente.
5. Admin acompanha e altera status conforme a operação avança.

### 9.3 Ciclo de vida do pedido

pendente -> processando -> enviado -> entregue

Em qualquer etapa até enviado, o pedido pode ser cancelado, devolvendo o estoque.
Após entregue ou cancelado, não há novas transições.

### 9.4 Edição e cancelamento pelo cliente

1. Cliente abre o próprio pedido pendente.
2. Enquanto estiver dentro de 3 dias, pode editar itens/endereço/pagamento ou
   cancelar.
3. Edição devolve o estoque antigo, valida o novo e recalcula o total.
4. Cancelamento devolve o estoque e encerra o pedido.

---

## 10. Fora de escopo e limitações conhecidas

- Relatório de vendas não possui tela HTML; é somente JSON.
- Não há endpoint dedicado de edição de pedido na documentação Swagger/OpenAPI.
- A documentação Swagger/OpenAPI ainda não foi criada.
- Não há confirmação em JavaScript ao excluir; a CSP não permite script inline.
- Não há integração de pagamento; a forma de pagamento é apenas informativa.
- Não há controle de frete por distância; o preço de entrega é fixo por produto.
- Não há envio de e-mail de confirmação implementado no código atual.
- Não há edição de itens de pedido após ele sair de pendente, nem pelo admin.
- O carrinho depende de JavaScript e `localStorage`.
- Deploy e escolha de hospedagem ainda são pendências operacionais.
- O repositório histórico já teve credencial exposta; a senha foi rotacionada, mas
  recomenda-se tornar o repositório privado.

---

## 11. Critérios de aceitação gerais

- Visitante não acessa áreas protegidas.
- Cliente só vê e altera os próprios pedidos e dados permitidos.
- Admin gerencia todos os cadastros e pedidos.
- Nenhuma operação de pedido deixa estoque negativo.
- Pedido cancelado devolve estoque exatamente uma vez.
- Pedido excluído devolve estoque quando ainda não estava cancelado.
- Total do pedido corresponde à soma dos preços da modalidade escolhida.
- Formulários sem token CSRF são recusados.
- Entradas inválidas retornam 400 com mensagem clara, não 500.
- Recursos de CDN são carregados com SRI.
- Senhas nunca são exibidas de volta em formulários.
- Sessão de usuário removido deixa de funcionar.
- Sistema não sobe em produção com admin de senha padrão.
- Migrations aplicadas são a única fonte do schema.
- Seed pode rodar mais de uma vez sem duplicar dados.
- `npm run lint`, `npm run lint:views` e `npm test` passam.
