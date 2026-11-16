const { Pedido, ItemPedido, Cliente } = require('../models');
// Op vem do pacote sequelize, não de models/index.js — models/index.js
// exporta os models, e `Op` vindo de lá é undefined em silêncio (o ESLint não
// acusa, porque parece uma propriedade definida).
const { Op, fn, col } = require('sequelize');
const { periodoRelatorio } = require('../utils/periodo');
const { parsePaginacao, metadados } = require('../utils/paginacao');
const { mediaEmCentavos, STATUS_EDITAVEIS, STATUS_VALIDOS } = require('../utils/pedidoRules');
const {
    ehAdmin,
    ehDonoDoPedido,
    podeEditarPedido,
    erroCancelamento,
    exigirAdmin,
    exigirCliente,
} = require('../utils/permissoes');
const { lerContato, validarContato } = require('../utils/contato');
const { lerEndereco } = require('../utils/endereco');
const { ehInteiroPositivo } = require('../middleware/validate');
const {
    falha,
    criarPedido,
    editarPedido,
    mudarStatus,
    excluirPedido,
    normalizarItens,
} = require('../services/pedidoService');

// Camada JSON de /pedidos. A escrita (criar, mudar status, excluir) mora em
// services/pedidoService.js e é compartilhada com a UI web — ver o comentário
// do serviço sobre por que a lógica não pode ser duplicada.
const pedidoController = {

    createPedido: async (req, res, next) => {
        try {
            const { forma_pagamento, tipo_entrega } = req.body;
            const itens = normalizarItens(req.body);

            // O admin escolhe o cliente; o usuário comum só pode pedir para a
            // própria conta. Ignorar o cliente_id do corpo para o user impede
            // que ele crie pedido em nome de outro só editando o formulário.
            //
            // A validação de formato de cliente_id (objeto/array/negativo -> 400)
            // fica no serviço, para valer também no formulário HTML.
            const cliente_id = ehAdmin(req) ? req.body.cliente_id : exigirCliente(req);

            // Contato do pedido: o cliente comum é obrigado a informar os três
            // campos; o admin pode criar pedido sem eles.
            const { erro, dados: contato } = validarContato(lerContato(req.body), {
                obrigatorio: !ehAdmin(req),
            });
            if (erro) throw falha(400, erro);

            // Endereço: só é validado dentro do serviço, e só quando a
            // modalidade é entrega. Passar o objeto cru é deliberado — quem sabe
            // se o endereço é obrigatório é a modalidade, lida depois de validar
            // itens e estoque.
            const novoPedido = await criarPedido({
                cliente_id, forma_pagamento, tipo_entrega, itens, contato,
                endereco: lerEndereco(req.body),
            });

            res.status(201).json({
                message: 'Pedido criado com sucesso',
                pedido: novoPedido,
            });
        } catch (err) {
            next(err);
        }
    },

    getPedidoById: async (req, res, next) => {
        try {
            const pedido = await Pedido.findByPk(req.params.id, {
                include: [
                    {
                        model: Cliente,
                    },
                    {
                        model: ItemPedido,
                        include: ['Produto'],
                    },
                ],
            });

            // 404 e não 403 quando o pedido é de outro cliente: revelar a
            // existência já vazaria o histórico de terceiros.
            if (!pedido || !ehDonoDoPedido(pedido, req)) {
                return res.status(404).json({ message: 'Pedido não encontrado' });
            }

            res.json(pedido);
        } catch (err) {
            next(err);
        }
    },

    getAllPedidos: async (req, res, next) => {
        try {
            const { status, cliente_id } = req.query;
            const where = {};

            if (status) where.status = status;

            // A rota já valida isso (validarQueryInteiro). Repetir aqui é defesa em
            // profundidade: se este controller for montado noutra rota, um
            // ?status[$ne]=cancelado deixaria de ser string e viraria operador
            // Sequelize válido.
            if (status && !STATUS_VALIDOS.includes(status)) {
                throw falha(400, 'Status inválido');
            }

            // O filtro ?cliente_id= só vale para admin; para o user ele é
            // sobrescrito pelo vínculo da conta, senão bastaria trocar a query
            // para ler os pedidos de qualquer um.
            if (ehAdmin(req)) {
                if (cliente_id !== undefined && cliente_id !== '' && !ehInteiroPositivo(cliente_id)) {
                    throw falha(400, 'Parâmetro "cliente_id" inválido');
                }
                if (cliente_id) where.cliente_id = cliente_id;
            } else {
                where.cliente_id = exigirCliente(req);
            }

            const pag = parsePaginacao(req.query);

            const { rows: pedidos, count: total } = await Pedido.findAndCountAll({
                where,
                include: [
                    {
                        model: Cliente,
                    },
                ],
                order: [['data', 'DESC']],
                limit: pag.limite,
                offset: pag.offset,
                distinct: true,
            });

            res.json({
                pedidos,
                paginacao: metadados(pag, total),
            });
        } catch (err) {
            next(err);
        }
    },

    updatePedido: async (req, res, next) => {
        try {
            const { forma_pagamento, tipo_entrega } = req.body;
            const itens = normalizarItens(req.body);

            const pedido = await Pedido.findByPk(req.params.id);

            // Mesma regra do getPedidoById: pedido de terceiro não existe para
            // quem não é dono.
            if (!pedido || !ehDonoDoPedido(pedido, req)) {
                return res.status(404).json({ message: 'Pedido não encontrado' });
            }

            // Checagem antecipada: evita abrir transação para uma edição que
            // seria recusada de qualquer forma. O serviço revalida com a linha
            // travada, que é a garantia real.
            if (!podeEditarPedido(pedido, req)) {
                const motivo = STATUS_EDITAVEIS.includes(pedido.status)
                    ? 'O prazo de 3 dias para alterar este pedido encerrou'
                    : 'Só pedidos pendentes podem ser alterados';
                throw falha(403, motivo);
            }

            // Contato é opcional na edição: sem reenvio, o snapshot já gravado
            // no pedido é preservado (utils/contato devolve dados vazio).
            const { erro, dados: contato } = validarContato(lerContato(req.body), { obrigatorio: false });
            if (erro) throw falha(400, erro);

            const atualizado = await editarPedido(
                req.params.id,
                { forma_pagamento, tipo_entrega, itens, contato, endereco: lerEndereco(req.body) },
                { prazoObrigatorio: !ehAdmin(req) }
            );

            res.json({ message: 'Pedido atualizado', pedido: atualizado });
        } catch (err) {
            next(err);
        }
    },

    updatePedidoStatus: async (req, res, next) => {
        try {
            // Transição de status é operação de loja: o cliente não empurra o
            // próprio pedido para "enviado".
            exigirAdmin(req);
            const pedido = await mudarStatus(req.params.id, req.body.status);
            res.json({ message: 'Status atualizado', pedido });
        } catch (err) {
            next(err);
        }
    },

    // Cancelamento é operação do DONO do pedido, não só da loja: foi o que
    // separated do PUT /:id/status, que exige admin. Reaproveita
    // services/pedidoService.mudarStatus — a devolução de estoque e o lock
    // pessimista que impedem o cancelamento em duplicidade já estão lá.
    cancelarPedido: async (req, res, next) => {
        try {
            const pedido = await Pedido.findByPk(req.params.id);

            // Mesmo tratamento do getPedidoById: pedido de terceiro é 404, não
            // 403, para não confirmar a existência de um pedido que não é seu.
            if (!pedido || !ehDonoDoPedido(pedido, req)) {
                return res.status(404).json({ message: 'Pedido não encontrado' });
            }

            // Recusa antecipada, só para devolver a mensagem certa (status vs.
            // prazo vs. titularidade). A garantia real continua sendo o
            // transicaoValida dentro da transação do serviço.
            const recusa = erroCancelamento(pedido, req);
            if (recusa) throw falha(recusa.status, recusa.message);

            const cancelado = await mudarStatus(pedido.id, 'cancelado');

            res.json({ message: 'Pedido cancelado', pedido: cancelado });
        } catch (err) {
            next(err);
        }
    },

    deletePedido: async (req, res, next) => {
        try {
            exigirAdmin(req);
            await excluirPedido(req.params.id);
            res.json({ message: 'Pedido deletado com sucesso' });
        } catch (err) {
            next(err);
        }
    },

    getRelatorioVendas: async (req, res, next) => {
        try {
            // Resumo de faturamento é visão gerencial: só admin.
            exigirAdmin(req);

            const { dataInicio, dataFim } = req.query;
            const where = {};

            if (dataInicio || dataFim) {
                if (!dataInicio || !dataFim) {
                    throw falha(400, 'Informe dataInicio e dataFim para filtrar o período');
                }

                const { erro, inicio, fim } = periodoRelatorio(dataInicio, dataFim);
                if (erro) {
                    throw falha(400, erro);
                }

                // Intervalo semiaberto [inicio, fim): cobre o dia inteiro
                // sem depender de hora e sem sofrer com milissegundos.
                where.data = { [Op.gte]: inicio, [Op.lt]: fim };
            }

            // Pedido cancelado não é venda: fora do resumo e fora da listagem.
            where.status = { [Op.ne]: 'cancelado' };

            const pag = parsePaginacao(req.query);

            // Agregados calculados no banco, sem carregar todos os registros
            const [agregado] = await Pedido.findAll({
                where,
                attributes: [
                    [fn('COALESCE', fn('SUM', col('valor_total')), 0), 'total_vendas'],
                    [fn('COUNT', col('id')), 'total_pedidos'],
                ],
                raw: true,
            });

            const pedidos = await Pedido.findAll({
                where,
                attributes: ['id', 'data', 'status', 'valor_total', 'forma_pagamento'],
                include: [
                    { model: Cliente, attributes: ['nome'] },
                ],
                order: [['data', 'DESC']],
                limit: pag.limite,
                offset: pag.offset,
            });

            const totalVendas = parseFloat(agregado.total_vendas);
            const totalPedidos = parseInt(agregado.total_pedidos, 10);

            res.json({
                resumo: {
                    total_vendas: totalVendas,
                    total_pedidos: totalPedidos,
                    valor_medio: mediaEmCentavos(totalVendas, totalPedidos),
                },
                paginacao: metadados(pag, totalPedidos),
                pedidos,
            });
        } catch (err) {
            next(err);
        }
    },
};

module.exports = pedidoController;
