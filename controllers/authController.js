const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { BCRYPT_COST, SENHA_MINIMA } = require('../utils/credenciais');
const { User, Cliente } = require('../models');
const { caminhoSeguro } = require('../utils/redirect');
const { excedeTexto } = require('../utils/limites');
// Mesma normalização de CPF/CNPJ que a tela do admin usa. Compartilhar é o que
// impede o índice UNIQUE de clientes.documento de ser contornado por pontuação:
// "123.456.789-01" pelo cadastro e "12345678901" pelo admin são o mesmo
// documento, mas strings diferentes, e o índice não reclamaria.
const { EMAIL_REGEX, validarDocumento } = require('../utils/contato');
const { texto, textoSenha } = require('../utils/entrada');
// Freio por conta, para o caso de um atacante variar de IP (ver o arquivo).
const throttleConta = require('../utils/throttleConta');

// Hash dummy: garante tempo de resposta constante mesmo quando o usuário não existe,
// impedindo enumeração de usuários por análise de tempo. Gerado com o mesmo
// BCRYPT_COST dos hashes reais — se fosse um custo fixo menor, o ramo "usuário
// inexistente" responderia mais rápido e voltaria a vazar por tempo.
const HASH_DUMMY = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

// Validação do formulário de cadastro.
//
// Devolve { erro } ou { dados }. É uma função à parte (e não um if dentro do
// handler) porque o POST precisa devolver o formulário preenchido com o mesmo
// texto de erro, e duplicar a checagem entre GET e POST é como um formulário
// acaba divergindo do que o servidor aceita.
const validarCadastro = (body = {}) => {
    const username = texto(body.username);
    const senha = textoSenha(body.password);
    const nome = texto(body.nome);
    const email = texto(body.email).toLowerCase();
    const telefone = texto(body.telefone);
    const documento = texto(body.documento);

    const campos = { username, nome, email, telefone, documento };
    for (const campo of ['username', 'nome', 'email', 'documento', 'telefone']) {
        const limite = excedeTexto(campo === 'username' ? 'usuario' : 'cliente', campo, campos[campo]);
        if (limite) return { erro: limite };
    }

    if (!username) return { erro: 'Escolha um nome de usuário' };
    if (!senha) return { erro: 'A senha é obrigatória' };
    if (senha.length < SENHA_MINIMA) return { erro: `A senha deve ter no mínimo ${SENHA_MINIMA} caracteres` };

    if (!nome) return { erro: 'O nome é obrigatório' };
    if (!email || !EMAIL_REGEX.test(email)) return { erro: 'Informe um e-mail válido' };
    if (!telefone) return { erro: 'O WhatsApp é obrigatório' };

    const documentoValidado = validarDocumento(documento);
    if (documentoValidado.erro) return { erro: documentoValidado.erro };

    return { dados: { username, senha, nome, email, documento: documentoValidado.dados.documento, telefone } };
};

const authController = {
    renderLoginForm: (req, res) => {
        if (req.session.userId) {
            return res.redirect('/');
        }

        // Token CSRF gerado sob demanda (só quando o formulário é exibido),
        // evitando criar sessão em toda visita anônima
        if (!req.session.csrfToken) {
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        }

        const erro = req.session.flashError || null;
        delete req.session.flashError;
        // `next` chega pela query de quem foi redirecionado para cá; caminho
        //Seguro descarta o que não for um caminho interno
        const proximo = caminhoSeguro(req.query.next, '');
        res.render('login', { erro, csrfToken: req.session.csrfToken, proximo });
    },

    login: async (req, res, next) => {
        try {
            const username = texto(req.body.username);
            const password = textoSenha(req.body.password);

            if (!username || !password) {
                req.session.flashError = 'Informe usuário e senha';
                return res.redirect('/login');
            }

            // O freio por conta age AQUI, antes do bcrypt. Consultar depois da
            // comparação não adiantaria nada: o ataque continuaria gastando CPU a
            // cada tentativa e a senha seria conferida de qualquer jeito — o
            // limite só mudaria a mensagem da tela. Este é o ponto que
            // interrompe de fato o credential stuffing.
            //
            // A checagem vem antes até do findOne de propósito: uma conta
            // trancada não gasta consulta nem hash, e a resposta é a mesma para
            // conta existente e inexistente (o contador sobe para as duas), então
            // não vira oráculo de existência.
            const conta = await throttleConta.consultar(username);
            if (conta.bloqueado) {
                const minutos = Math.max(1, Math.ceil((conta.resetAt - Date.now()) / 60000));
                req.session.flashError =
                    `Muitas tentativas para esta conta. Tente novamente em ${minutos} minuto(s).`;
                return res.redirect('/login');
            }

            const user = await User.findOne({ where: { username } });
            const senhaValida = await bcrypt.compare(password, (user && user.password) || HASH_DUMMY);

            if (!senhaValida) {
                // A conta existe ou não, o contador sobe nos dois casos: a resposta é a mesma
                // e o custo é o mesmo (bcrypt contra o HASH_DUMMY), então contar
                // sempre não vira oráculo.
                await throttleConta.registrarFalha(username);
                req.session.flashError = 'Usuário ou senha inválidos';

                return res.redirect('/login');
            }

            // Sucesso: o histórico de falhas deixa de contar.
            await throttleConta.limpar(username);

            // Regenera a sessão para prevenir session fixation.
            // csrfToken precisa ser capturado ANTES do regenerate: ele destrói
            // a sessão anterior e cria uma nova, então qualquer valor lido
            // depois dela simplesmente não existe mais.
            const { csrfToken } = req.session;
            const destino = caminhoSeguro(req.body.next, '/');

            req.session.regenerate((err) => {
                if (err) {
                    return next(err);
                }
                req.session.csrfToken = csrfToken;
                req.session.userId = user.id;
                req.session.username = user.username;
                req.session.role = user.role;

                res.redirect(destino);
            });
        } catch (err) {
            next(err);
        }
    },

    logout: (req, res) => {
        req.session.destroy((err) => {
            if (err) {
                console.error('[Erro] Falha ao destruir sessão:', err);
            }
            res.clearCookie('sessionId');
            res.redirect('/login');
        });
    },

    renderCadastroForm: (req, res) => {
        if (req.session.userId) {
            return res.redirect('/');
        }

        if (!req.session.csrfToken) {
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        }

        const erro = req.session.flashCadastroErro || null;
        delete req.session.flashCadastroErro;
        res.render('cadastro', {
            erro,
            submetido: null,
            csrfToken: req.session.csrfToken,
        });
    },

    // Cadastro público de conta de CLIENTE.
    //
    // O papel é a constante 'user', escrita aqui no servidor e nunca lida do
    // corpo da requisição. Se o `role` viesse de req.body, qualquer um poderia
    // se cadastrar como admin com um POST a mais — o campo não precisa nem
    // aparecer no formulário, porque um POST direto o enviaria do mesmo jeito.
    // O controlador é que não deve dar essa porta. Contas de admin continuam
    // sendo criadas pelo seed (seeds/seedDatabase.js) e pela tela /users, que é
    // do admin.
    //
    // Cliente e User nascem na mesma transação: um user sem cliente não consegue
    // comprar nada (utils/permissoes -> clienteObrigatorio), então deixar a
    // conta órfã seria criar uma conta que não funciona.
    cadastro: async (req, res, next) => {
        // A transação nasce DENTRO do try: `sequelize.transaction()` é async e
        // pode rejeitar, e uma rejeição aqui ficaria fora do next(err).
        let transacao;
        try {
            // A validação também fica dentro do try de propósito: validarCadastro
            // roda código síncrono sobre req.body e, num handler async, um throw
            // fora do try vira unhandledRejection — o Express 4 não trata e o
            // processo cai. Validar aqui garante que erros de entrada sejam 400,
            // nunca uma queda.
            const { erro, dados } = validarCadastro(req.body);

            if (erro) {
                return res.status(400).render('cadastro', {
                    erro,
                    // `senha` nunca volta para o formulário.
                    submetido: { ...req.body, password: undefined },
                    csrfToken: req.session.csrfToken,
                });
            }

            transacao = await Cliente.sequelize.transaction();

            const cliente = await Cliente.create({
                nome: dados.nome,
                email: dados.email,
                documento: dados.documento,
                telefone: dados.telefone,
                tipo: 'B2C',
            }, { transaction: transacao });

            await User.create({
                username: dados.username,
                password: await bcrypt.hash(dados.senha, BCRYPT_COST),
                role: 'user',
                cliente_id: cliente.id,
            }, { transaction: transacao });

            await transacao.commit();
            res.redirect('/login?next=%2F');
        } catch (err) {
            // Rollback só faz sentido se a transação chegou a abrir; se a
            // abertura falhou, `transacao` é undefined e repetir o erro seria
            // mascarar a causa original.
            if (transacao) {
                await transacao.rollback();
            }

            if (err.name === 'SequelizeUniqueConstraintError') {
                // A mensagem é genérica de propósito: dizer qual campo colidiu
                // confirmaria a existência da conta/e-mail/CPF de outra pessoa.
                req.session.flashCadastroErro = 'Não foi possível concluir o cadastro: usuário, e-mail ou CPF/CNPJ já usados.';
                return res.redirect('/registrar');
            }
            next(err);
        }
    },
};

module.exports = authController;
// Exposto para teste unitário: é a fronteira que precisa continuar devolvendo
// { erro } (e nunca lançar) diante de um corpo com tipos inesperados.
module.exports.validarCadastro = validarCadastro;
