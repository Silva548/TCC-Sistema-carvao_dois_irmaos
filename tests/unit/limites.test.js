const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    LIMITE_STRING,
    FAIXA_INTEIRA,
    textoDentroDoLimite,
    excedeTexto,
    excedeDecimal,
    excedeInteiro,
} = require('../../utils/limites');

test('valores dentro do limite passam', () => {
    assert.equal(excedeTexto('cliente', 'nome', 'João Silva'), null);
    assert.equal(excedeTexto('usuario', 'username', 'admin'), null);
    assert.equal(excedeTexto('cliente', 'documento', '12345678901'), null);
});

test('valores no limite exato passam', () => {
    assert.equal(excedeTexto('cliente', 'nome', 'a'.repeat(255)), null);
    assert.equal(excedeTexto('usuario', 'username', 'a'.repeat(100)), null);
    assert.equal(excedeTexto('cliente', 'documento', '1'.repeat(20)), null);
});

test('um caractere acima é recusado com mensagem legível', () => {
    const erro = excedeTexto('cliente', 'nome', 'a'.repeat(256));
    assert.ok(erro, 'deveria recusar 256 caracteres');
    assert.match(erro, /255/);
    assert.match(erro, /nome/i);
});

test('cada entidade tem o limite da sua migration', () => {
    assert.equal(LIMITE_STRING.cliente.nome, 255);
    assert.equal(LIMITE_STRING.cliente.documento, 20);
    assert.equal(LIMITE_STRING.cliente.telefone, 20);
    assert.equal(LIMITE_STRING.usuario.username, 100);
    assert.equal(LIMITE_STRING.produto.nome, 255);
    assert.equal(LIMITE_STRING.categoria.nome, 255);
});

test('decimais acima da faixa do DECIMAL são recusados', () => {
    // DECIMAL(10,2) aceita no máximo 99.999.999,99
    assert.equal(excedeDecimal('preco_entrega', 99999999.99), null);
    assert.ok(excedeDecimal('preco_entrega', 100000000));
    assert.ok(excedeDecimal('preco_entrega', 1e15));
    assert.equal(excedeDecimal('preco_retirada', 99999999.99), null);
    assert.ok(excedeDecimal('preco_retirada', 100000000));

    // DECIMAL(8,2)
    assert.equal(excedeDecimal('peso_kg', 999999.99), null);
    assert.ok(excedeDecimal('peso_kg', 1000000));

    // DECIMAL(12,2)
    assert.equal(excedeDecimal('valor_total', 9999999999.99), null);
    assert.ok(excedeDecimal('valor_total', 1e11));
});

test('inteiros acima do teto do INTEGER são recusados', () => {
    // O teto é o do tipo no Postgres (2^31-1). Passar dele dá "integer out of
    // range" no INSERT, que o errorHandler transformava em 500 — e
    // Number.isInteger não pegava, porque 3000000000 é inteiro para o JS.
    assert.equal(excedeInteiro('estoque', 0), null);
    assert.equal(excedeInteiro('estoque', 10), null);
    assert.equal(excedeInteiro('estoque', 2147483647), null);
    assert.ok(excedeInteiro('estoque', 2147483648));
    assert.ok(excedeInteiro('estoque', 3000000000));
    assert.ok(excedeInteiro('estoque', '3000000000'));
});

test('o teto de estoque é o do tipo INTEGER', () => {
    assert.equal(FAIXA_INTEIRA.estoque.max, 2147483647);
});

test('excedeInteiro só compara o teto; sinal é do controller', () => {
    // O mínimo do domínio (estoque >= 0) é decidido pelo controller, que sabe o
    // que é válido. Aqui só interessa não estourar a coluna.
    assert.equal(excedeInteiro('estoque', -1), null);
    assert.equal(excedeInteiro('estoque', 'abc'), null);
    assert.equal(excedeInteiro('estoque', NaN), null);
    assert.equal(excedeInteiro('estoque', undefined), null);
    assert.equal(excedeInteiro('campoInexistente', 1e12), null);
});

test('valores não numéricos não são tratados como estouro', () => {
    // A validação de "é número" é responsabilidade do controller
    assert.equal(excedeDecimal('preco_entrega', 'abc'), null);
    assert.equal(excedeDecimal('preco_entrega', NaN), null);
    assert.equal(excedeDecimal('preco_entrega', undefined), null);
});

test('entidade ou campo desconhecido não quebra', () => {
    assert.equal(excedeTexto('inexistente', 'campo', 'valor'), null);
    assert.equal(excedeTexto('cliente', 'campoInexistente', 'valor'), null);
});

test('textoDentroDoLimite só aceita string', () => {
    assert.equal(textoDentroDoLimite('abc', 5), true);
    assert.equal(textoDentroDoLimite('abcdef', 5), false);
    assert.equal(textoDentroDoLimite(123, 5), false);
    assert.equal(textoDentroDoLimite(null, 5), false);
});