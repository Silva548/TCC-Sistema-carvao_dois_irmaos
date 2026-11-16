'use strict';

// O pedido passa a carregar o endereço de entrega.
//
// Modalidade do pedido decide se o endereço é usado: em 'retirada' o cliente
// vem até a loja e o endereço não tem sentido, então os campos ficam NULL. Não
// é obrigatório por padrão justamente por causa disso — um NOT NULL obrigaria
// a inventar um endereço em todo pedido de retirada.
//
// Colunas separadas e não um JSONB porque o endereço precisa ser consultável
// (relatório de pedidos por cidade), e porque é o mesmo raciocínio das três
// colunas de contato criadas na migration 20260930000007: cópia histórica no
// momento do pedido, não referência ao cadastro do cliente. Editar o endereço
// depois no cadastro não pode reescrever para onde a mercadoria foi entregue.

module.exports = {
    async up(queryInterface, Sequelize) {
        const colunas = [
            ['endereco_cep', Sequelize.STRING(9)],
            ['endereco_logradouro', Sequelize.STRING(255)],
            ['endereco_numero', Sequelize.STRING(20)],
            ['endereco_complemento', Sequelize.STRING(255)],
            ['endereco_bairro', Sequelize.STRING(120)],
            ['endereco_cidade', Sequelize.STRING(120)],
            ['endereco_uf', Sequelize.STRING(2)],
        ];

        for (const [nome, tipo] of colunas) {
            await queryInterface.addColumn('pedidos', nome, { type: tipo, allowNull: true });
        }
    },

    async down(queryInterface) {
        for (const nome of [
            'endereco_uf', 'endereco_cidade', 'endereco_bairro',
            'endereco_complemento', 'endereco_numero', 'endereco_logradouro', 'endereco_cep',
        ]) {
            await queryInterface.removeColumn('pedidos', nome);
        }
    },
};