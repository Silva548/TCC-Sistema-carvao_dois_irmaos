const { test } = require('node:test');
const assert = require('node:assert');
const { validarIdParam, ehInteiroPositivo, MAX_INT4 } = require('../../middleware/validate');

const criarRes = () => {
    const res = {
        statusCode: null,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        // responder.erro responde erro textual com set('Content-Type', ...).
        set(campo, valor) { this.headers[campo] = valor; return this; },
        send(body) { this.body = body; return this; },
        json(payload) { this.jsonPayload = payload; return this; },
    };
    return res;
};

test('validarIdParam aceita IDs numéricos positivos', () => {
    ['1', '42', '999'].forEach((id) => {
        let chamado = false;
        validarIdParam({ params: {} }, criarRes(), () => { chamado = true; }, id);
        assert.equal(chamado, true, `ID "${id}" deveria ser aceito`);
    });
});

test('validarIdParam rejeita IDs inválidos', () => {
    ['-1', 'abc', '1.5', '1; DROP TABLE', '', null, undefined].forEach((id) => {
        const res = criarRes();
        const req = { accepts: () => 'html' };
        validarIdParam(req, res, () => assert.fail(`ID "${id}" não deveria passar`), id);
        assert.equal(res.statusCode, 400, `ID "${id}" deveria retornar 400`);
    });
});

test('validarIdParam rejeita id acima do INTEGER em vez de deixar virar 500', () => {
    // Regressão: um id só com dígitos passava pela checagem de formato, ia
    // para o banco como parâmetro e o Postgres respondia "integer out of
    // range" — erro interno (500) para uma URL malformada. /pedidos e
    // /catalogo devolviam 500; agora devolvem 400.
    ['2147483648', '99999999999999999999', '123456789012345678901234567890'].forEach((id) => {
        const res = criarRes();
        const req = { accepts: () => 'html' };
        validarIdParam(req, res, () => assert.fail(`ID "${id}" não deveria passar`), id);
        assert.equal(res.statusCode, 400, `ID "${id}" deveria retornar 400`);
    });
});

test('ehInteiroPositivo aceita exatamente o teto do INTEGER', () => {
    assert.equal(ehInteiroPositivo(String(MAX_INT4)), true, 'o próprio teto do INTEGER cabe');
    assert.equal(ehInteiroPositivo(String(MAX_INT4 + 1)), false, 'um a mais já não cabe');
    assert.equal(ehInteiroPositivo('007'), true, 'zeros à esquerda não mudam o número');
    assert.equal(ehInteiroPositivo(' 1'), false, 'espaço não é dígito');
});

test('validarIdParam responde JSON quando cliente aceita JSON', () => {
    const res = criarRes();
    const req = { accepts: () => 'json' };
    validarIdParam(req, res, () => assert.fail('não deveria passar'), 'abc');
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.jsonPayload, { error: 'ID inválido' });
});
