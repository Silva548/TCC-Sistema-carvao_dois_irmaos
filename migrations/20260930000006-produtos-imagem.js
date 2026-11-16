'use strict';

// Cada produto pode ter uma foto, usada nos cards do catálogo do cliente.
// A coluna é nulável de propósito: o upload é opcional e os produtos já
// cadastrados ficam com imagem nula (a view mostra um placeholder).

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn('produtos', 'imagem', {
            type: Sequelize.STRING(255),
            allowNull: true,
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('produtos', 'imagem');
    },
};
