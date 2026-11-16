const { Cliente } = require('../models');
const { clienteObrigatorio } = require('../utils/permissoes');
const { excedeTexto } = require('../utils/limites');
const { EMAIL_REGEX } = require('../utils/contato');
const { texto } = require('../utils/entrada');

// O cliente comum só mexe nos próprios dados de contato. Documento e tipo
// ficam de fora de propósito: mudam a identidade fiscal da conta e são
// território do admin (controllers/clienteSequelizeController).
const CAMPOS_EDITAVEIS = ['nome', 'email', 'telefone'];

const validarPerfil = (body) => {
    const nome = texto(body.nome);
    const email = texto(body.email).toLowerCase();
    const telefone = texto(body.telefone);

    for (const campo of CAMPOS_EDITAVEIS) {
        const limite = excedeTexto('cliente', campo, { nome, email, telefone }[campo]);
        if (limite) return { erro: limite };
    }

    if (!nome) return { erro: 'O nome é obrigatório' };
    if (!email || !EMAIL_REGEX.test(email)) return { erro: 'Informe um e-mail válido' };

    // Telefone é opcional (o pedido exige o WhatsApp, mas o cadastro não).
    return { dados: { nome, email, telefone: telefone || null } };
};

const mensagemSemVinculo = 'Sua conta ainda não está vinculada a um cliente. Procure o administrador.';

const perfilController = {

    renderEditForm: async (req, res, next) => {
        try {
            const clienteId = clienteObrigatorio(req);
            if (clienteId === null) {
                return res.render('perfil/edit', {
                    cliente: null,
                    erro: mensagemSemVinculo,
                    submetido: null,
                    salvo: false,
                });
            }

            const cliente = await Cliente.findByPk(clienteId);
            if (!cliente) {
                return res.status(404).render('404');
            }

            res.render('perfil/edit', {
                cliente,
                erro: null,
                submetido: null,
                salvo: req.query.salvo === '1',
            });
        } catch (err) {
            next(err);
        }
    },

    updatePerfil: async (req, res, next) => {
        try {
            const clienteId = clienteObrigatorio(req);
            if (clienteId === null) {
                return res.status(403).render('perfil/edit', {
                    cliente: null,
                    erro: mensagemSemVinculo,
                    submetido: req.body,
                    salvo: false,
                });
            }

            const cliente = await Cliente.findByPk(clienteId);
            if (!cliente) {
                return res.status(404).render('404');
            }

            const { dados, erro } = validarPerfil(req.body);
            if (erro) {
                return res.status(400).render('perfil/edit', { cliente, erro, submetido: req.body, salvo: false });
            }

            await cliente.update(dados);
            res.redirect('/meus-dados?salvo=1');
        } catch (err) {
            if (err.name === 'SequelizeUniqueConstraintError') {
                // Re-busca: renderizar só { id } apagaria o formulário.
                const atual = await Cliente.findByPk(clienteObrigatorio(req));
                return res.status(400).render('perfil/edit', {
                    cliente: atual,
                    erro: 'E-mail já cadastrado em outro cliente',
                    submetido: req.body,
                    salvo: false,
                });
            }
            next(err);
        }
    },
};

module.exports = perfilController;
