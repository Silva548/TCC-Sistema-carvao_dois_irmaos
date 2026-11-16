const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Cliente = require('./clienteModel');

const Pedido = sequelize.define('Pedido', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    cliente_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: Cliente,
            key: 'id',
        },
        // RESTRICT, e não CASCADE: apagar um cliente não pode destruir o
        // histórico de vendas nem devolver o estoque por cascade. A mesma
        // regra está na migration 20260930000002 e em models/index.js.
        onDelete: 'RESTRICT',
    },
    data: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
    },
    status: {
        type: DataTypes.ENUM('pendente', 'processando', 'enviado', 'entregue', 'cancelado'),
        allowNull: false,
        defaultValue: 'pendente',
    },
    valor_total: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
    },
    forma_pagamento: {
        type: DataTypes.ENUM('credito', 'debito', 'pix', 'boleto', 'dinheiro'),
        allowNull: false,
    },
    tipo_entrega: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'entrega',
        comment: 'Modalidade do pedido: entrega no endereço ou retirada na empresa',
    },
    contato_nome: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'Cópia do nome informado pelo cliente no envio do pedido',
    },
    contato_email: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'Cópia do e-mail informado pelo cliente no envio do pedido',
    },
    contato_telefone: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: 'Cópia do telefone/WhatsApp informado pelo cliente no envio do pedido',
    },
    // Endereço de entrega. Nulo quando o pedido é de retirada: o cliente vem
    // buscar, então endereço não se aplica. Ver migration
    // 20261001000001-pedidos-endereco para o porquê de colunas separadas.
    endereco_cep: {
        type: DataTypes.STRING(9),
        allowNull: true,
        comment: 'CEP do endereço de entrega, sempre com a máscara do correio',
    },
    endereco_logradouro: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    endereco_numero: {
        // VARCHAR e não INTEGER: "123" e "S/N" e "123A" existem em endereço
        // real, e travar em número perderia o cadastro de quem não tem casa
        // numerada.
        type: DataTypes.STRING(20),
        allowNull: true,
    },
    endereco_complemento: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    endereco_bairro: {
        type: DataTypes.STRING(120),
        allowNull: true,
    },
    endereco_cidade: {
        type: DataTypes.STRING(120),
        allowNull: true,
    },
    endereco_uf: {
        type: DataTypes.STRING(2),
        allowNull: true,
        validate: {
            // Só a letra entra no banco. A lista completa está em
            // utils/endereco; aqui basta barrar o que claramente não é UF, que
            // é o erro de digitação. A checagem completa é do serviço, para
            // haver um único lugar decidindo o que é uma UF válida.
            isIn: {
                args: [['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT',
                    'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO']],
                msg: 'UF inválida',
            },
        },
    },
    createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
    updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
}, {
    tableName: 'pedidos',
    timestamps: true,
});

// Associações são definidas centralizadamente em models/index.js

module.exports = Pedido;
