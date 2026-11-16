'use strict';

// Locals para renderizar uma view fora do Express.
//
// `ejs.render()` puro não conhece `app.locals`: em produção, o Express junta
// app.locals, res.locals e as opções do controller num único objeto que é
// passado à view. Um teste que renderiza direto passaria então com menos
// variáveis do que a aplicação real entrega — foi exatamente o que aconteceu
// com `empresa`, que o layout passou a usar e o teste reportou como
// "not defined" mesmo com a aplicação funcionando.
//
// Este helper monta o mesmo objeto do Express, sem subir o app (que abriria
// conexão de banco e registraria rotas — nada disso cabe num teste unitário).

const { empresa, enderecoLinha, whatsappUrl } = require('../../config/empresa');

// Espelha os três app.locals definidos em app.js. Se o layout ganhar uma
// dependência global nova, é aqui que o teste avisa.
const LOCAIS_DO_APP = { empresa, enderecoLinha, whatsappUrl };

// `extras` representa o que o controller passa no res.render.
const localsDaView = (extras = {}) => Object.assign({}, LOCAIS_DO_APP, extras);

module.exports = { LOCAIS_DO_APP, localsDaView };