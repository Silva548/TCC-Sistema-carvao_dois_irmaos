// Camada HTML de /pedidos. Atende o mesmo path da API JSON: quem decide o
// formato é routes/pedidoRoutes.js, via req.respostaJson.
//
// Não duplica regra de negócio — criar/editar/mudar status/excluir delegam ao
// mesmo services/pedidoService.js usado pela API. Aqui mora só o recorte de
// quem enxerga o quê: admin vê tudo; user vê apenas os pedidos do cliente ao
// qual a conta está vinculada (utils/permissoes).

const { Pedido, ItemPedido, Cliente, Produto } = require('../models');
const { Op } = require('sequelize');
// A formatação (moeda, data, rótulo de status) fica em app.locals.formatadores
// e é usada pelas views; o controller não precisa dela.
const {
    STATUS_VALIDOS,
    FORMAS_PAGAMENTO,
    TIPOS_ENTREGA,
    TRANSICOES_STATUS,
    STATUS_EDITAVEIS,
    dentroDoPrazoDeEdicao,
} = require('../utils/pedidoRules');
const { parsePaginacao, metadados } = require('../utils/paginacao');
const { lerEndereco, enderecoDe } = require('../utils/endereco');
const { erroDaUrl } = require('../utils/responder');
const {
    ehAdmin,
    ehDonoDoPedido,
    podeEditarPedido,
    podeCancelarPedido,
    erroCancelamento,
    exigirAdmin,
    exigirCliente,
    clienteIdDoUsuario,
} = require('../utils/permissoes');
const {
    falha,
    criarPedido,
    editarPedido,
    mudarStatus,
    excluirPedido,
    normalizarItens,
    itensDoFormulario,
} = require('../services/pedidoService');
const { lerContato, validarContato } = require('../utils/contato');

// Linhas fixas do formulário: o usuário preenche só o que precisa, sem
// JavaScript. Seis é o suficiente para a maioria dos pedidos e mantém a
// página utilizável no celular.
const LINHAS_ITEM = 6;

const ordemItens = (itens = []) =>
    [...itens].sort((a, b) => (a.produto_id || 0) - (b.produto_id || 0));

// Recarrega os <select> do formulário. Chamado tanto no primeiro acesso
// quanto ao reenviar o form com erro, para o usuário não perder as opções.
//
// Para o user, a lista de clientes vem reduzida ao próprio vínculo (ou vazia,
// se a conta ainda não foi vinculada): o formulário não oferece escolha, mas a
// view usa o registro para mostrar o nome.
const opcoesDoFormulario = async (req) => {
    const clienteId = ehAdmin(req) ? null : clienteIdDoUsuario(req);

    const [clientes, produtos] = await Promise.all([
        Cliente.findAll({
            where: ehAdmin(req) ? {} : { id: clienteId === null ? -1 : clienteId },
            order: [['nome', 'ASC']],
            // email/telefone entram para já vir preenchidos no bloco de
            // contato do pedido do usuário comum.
            attributes: ['id', 'nome', 'email', 'telefone'],
        }),
        // Produto sem estoque não aparece: selecioná-lo só produziria erro de
        // "estoque insuficiente" na submissão.
        Produto.findAll({
            where: { estoque: { [Op.gt]: 0 } },
            order: [['nome', 'ASC']],
            attributes: ['id', 'nome', 'preco_entrega', 'preco_retirada', 'estoque'],
        }),
    ]);

    const clienteDaConta = !ehAdmin(req) && clientes.length ? clientes[0] : null;

    return {
        clientes,
        produtos,
        formasPagamento: FORMAS_PAGAMENTO,
        tiposEntrega: TIPOS_ENTREGA,
        linhasItem: LINHAS_ITEM,
        // A view esconde o <select> de cliente quando a conta já é o cliente.
        clienteFixo: !ehAdmin(req),
        // Contato do pedido pré-preenchido com o cadastro do cliente.
        contatoPadrao: {
            contato_nome: clienteDaConta ? clienteDaConta.nome : '',
            contato_email: clienteDaConta ? clienteDaConta.email : '',
            contato_telefone: clienteDaConta ? clienteDaConta.telefone || '' : '',
        },
    };
};

// Mensagens de retorno por query string, em vez de sessão de flash: o app não
// tem middleware de flash e criar um só para isto seria mais código do que a
// própria mensagem. As chaves são fixas (nunca o texto), então o valor
// interpolado na view vem de uma lista fechada.
const AVISOS = {
    criado: 'Pedido criado com sucesso.',
    editado: 'Pedido atualizado com sucesso.',
    atualizado: 'Status do pedido atualizado.',
    cancelado: 'Pedido cancelado. Os itens voltaram ao estoque.',
    excluido: 'Pedido excluído.',
};

const avisoDaUrl = (req) => AVISOS[req.query.msg] || null;

// Motivo pelo qual a edição está travada, para a tela de detalhe. Devolve null
// quando ainda dá para editar.
//
// Roda uma checagem de autorização FORA do try de negócio e devolve false se
// recusou (having já chamado next).
//
// Dois motivos, e o segundo é o que costuma ser esquecido:
//
// 1. Um catch que reexibe a tela não pode reexibir nada para quem não tem
//    permissão. Com exigirAdmin dentro do try, o 403 do usuário comum caía
//    nesse catch e a resposta saía com status 403 e corpo cheio — nome, e-mail,
//    telefone e endereço do pedido alheio, mais o bloco de admin.
//
// 2. Handler async no Express 4 NÃO tem rejeição de promise tratada: lançar
//    dentro de async sem try/catch resulta em unhandledRejection e a requisição
//    fica pendurada sem resposta nenhuma. Por isso o next() é explícito aqui.
const autorizar = (req, next) => {
    try {
        exigirAdmin(req);
        return true;
    } catch (err) {
        next(err);
        return false;
    }
};

// Espelha podeEditarPedido (utils/permissoes) de propósito: se as duas
// divergirem, a tela de detalhe oferece o botão "editar" e a tela de edição
// recusa o clique. `req` é o que separa as duas travas — a de status vale para
// todo mundo, o prazo de 3 dias é só do cliente comum.
const motivoBloqueio = (pedido, req) => {
    if (!STATUS_EDITAVEIS.includes(pedido.status)) {
        return 'Só pedidos pendentes podem ser alterados.';
    }
    if (!ehAdmin(req) && !dentroDoPrazoDeEdicao(pedido)) {
        return 'O prazo de 3 dias para alterar este pedido encerrou.';
    }
    return null;
};

const carregarPedidoCompleto = (id) =>
    Pedido.findByPk(id, {
        include: [
            { model: Cliente, attributes: ['id', 'nome'] },
            { model: ItemPedido, include: [Produto] },
        ],
    });

const pedidoViewController = {

    index: async (req, res, next) => {
        try {
            const status = STATUS_VALIDOS.includes(req.query.status) ? req.query.status : null;
            const where = status ? { status } : {};

            // Um user nunca lista a fila inteira: o vínculo da conta é o filtro.
            if (!ehAdmin(req)) {
                where.cliente_id = exigirCliente(req);
            }

            const pag = parsePaginacao(req.query);

            const { rows: pedidos, count: total } = await Pedido.findAndCountAll({
                where,
                include: [{ model: Cliente, attributes: ['nome'] }],
                order: [['data', 'DESC']],
                limit: pag.limite,
                offset: pag.offset,
                distinct: true,
            });

            res.render('pedidos/index', {
                pedidos,
                statusFiltro: status,
                statusValidos: STATUS_VALIDOS,
                paginacao: metadados(pag, total),
                caminhoBase: '/pedidos',
                queryExtra: status ? `&status=${encodeURIComponent(status)}` : '',
                aviso: avisoDaUrl(req),
                ehAdmin: ehAdmin(req),
            });
        } catch (err) {
            next(err);
        }
    },

    newForm: async (req, res, next) => {
        try {
            const opcoes = await opcoesDoFormulario(req);
            res.render('pedidos/new', { erro: null, submetido: {}, itensPreenchidos: [], pedido: null, ...opcoes });
        } catch (err) {
            next(err);
        }
    },

    create: async (req, res, next) => {
        try {
            const { forma_pagamento, tipo_entrega } = req.body;
            const itens = normalizarItens(req.body);

            // O admin escolhe o cliente; o user só pede para a própria conta.
            const cliente_id = ehAdmin(req) ? req.body.cliente_id : exigirCliente(req);

            // Contato obrigatório no fluxo do cliente comum (cai no catch e
            // volta para o formulário com o que ele já digitou).
            const { erro, dados: contato } = validarContato(lerContato(req.body), {
                obrigatorio: !ehAdmin(req),
            });
            if (erro) throw falha(400, erro);

            // Endereco tambem pelo form do admin. Quem decide se ele e
            // obrigatorio e a modalidade, lida dentro do servico.
            const pedido = await criarPedido({
                cliente_id, forma_pagamento, tipo_entrega, itens, contato,
                endereco: lerEndereco(req.body),
            });

            res.redirect(`/pedidos/${pedido.id}?msg=criado`);
        } catch (err) {
            // 403 (conta sem cliente) e erro de infraestrutura sobem; erro de
            // validação (400/404) volta para o formulário com o que o usuário
            // já digitou.
            if (!err.status || err.status >= 500 || err.status === 403) {
                return next(err);
            }

            // Se a própria leitura das linhas falhar (metade preenchida), o
            // formulário volta vazio em vez de quebrar: o erro do pedido já
            // explica o problema.
            const itens = (() => {
                try {
                    return itensDoFormulario(req.body);
                } catch {
                    return [];
                }
            })();

            const opcoes = await opcoesDoFormulario(req);
            res.status(err.status).render('pedidos/new', {
                erro: err.message,
                submetido: req.body,
                itensPreenchidos: itens,
                pedido: null,
                ...opcoes,
            });
        }
    },

    show: async (req, res, next) => {
        try {
            const pedido = await carregarPedidoCompleto(req.params.id);

            if (!pedido || !ehDonoDoPedido(pedido, req)) {
                return res.status(404).render('404');
            }

            const admin = ehAdmin(req);
            res.render('pedidos/show', {
                pedido,
                itens: ordemItens(pedido.ItemPedidos),
                // Só as transições permitidas entram no formulário: oferecer
                // "entregue" a partir de "pendente" só geraria erro de validação.
                // Transição de status é operação de loja, então só o admin vê.
                proximosStatus: admin ? (TRANSICOES_STATUS[pedido.status] || []) : [],
                ehAdmin: admin,
                podeEditar: podeEditarPedido(pedido, req),
                podeCancelar: podeCancelarPedido(pedido, req),
                motivoBloqueio: motivoBloqueio(pedido, req),
                aviso: avisoDaUrl(req),
                erro: erroDaUrl(req),
            });
        } catch (err) {
            next(err);
        }
    },

    editForm: async (req, res, next) => {
        try {
            const pedido = await carregarPedidoCompleto(req.params.id);

            if (!pedido || !ehDonoDoPedido(pedido, req)) {
                return res.status(404).render('404');
            }

            const motivo = motivoBloqueio(pedido, req);
            if (motivo) {
                return res.redirect(`/pedidos/${pedido.id}?erro=${encodeURIComponent(motivo)}`);
            }

            const opcoes = await opcoesDoFormulario(req);

            // O bloco de contato da edição parte do que foi gravado no pedido e
            // cai para o cadastro do cliente quando o pedido antigo não tem
            // snapshot (pedidos criados antes da migration 20260930000007).
            opcoes.contatoPadrao = {
                contato_nome: pedido.contato_nome || opcoes.contatoPadrao.contato_nome,
                contato_email: pedido.contato_email || opcoes.contatoPadrao.contato_email,
                contato_telefone: pedido.contato_telefone || opcoes.contatoPadrao.contato_telefone,
            };

            const itensPreenchidos = ordemItens(pedido.ItemPedidos).map((item) => ({
                produto_id: item.produto_id,
                quantidade: item.quantidade,
            }));

            res.render('pedidos/edit', {
                erro: null,
                pedido,
                submetido: pedido,
                itensPreenchidos,
                // Endereço gravado, para o formulário abrir preenchido. `submetido`
                // também é o pedido, então valorEndereco no partial já pega o
                // endereco_cep e companhia sem este objeto — ele existe para o
                // partial continuar funcionando se a origem deixar de ser o
                // próprio pedido.
                enderecoDoPedido: enderecoDe(pedido),
                ...opcoes,
            });
        } catch (err) {
            next(err);
        }
    },

    update: async (req, res, next) => {
        try {
            const pedido = await Pedido.findByPk(req.params.id);

            if (!pedido || !ehDonoDoPedido(pedido, req)) {
                return res.status(404).render('404');
            }

            const motivo = motivoBloqueio(pedido, req);
            if (motivo) {
                return res.redirect(`/pedidos/${pedido.id}?erro=${encodeURIComponent(motivo)}`);
            }

            const { forma_pagamento, tipo_entrega } = req.body;
            const itens = normalizarItens(req.body);

            // Opcional na edição: sem reenvio, o contato já gravado no pedido
            // é mantido.
            const { erro, dados: contato } = validarContato(lerContato(req.body), { obrigatorio: false });
            if (erro) throw falha(400, erro);

            await editarPedido(
                req.params.id,
                { forma_pagamento, tipo_entrega, itens, contato, endereco: lerEndereco(req.body) },
                { prazoObrigatorio: !ehAdmin(req) }
            );

            res.redirect(`/pedidos/${req.params.id}?msg=editado`);
        } catch (err) {
            if (!err.status || err.status >= 500) {
                return next(err);
            }

            // Erro de validação (estoque, item vazio) volta para o formulário
            // de edição mantendo o que o usuário digitou.
            const itens = (() => {
                try {
                    return itensDoFormulario(req.body);
                } catch {
                    return [];
                }
            })();

            const pedido = await carregarPedidoCompleto(req.params.id);
            if (!pedido) {
                return res.status(404).render('404');
            }

            const opcoes = await opcoesDoFormulario(req);
            res.status(err.status).render('pedidos/edit', {
                erro: err.message,
                pedido,
                // O que o usuário digitado manda: em validação recusada é o body
                // que volta preenchido, inclusive o endereço. enderecoDoPedido
                // fica null de propósito para o partial cair no submetido em vez
                // de misturar o endereço antigo com o que foi digitado agora.
                submetido: req.body,
                itensPreenchidos: itens,
                enderecoDoPedido: null,
                ...opcoes,
            });
        }
    },

    mudarStatus: async (req, res, next) => {
        // Autorização FORA do try, de propósito.
        //
        // Este catch existe para devolver ao admin o motivo de uma transição
        // recusada (ex.: "pendente → entregue não é válida"), reexibindo o
        // pedido. Com exigirAdmin dentro do try, a recusa de um usuário comum
        // caía no mesmo catch e a tela saía assim mesmo: status 403, mas com o
        // corpo contendo nome, e-mail, telefone e endereço de um pedido que
        // não é dele, mais o bloco de administração. Qualquer conta logada
        // lia os dados de qualquer cliente enumerando os ids.
        //
        // A regra que vale para todos os handlers deste arquivo: quem decide
        // "quem pode" responde next(err), e só o que é erro de negócio volta
        // para a tela.
        if (!autorizar(req, next)) return;

        try {
            await mudarStatus(req.params.id, req.body.status);
            res.redirect(`/pedidos/${req.params.id}?msg=atualizado`);
        } catch (err) {
            if (!err.status || err.status >= 500) {
                return next(err);
            }

            // Reexibe o pedido com o motivo da recusa, em vez de redirecionar
            // para a lista e perder o contexto.
            const pedido = await carregarPedidoCompleto(req.params.id);

            if (!pedido) {
                return res.status(404).render('404');
            }

            res.status(err.status).render('pedidos/show', {
                pedido,
                itens: ordemItens(pedido.ItemPedidos),
                proximosStatus: TRANSICOES_STATUS[pedido.status] || [],
                ehAdmin: true,
                podeEditar: false,
                // A tela voltou por uma transição recusada: nada mudou no
                // pedido, então o botão de cancelar continua valendo.
                podeCancelar: podeCancelarPedido(pedido, req),
                motivoBloqueio: motivoBloqueio(pedido, req),
                erro: err.message,
            });
        }
    },

    // Cancelar pelo botão da tela. O cliente comum cancela o próprio pedido; o
    // admin cancela qualquer um, sem prazo. Reaproveita o mesmo serviço do
    // PUT /:id/status — inclusive o lock que impede devolução de estoque em
    // duplicidade quando o botão é clicado duas vezes.
    cancelar: async (req, res, next) => {
        try {
            const pedido = await Pedido.findByPk(req.params.id);

            if (!pedido || !ehDonoDoPedido(pedido, req)) {
                return res.status(404).render('404');
            }

            const recusa = erroCancelamento(pedido, req);
            if (recusa) throw falha(recusa.status, recusa.message);

            await mudarStatus(pedido.id, 'cancelado');
            res.redirect(`/pedidos/${pedido.id}?msg=cancelado`);
        } catch (err) {
            if (!err.status || err.status >= 500) {
                return next(err);
            }

            // Recusa reexibe o pedido com o motivo, em vez de mandar o cliente
            // para a lista sem explicação.
            const completo = await carregarPedidoCompleto(req.params.id);

            if (!completo) {
                return res.status(404).render('404');
            }

            res.status(err.status).render('pedidos/show', {
                pedido: completo,
                itens: ordemItens(completo.ItemPedidos),
                proximosStatus: TRANSICOES_STATUS[completo.status] || [],
                ehAdmin: ehAdmin(req),
                podeEditar: podeEditarPedido(completo, req),
                podeCancelar: podeCancelarPedido(completo, req),
                motivoBloqueio: motivoBloqueio(completo, req),
                erro: err.message,
            });
        }
    },

    excluir: async (req, res, next) => {
        // Fora do try pelo mesmo motivo do mudarStatus: o catch redireciona
        // para /pedidos/:id, e um usuário comum sem permissão não pode nem
        // receber esse redirecionamento.
        if (!autorizar(req, next)) return;

        try {
            await excluirPedido(req.params.id);
            res.redirect('/pedidos?msg=excluido');
        } catch (err) {
            if (!err.status || err.status >= 500) {
                return next(err);
            }
            res.redirect(`/pedidos/${req.params.id}?erro=${encodeURIComponent(err.message)}`);
        }
    },
};

module.exports = pedidoViewController;
module.exports.LINHAS_ITEM = LINHAS_ITEM;
module.exports.ordemItens = ordemItens;
