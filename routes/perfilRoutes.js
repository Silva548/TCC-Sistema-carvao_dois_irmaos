const express = require('express');
const perfilController = require('../controllers/perfilController');

const router = express.Router();

// Área do cliente comum (montada em /meus-dados, já com requireAuth e
// csrfSetup no app.js). O vínculo usuário <-> cliente vem da sessão, nunca da
// URL, então não há :id nem risco de editar a conta de outro.
router.get('/', perfilController.renderEditForm);
router.put('/', perfilController.updatePerfil);

module.exports = router;
