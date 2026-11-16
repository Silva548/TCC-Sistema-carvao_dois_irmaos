'use strict';

// O login do cliente passa a ter um dono: a conta "users" aponta para o registro
// em "clientes" que ela representa. É o que permite restringir o usuário comum
// aos próprios pedidos — sem esse vínculo, qualquer conta logada veria a fila
// inteira, porque antes "users" e "clientes" não tinham relação nenhuma.
//
// ON DELETE RESTRICT, pelo mesmo motivo de migration 20260930000002: um cliente
// com conta de acesso não pode sumir do banco, senão a conta órfã fica sem
// poder comprar e o histórico de pedidos perde o dono. Para desvincular, o
// admin edita a conta e escolhe outro cliente (ou nenhum, se virar admin).
//
// A coluna é nulável: administradores não são clientes, e as contas admin que já
// existem não têm a quem se ligar.

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn('users', 'cliente_id', {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: {
                model: 'clientes',
                key: 'id',
            },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('users', 'cliente_id');
    },
};
