const { test } = require('node:test');
const assert = require('node:assert/strict');
const authController = require('../../controllers/authController');
const { validarCadastro } = authController;

const BASE = {
    username: 'joao',
    password: 'segredo123',
    nome: 'João',
    email: 'joao@example.com',
    telefone: '11999999999',
    documento: '12345678901',
};

test('corpo válido passa', () => {
    const { erro, dados } = validarCadastro(BASE);
    assert.equal(erro, undefined);
    assert.equal(dados.username, 'joao');
});

test('username repetido vira array e é recusado sem lançar', () => {
    for (const valor of [['a', 'b'], { x: 'a' }, ['a']]) {
        const r = validarCadastro({ ...BASE, username: valor });
        assert.ok(r.erro, `deveria devolver erro para ${JSON.stringify(valor)}`);
    }
});

test('password não-string é recusado sem lançar', () => {
    const r = validarCadastro({ ...BASE, password: ['a', 'b'] });
    assert.ok(r.erro, 'senha não-string deve ser recusada');
});

test('cadastro com username array não rejeita a promise', async () => {
    const req = { body: { ...BASE, username: ['a', 'b'] }, session: { csrfToken: 't' } };
    const res = {
        statusCode: null,
        status(c) { this.statusCode = c; return this; },
        render() { return this; },
    };
    await assert.doesNotReject(() => authController.cadastro(req, res, () => {}));
    assert.equal(res.statusCode, 400);
});

test('campos com objetos são tratados como inválidos', () => {
    for (const campo of ['nome', 'email', 'telefone', 'documento']) {
        const r = validarCadastro({ ...BASE, [campo]: { bad: 'x' } });
        assert.ok(r.erro, `${campo} com objeto deve recusar`);
    }
});
