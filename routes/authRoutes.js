const express = require('express');
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController');

const router = express.Router();

const { criarStore } = require('../middleware/rateLimitStore');

const LIMITE_PADRAO = 10;

// Configurável para que a suíte de integração possa exercitar vários fluxos de
// login sem ser barrada pelo próprio limitador que ela deveria testar
//
// Store no Postgres, não o MemoryStore padrão: um restart não pode valer como
// renovação do limite, e com mais de uma instância cada uma precisa contar os
// mesmos clientes. Prefixos distintos porque a chave crua da lib é só o IP —
// sem prefixo, "login" e "cadastro" do mesmo IP compartilhariam a mesma linha.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.LOGIN_RATE_LIMIT) || LIMITE_PADRAO,
    standardHeaders: true,
    legacyHeaders: false,
    store: criarStore('login'),
    message: 'Muitas tentativas de login. Tente novamente em 15 minutos.',
});

router.get('/login', authController.renderLoginForm);
router.post('/login', loginLimiter, authController.login);
router.post('/logout', authController.logout);

// Cadastro de conta do cliente comum.
//
// O limitador é separado do login e mais apertado de propósito: o cadastro cria
// linhas em clientes e users, então sem freio qualquer um pode encher o banco
// com contas descartáveis (e cada cadastro dispara um bcrypt de ~100ms, o que
// sozinho já é um Denial of Service barato de montar).
const cadastroLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.CADASTRO_RATE_LIMIT) || LIMITE_PADRAO,
    standardHeaders: true,
    legacyHeaders: false,
    store: criarStore('cadastro'),
    message: 'Muitas tentativas de cadastro. Tente novamente em 15 minutos.',
});

router.get('/registrar', authController.renderCadastroForm);
router.post('/registrar', cadastroLimiter, authController.cadastro);

module.exports = router;
