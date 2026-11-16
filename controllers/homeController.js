// Home única com dois recortes.
//
// Admin: a página de sempre, com os atalhos de cadastro. User comum: catálogo
// de produtos em cards (com carrinho) e a aba "Meus pedidos". Visitante
// anônimo: só a apresentação, sem dados de ninguém.
//
// O catálogo lista TODOS os produtos, inclusive os sem estoque. Antes o filtro
// `estoque > 0` escondia o item, e isso já escondeu um produto real: a bolsa de
// 5kg premium "sumiu" da tela por ter acabado, sem nenhuma pista do motivo — o
// cliente só podia concluir que a loja não vendia aquilo. Marketplace de
// referência mostra o produto e marca "esgotado". Mesma informação, sem a
// leitura errada, e o card segue não-comprável (botão desabilitado).

const { Produto, Categoria, Pedido, Cliente } = require('../models');
const { ehAdmin, clienteObrigatorio } = require('../utils/permissoes');
const { FORMAS_PAGAMENTO, TIPOS_ENTREGA } = require('../utils/pedidoRules');

// Quantos pedidos recentes a aba "Meus pedidos" mostra. A lista completa fica
// em /pedidos (com filtro de status e paginação).
const PEDIDOS_RECENTES = 10;

const renderHome = async (req, res, next) => {
    try {
        // Sem login: apresentação. `ehAdmin` falso mantém a view no ramo público.
        if (!req.session.userId) {
            return res.render('index', {
                ehAdmin: false, produtos: [], pedidos: [], cliente: null, carrinho: false,
                formasPagamento: FORMAS_PAGAMENTO, tiposEntrega: TIPOS_ENTREGA,
            });
        }

        if (ehAdmin(req)) {
            return res.render('index', {
                ehAdmin: true, produtos: [], pedidos: [], cliente: null, carrinho: false,
                formasPagamento: FORMAS_PAGAMENTO, tiposEntrega: TIPOS_ENTREGA,
            });
        }

        const clienteId = clienteObrigatorio(req);

        const [produtos, pedidos, cliente] = await Promise.all([
            Produto.findAll({
                include: [{ model: Categoria, as: 'Categoria', attributes: ['nome'] }],
                order: [['nome', 'ASC']],
            }),
            clienteId === null
                ? []
                : Pedido.findAll({
                    where: { cliente_id: clienteId },
                    order: [['data', 'DESC'], ['id', 'DESC']],
                    limit: PEDIDOS_RECENTES,
                }),
            // Dados de contato pré-preenchidos no carrinho (o pedido exige
            // nome/e-mail/WhatsApp do cliente comum).
            clienteId === null ? null : Cliente.findByPk(clienteId, { attributes: ['nome', 'email', 'telefone'] }),
        ]);

        res.render('index', {
            ehAdmin: false,
            produtos,
            pedidos,
            cliente,
            carrinho: true,
            formasPagamento: FORMAS_PAGAMENTO,
            tiposEntrega: TIPOS_ENTREGA,
        });
    } catch (err) {
        next(err);
    }
};

module.exports = { renderHome };
