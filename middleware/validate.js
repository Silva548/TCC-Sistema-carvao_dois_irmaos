// Valida que req.params.id é um inteiro positivo.
// Uso: router.param('id', validarIdParam)
const { erro } = require('../utils/responder');

// Teto do INTEGER do Postgres. Passar daqui não é "id inexistente": o id vira
// parâmetro de uma comparação com a coluna e o banco responde "integer out of
// range", que é erro interno (500). Sem este teto, /catalogo/1e22 e
// /pedidos/99999999999999999999 quebravam a requisição com 500 — e um id mal
// formado é entrada inválida, não falha do servidor.
const MAX_INT4 = 2147483647;

const ehInteiroPositivo = (valor) => {
    if (typeof valor !== 'string' && typeof valor !== 'number') return false;
    if (!/^\d+$/.test(String(valor))) return false;

    const numero = Number(valor);
    return numero > 0 && numero <= MAX_INT4;
};

const validarIdParam = (req, res, next, id) => {
    if (!ehInteiroPositivo(id)) {
        return erro(res, req, 400, 'ID inválido');
    }
    next();
};

// Query params chegam como string; um valor não-numérico viraria erro de tipo
// do Postgres (HTTP 500) em vez de validação de entrada (HTTP 400).
// Uso: router.get('/', validarQueryInteiro('cliente_id'), handler)
const validarQueryInteiro = (nome) => (req, res, next) => {
    const bruto = req.query[nome];

    if (bruto === undefined || bruto === '') {
        return next();
    }

    // query repetida (?id=1&id=2) chega como array
    const valor = Array.isArray(bruto) ? bruto[0] : bruto;

    if (!ehInteiroPositivo(valor)) {
        return erro(res, req, 400, `Parâmetro "${nome}" inválido`);
    }

    next();
};

module.exports = { validarIdParam, validarQueryInteiro, ehInteiroPositivo, MAX_INT4 };
