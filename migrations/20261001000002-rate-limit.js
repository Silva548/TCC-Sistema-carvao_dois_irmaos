'use strict';

// Persistência dos contadores de rate limit.
//
// O MemoryStore padrão do express-rate-limit vive no heap do processo: um
// restart zera todas as janelas (janela de 15 minutos encerra na hora), e com
// mais de uma instância cada uma conta os mesmos clientes por conta própria —
// deploy novo, limite novo. Guardar no Postgres resolve os dois.
//
// chave é o identificador do cliente já prefixado pelo próprio limitador
// ("login:1.2.3.4", "cadastro:1.2.3.4", "global:1.2.3.4"), o que impede duas
// rotas de colidirem no mesmo IP. reset_at é timestamp absoluto em vez de TTL
// porque a expiração precisa ser comparável no WHERE do próprio banco.

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('rate_limit', {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                autoIncrement: true,
                allowNull: false,
            },
            chave: {
                type: Sequelize.STRING(255),
                allowNull: false,
                unique: true,
            },
            total_hits: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            reset_at: {
                type: Sequelize.DATE,
                allowNull: false,
            },
            created_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.fn('NOW'),
            },
            updated_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.fn('NOW'),
            },
        });

        // A limpeza periodica apaga por reset_at; sem este indice seria
        // seqscan na tabela inteira a cada rodada.
        await queryInterface.addIndex('rate_limit', ['reset_at'], {
            name: 'idx_rate_limit_reset_at',
        });
    },

    async down(queryInterface) {
        await queryInterface.removeIndex('rate_limit', 'idx_rate_limit_reset_at');
        await queryInterface.dropTable('rate_limit');
    },
};