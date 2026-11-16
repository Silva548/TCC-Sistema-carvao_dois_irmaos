const express = require('express');
const router = express.Router();

// Página "Onde estamos": endereço, horário de funcionamento e contato.
//
// Rota pública de propósito. A loja precisa que o cliente encontre o endereço
// ANTES de criar conta — mandar exigir login para ver um endereço faria a
// página existir só para quem já comprou, que é justamente quem não precisa
// mais procurar.
//
// Não recebe nada de controller: os dados são de `config/empresa`, expostos no
// layout como app.locals. Não há o que consultar no banco, então um controller
// aqui só seria código que passa o mesmo objeto adiante.

/* GET página de localização da empresa. */
router.get('/onde-estamos', (req, res) => {
    res.render('onde-estamos', { title: 'Onde estamos' });
});

module.exports = router;