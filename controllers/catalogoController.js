// Catálogo do cliente comum.
//
//(/produtos é do admin: cadastrar/editar/listar. O cliente comum não tem
// permissão nenhuma ali — app.js monta as rotas com requireRole('admin').)
// Este controller é a contraparte de leitura, com o mesmo produtos mas sem
// qualquer ação de escrita: aqui não existe cadastro, edição nem exclusão.

const { Produto, Categoria, Cliente } = require('../models');
const { ehAdmin, clienteIdDoUsuario } = require('../utils/permissoes');
const { FORMAS_PAGAMENTO, TIPOS_ENTREGA } = require('../utils/pedidoRules');

// Dados que as duas telas do catálogo compartilham com o carrinho. Os defaults
// de produtos/pedidos ficam zerados porque o que a ficha precisa deles é vazio.
const contextoCarrinho = () => ({
    carrinho: true,
    formasPagamento: FORMAS_PAGAMENTO,
    tiposEntrega: TIPOS_ENTREGA,
    cliente: null,
    produtos: [],
    pedidos: [],
});

const catalogoController = {
    // Ficha do produto, com o seletor de quantidade.
    //
    // O estoque e o preço vêm do banco agora, e é só isso que a tela mostra: o
    // carrinho manda produto/quantidade e o pedido é recalculado no servidor
    // (services/pedidoService), então nada aqui é fonte de verdade de preço.
    verProduto: async (req, res, next) => {
        try {
            const produto = await Produto.findByPk(req.params.id, {
                include: [{ model: Categoria, as: 'Categoria', attributes: ['nome'] }],
            });

            if (!produto) {
                return res.status(404).render('404');
            }

            // Admin também pode abrir a ficha (o card existe na home dele só
            // que sem catálogo), mas a página é do cliente: sem carrinho e sem
            // aba de pedidos.
            const ehCliente = !ehAdmin(req);
            const clienteId = clienteIdDoUsuario(req);
            const cliente = ehCliente && clienteId !== null
                ? await Cliente.findByPk(clienteId, { attributes: ['nome', 'email', 'telefone'] })
                : null;

            res.render('catalogo/produto', {
                produto,
                ...contextoCarrinho(),
                carrinho: ehCliente,
                cliente,
            });
        } catch (err) {
            next(err);
        }
    },
};

module.exports = catalogoController;