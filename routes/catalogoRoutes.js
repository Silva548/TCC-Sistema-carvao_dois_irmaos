// Rotas de leitura do catálogo do cliente comum.
//
// /catalogo é separado de /produtos de propósito: /produtos é o painel do
// admin (criar/editar/excluir) e está montado com requireRole('admin') em
// app.js. Misturar as duas coisas faria o card do cliente apontar para uma URL
// que o próprio servidor recusa.

const express = require('express');
const catalogoController = require('../controllers/catalogoController');
const { validarIdParam } = require('../middleware/validate');

const router = express.Router();

// Sem isto, /catalogo/abc chega ao findByPk como string e o Postgres reclama
// do tipo: erro interno (500) num id que é só entrada inválida do usuário. Com
// o param validado, é 400 — que é o que o resto do sistema já faz em /pedidos.
router.param('id', validarIdParam);

// Ficha do produto. Precisa de sessão porque é onde o carrinho mora: sem
// login não há para onde adicionar, e mostrar um botão morto seria pior que
// não mostrar.
router.get('/:id', catalogoController.verProduto);

module.exports = router;