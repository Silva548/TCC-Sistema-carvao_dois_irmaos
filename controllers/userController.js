const bcrypt = require('bcryptjs');
const { BCRYPT_COST, SENHA_MINIMA } = require('../utils/credenciais');
const { Op } = require('sequelize');
const { sequelize, User, Cliente } = require('../models');
const { parsePaginacao, metadados } = require('../utils/paginacao');
const { excedeTexto } = require('../utils/limites');
const { redirecionarComErro, erroDaUrl } = require('../utils/responder');
const { texto, textoSenha } = require('../utils/entrada');

const ROLES_VALIDOS = ['admin', 'user'];

// Clientes disponíveis para vincular (só fazem sentido para o papel user).
// Admin não representa cliente, então a lista nem é carregada nesse caso.
const listarClientes = () => Cliente.findAll({ order: [['nome', 'ASC']], attributes: ['id', 'nome'] });

// Valida o vínculo com base no papel:
//   user  -> cliente_id obrigatório e existente (sem ele o usuário não enxerga
//            nem cria pedido);
//   admin -> sempre null (admin não é cliente).
// Devolve { clienteId } ou { erro }.
const resolverCliente = async (role, clienteIdBruto) => {
    if (role === 'admin') {
        return { clienteId: null };
    }

    const clienteId = Number(clienteIdBruto);
    if (!Number.isInteger(clienteId) || clienteId < 1) {
        return { erro: 'Selecione o cliente vinculado a este usuário' };
    }

    const cliente = await Cliente.findByPk(clienteId, { attributes: ['id'] });
    if (!cliente) {
        return { erro: 'Cliente informado não existe' };
    }

    return { clienteId };
};

// Trava todos os admins em ordem de id antes de contar/alterar. Sem isso, duas
// requisições concorrentes (rebaixar/excluir os dois últimos admins) podiam
// ambas ver "ainda resta um" e deixar o sistema sem administrador.
const travarAdmins = (transaction) => User.findAll({
    where: { role: 'admin' },
    attributes: ['id'],
    order: [['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
});

const contarOutrosAdmins = (admins, user) =>
    admins.filter((admin) => String(admin.id) !== String(user.id)).length;

const userController = {
    renderCreateForm: async (req, res, next) => {
        try {
            res.render('users/create', { erro: null, submetido: null, clientes: await listarClientes() });
        } catch (err) {
            next(err);
        }
    },

    createUser: async (req, res, next) => {
        try {
            const username = texto(req.body.username);
            const password = textoSenha(req.body.password);
            const role = req.body.role;
            // `role` inválido não é erro: cai no padrão 'user' (comportamento antigo)
            const papel = ROLES_VALIDOS.includes(role) ? role : 'user';

            if (!username || !password) {
                return res.status(400).render('users/create', {
                    erro: 'Usuário e senha são obrigatórios',
                    // `password` nunca é reenviado ao formulário
                    submetido: { username, role },
                    clientes: await listarClientes(),
                });
            }

            const limite = excedeTexto('usuario', 'username', username);
            if (limite) {
                return res.status(400).render('users/create', {
                    erro: limite,
                    submetido: { username, role },
                    clientes: await listarClientes(),
                });
            }

            if (password.length < SENHA_MINIMA) {
                return res.status(400).render('users/create', {
                    erro: `A senha deve ter no mínimo ${SENHA_MINIMA} caracteres`,
                    submetido: { username, role },
                    clientes: await listarClientes(),
                });
            }

            const { clienteId, erro: erroCliente } = await resolverCliente(papel, req.body.cliente_id);
            if (erroCliente) {
                return res.status(400).render('users/create', {
                    erro: erroCliente,
                    submetido: { username, role, cliente_id: req.body.cliente_id },
                    clientes: await listarClientes(),
                });
            }

            await User.create({
                username,
                password: await bcrypt.hash(password, BCRYPT_COST),
                role: papel,
                cliente_id: clienteId,
            });

            res.redirect('/users');
        } catch (err) {
            if (err.name === 'SequelizeUniqueConstraintError') {
                return res.status(400).render('users/create', {
                    erro: 'Nome de usuário já cadastrado',
                    submetido: { username: texto(req.body.username), role: req.body.role, cliente_id: req.body.cliente_id },
                    clientes: await listarClientes(),
                });
            }
            next(err);
        }
    },

    getAllUsers: async (req, res, next) => {
        try {
            const pag = parsePaginacao(req.query);
            const { rows: users, count } = await User.findAndCountAll({
                order: [['username', 'ASC']],
                attributes: { exclude: ['password'] },
                include: [{ model: Cliente, as: 'Cliente', attributes: ['id', 'nome'] }],
                limit: pag.limite,
                offset: pag.offset,
            });

            res.render('users/index', {
                users,
                paginacao: metadados(pag, count),
                erro: erroDaUrl(req),
            });
        } catch (err) {
            next(err);
        }
    },

    getUserById: async (req, res, next) => {
        try {
            const user = await User.findByPk(req.params.id, {
                attributes: { exclude: ['password'] },
                include: [{ model: Cliente, as: 'Cliente', attributes: ['id', 'nome'] }],
            });

            if (!user) {
                return res.status(404).render('404');
            }

            res.render('users/show', { user });
        } catch (err) {
            next(err);
        }
    },

    renderEditForm: async (req, res, next) => {
        try {
            const user = await User.findByPk(req.params.id, {
                attributes: { exclude: ['password'] },
            });

            if (!user) {
                return res.status(404).render('404');
            }

            res.render('users/edit', { user, erro: null, submetido: null, clientes: await listarClientes() });
        } catch (err) {
            next(err);
        }
    },

    updateUser: async (req, res, next) => {
        let t;
        let finalizada = false;
        try {
            t = await sequelize.transaction();
            const admins = await travarAdmins(t);
            const user = await User.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });

            if (!user) {
                return res.status(404).render('404');
            }

            const username = texto(req.body.username);
            const password = textoSenha(req.body.password);
            const role = req.body.role;
            // `password` nunca é reenviado ao formulário
            const submetido = { username, role, cliente_id: req.body.cliente_id };
            const papel = ROLES_VALIDOS.includes(role) ? role : user.role;

            if (!username) {
                return res.status(400).render('users/edit', {
                    user,
                    erro: 'O nome de usuário é obrigatório',
                    submetido,
                    clientes: await listarClientes(),
                });
            }

            const limite = excedeTexto('usuario', 'username', username);
            if (limite) {
                return res.status(400).render('users/edit', {
                    user,
                    erro: limite,
                    submetido,
                    clientes: await listarClientes(),
                });
            }

            // Rebaixar o único admin deixaria o sistema sem gestão de usuários
            const rebaixandoUltimoAdmin = user.role === 'admin'
                && papel !== 'admin'
                && contarOutrosAdmins(admins, user) === 0;

            if (rebaixandoUltimoAdmin) {
                return res.status(400).render('users/edit', {
                    user,
                    erro: 'Não é possível rebaixar o único administrador do sistema',
                    submetido,
                    clientes: await listarClientes(),
                });
            }

            const { clienteId, erro: erroCliente } = await resolverCliente(papel, req.body.cliente_id);
            if (erroCliente) {
                return res.status(400).render('users/edit', {
                    user,
                    erro: erroCliente,
                    submetido,
                    clientes: await listarClientes(),
                });
            }

            const dados = {
                username,
                role: papel,
                cliente_id: clienteId,
            };

            // Só altera a senha se uma nova for informada
            if (password && password.trim() !== '') {
                if (password.length < SENHA_MINIMA) {
                    return res.status(400).render('users/edit', {
                        user,
                        erro: `A nova senha deve ter no mínimo ${SENHA_MINIMA} caracteres`,
                        submetido,
                        clientes: await listarClientes(),
                    });
                }
                dados.password = await bcrypt.hash(password, BCRYPT_COST);
            }

            await user.update(dados, { transaction: t });
            await t.commit();
            finalizada = true;
            res.redirect('/users');
        } catch (err) {
            if (t && !finalizada) {
                await t.rollback().catch(() => {});
                finalizada = true;
            }
            if (err.name === 'SequelizeUniqueConstraintError') {
                const atual = await User.findByPk(req.params.id);
                return res.status(400).render('users/edit', {
                    user: atual || { id: req.params.id },
                    erro: 'Nome de usuário já cadastrado',
                    submetido: { username: texto(req.body.username), role: req.body.role, cliente_id: req.body.cliente_id },
                    clientes: await listarClientes(),
                });
            }
            next(err);
        } finally {
            if (t && !finalizada) {
                await t.rollback().catch(() => {});
            }
        }
    },

    deleteUser: async (req, res, next) => {
        let t;
        let finalizada = false;
        try {
            // Impede que o usuário logado exclua a própria conta. Antes isto
            // saía como text/plain 400, abrindo uma página crua no navegador;
            // agora volta para a lista com a mensagem, como cliente/produto/
            // categoria já fazem via utils/responder.
            if (String(req.session.userId) === String(req.params.id)) {
                return redirecionarComErro(res, '/users', 'Você não pode excluir sua própria conta enquanto está autenticado');
            }

            t = await sequelize.transaction();
            const admins = await travarAdmins(t);
            const user = await User.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
            if (!user) {
                return res.redirect('/users');
            }

            // Impede que o sistema fique sem nenhum administrador
            if (user.role === 'admin' && contarOutrosAdmins(admins, user) === 0) {
                return redirecionarComErro(res, '/users', 'Não é possível excluir o único administrador do sistema');
            }

            await user.destroy({ transaction: t });
            await t.commit();
            finalizada = true;
            res.redirect('/users');
        } catch (err) {
            if (t && !finalizada) {
                await t.rollback().catch(() => {});
                finalizada = true;
            }
            next(err);
        } finally {
            if (t && !finalizada) {
                await t.rollback().catch(() => {});
            }
        }
    },

    searchUsers: async (req, res, next) => {
        try {
            const raw = texto(req.query.search);
            const escaped = raw
                .replace(/\\/g, '\\\\')
                .replace(/%/g, '\\%')
                .replace(/_/g, '\\_');

            const pag = parsePaginacao(req.query);
            const { rows: users, count } = await User.findAndCountAll({
                where: {
                    username: {
                        [Op.iLike]: `%${escaped}%`,
                    },
                },
                attributes: { exclude: ['password'] },
                limit: pag.limite,
                offset: pag.offset,
            });

            res.json({ users, paginacao: metadados(pag, count) });
        } catch (err) {
            next(err);
        }
    },
};

module.exports = userController;
