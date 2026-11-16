const express = require('express');
const router = express.Router();

const homeController = require('../controllers/homeController');
const { csrfSetup } = require('../middleware/csrf');

// A home do cliente comum tem carrinho, e o fechamento dele é um POST JSON em
// /pedidos (que exige token CSRF). csrfSetup só roda para quem já está logado:
// visitante anônimo não ganha sessão só por abrir a home.
const csrfSeLogado = (req, res, next) => {
    if (req.session && req.session.userId) {
        return csrfSetup(req, res, next);
    }
    next();
};

/* GET home page. */
router.get('/', csrfSeLogado, homeController.renderHome);

module.exports = router;
