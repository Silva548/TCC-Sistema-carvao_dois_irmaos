const { Cliente, Pedido, User } = require('../models');
const { Op } = require('sequelize');
const { parsePaginacao, metadados } = require('../utils/paginacao');
const { excedeTexto } = require('../utils/limites');
const { EMAIL_REGEX, validarDocumento } = require('../utils/contato');
const { redirecionarComErro, erroDaUrl } = require('../utils/responder');
const { ehViolacaoDeChaveEstrangeira } = require('../utils/dbErros');
const { texto } = require('../utils/entrada');

const TIPOS_VALIDOS = ['B2C', 'B2B'];

const validarCliente = (body) => {
    const nome = texto(body.nome);
    const email = texto(body.email).toLowerCase();
    const telefone = texto(body.telefone);

    // O limite de tamanho é conferido no texto que o usuário digitou; a
    // normalização do documento vem abaixo e é o que alimenta a gravação.
    for (const campo of ['nome', 'email', 'documento', 'telefone']) {
        const limite = excedeTexto('cliente', campo, {
            nome, email, telefone, documento: texto(body.documento),
        }[campo]);
        if (limite) return { erro: limite };
    }

    if (!nome) return { erro: 'O nome é obrigatório' };
    if (!email || !EMAIL_REGEX.test(email)) return { erro: 'Informe um e-mail válido' };

    // Compartilhado com o cadastro público: sem normalizar, o mesmo CPF
    // passaria pelo índice UNIQUE duas vezes, só que com pontuação diferente.
    const documento = validarDocumento(body.documento);
    if (documento.erro) return { erro: documento.erro };

    return {
        dados: {
            nome,
            email,
            documento: documento.dados.documento,
            telefone: telefone || null,
            tipo: TIPOS_VALIDOS.includes(body.tipo) ? body.tipo : 'B2C',
        },
    };
};

const clienteController = {

    createCliente: async (req, res, next) => {
        try {
            const { dados, erro } = validarCliente(req.body);
            if (erro) {
                return res.status(400).render('clientes/create', { erro, submetido: req.body });
            }

            await Cliente.create(dados);
            res.redirect('/clientes');
        } catch (err) {
            if (err.name === 'SequelizeUniqueConstraintError') {
                return res.status(400).render('clientes/create', { erro: 'E-mail ou documento já cadastrado', submetido: req.body });
            }
            next(err);
        }
    },

    getClienteById: async (req, res, next) => {
        try {
            const cliente = await Cliente.findByPk(req.params.id, {
            });

            if (!cliente) {
                return res.status(404).render('404');
            }

            res.render('clientes/show', { cliente });
        } catch (err) {
            next(err);
        }
    },

    getAllClientes: async (req, res, next) => {
        try {
            const pag = parsePaginacao(req.query);
            const { rows: clientes, count } = await Cliente.findAndCountAll({
                order: [['nome', 'ASC']],
                limit: pag.limite,
                offset: pag.offset,
            });

            res.render('clientes/index', {
                clientes,
                paginacao: metadados(pag, count),
                erro: erroDaUrl(req),
            });
        } catch (err) {
            next(err);
        }
    },

    renderCreateForm: (req, res) => {
        // O local se chama `submetido`, e não `body`: `body` é reservado pelo
        // express-ejs-layouts e, se vier nas locals, o layout é ignorado (a
        // página sai sem navbar). Precisa existir sempre (mesmo null), pois as
        // views leem `submetido && submetido.campo`.
        res.render('clientes/create', { erro: null, submetido: null });
    },

    renderEditForm: async (req, res, next) => {
        try {
            const cliente = await Cliente.findByPk(req.params.id, {
            });

            if (!cliente) {
                return res.status(404).render('404');
            }

            res.render('clientes/edit', { cliente, erro: null, submetido: null });
        } catch (err) {
            next(err);
        }
    },

    updateCliente: async (req, res, next) => {
        try {
            const clienteId = req.params.id;
            const cliente = await Cliente.findByPk(clienteId);

            if (!cliente) {
                return res.status(404).render('404');
            }

            const { dados, erro } = validarCliente(req.body);
            if (erro) {
                return res.status(400).render('clientes/edit', { cliente, erro, submetido: req.body });
            }

            await cliente.update(dados);
            res.redirect('/clientes');
        } catch (err) {
            if (err.name === 'SequelizeUniqueConstraintError') {
                // Re-busca a entidade completa: renderizar apenas { id } faria o
                // formulário voltar em branco e apagar o que o usuário digitou
                const atual = await Cliente.findByPk(req.params.id);
                return res.status(400).render('clientes/edit', {
                    cliente: atual || { id: req.params.id },
                    erro: 'E-mail ou documento já cadastrado',
                    submetido: req.body,
                });
            }
            next(err);
        }
    },

    deleteCliente: async (req, res, next) => {
        try {
            const cliente = await Cliente.findByPk(req.params.id);
            if (!cliente) {
                return res.status(404).render('404');
            }

            const pedidos = await Pedido.count({ where: { cliente_id: cliente.id } });
            if (pedidos > 0) {
                return redirecionarComErro(
                    res,
                    '/clientes',
                    `Não é possível excluir ${cliente.nome}: existem ${pedidos} pedido(s) vinculados. Exclua os pedidos antes — cancelá-los não basta, porque o pedido continua apontando para o cliente.`
                );
            }

            // A conta de acesso representa o cliente (users.cliente_id, FK
            // RESTRICT). Enquanto ela existir, o DELETE é recusado pelo banco;
            // a checagem aqui só troca o erro cru por uma instrução útil.
            const usuarios = await User.count({ where: { cliente_id: cliente.id } });
            if (usuarios > 0) {
                return redirecionarComErro(
                    res,
                    '/clientes',
                    `Não é possível excluir ${cliente.nome}: existe ${usuarios} usuário(s) de acesso vinculado(s). Edite o usuário e troque ou remova o vínculo antes.`
                );
            }

            try {
                await cliente.destroy();
            } catch (err) {
                // A contagem acima e o destroy não são atômicos: um pedido ou
                // usuário criado entre os dois faz o banco recusar o DELETE.
                // Sem este tratamento, essa corrida vira 500 em vez do mesmo 400.
                if (ehViolacaoDeChaveEstrangeira(err)) {
                    return redirecionarComErro(
                        res,
                        '/clientes',
                        `Não é possível excluir ${cliente.nome}: um pedido ou usuário foi vinculado enquanto a exclusão era processada.`
                    );
                }
                throw err;
            }

            res.redirect('/clientes');
        } catch (err) {
            next(err);
        }
    },

    searchByName: async (req, res, next) => {
        try {
            const nome = texto(req.query.nome);

            if (!nome) {
                return res.status(400).json({ error: 'Nome para busca é obrigatório' });
            }

            const escaped = nome
                .replace(/\\/g, '\\\\')
                .replace(/%/g, '\\%')
                .replace(/_/g, '\\_');

            const pag = parsePaginacao(req.query);
            const { rows: clientes, count } = await Cliente.findAndCountAll({
                where: {
                    nome: {
                        [Op.iLike]: `%${escaped}%`,
                    },
                },
                limit: pag.limite,
                offset: pag.offset,
            });

            res.json({ clientes, paginacao: metadados(pag, count) });
        } catch (err) {
            next(err);
        }
    },
};

module.exports = clienteController;
