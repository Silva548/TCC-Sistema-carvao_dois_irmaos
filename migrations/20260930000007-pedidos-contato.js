'use strict';

// O pedido passa a carregar uma cópia dos dados de contato do cliente no
// momento do envio (nome, e-mail e telefone/WhatsApp). É a garantia de que a
// loja consegue falar com quem comprou mesmo que o cadastro do cliente seja
// alterado depois — a referência continua sendo clientes.cliente_id, mas a
// folha de contato do pedido é histórica.
//
// Nulável: o admin e a API continuam podendo criar pedido sem contato; quem
// exige é o fluxo do cliente comum (ver controllers/pedido*Controller e
// services/pedidoService).

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn('pedidos', 'contato_nome', {
            type: Sequelize.STRING(255),
            allowNull: true,
        });
        await queryInterface.addColumn('pedidos', 'contato_email', {
            type: Sequelize.STRING(255),
            allowNull: true,
        });
        await queryInterface.addColumn('pedidos', 'contato_telefone', {
            type: Sequelize.STRING(20),
            allowNull: true,
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('pedidos', 'contato_telefone');
        await queryInterface.removeColumn('pedidos', 'contato_email');
        await queryInterface.removeColumn('pedidos', 'contato_nome');
    },
};
