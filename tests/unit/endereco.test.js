const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validarEndereco, lerEndereco, enderecoPreenchido, formatarCep } = require('../../utils/endereco');

// O endereço entra por dois caminhos — o JSON aninhado do carrinho e os campos
// achatados do formulário HTML — e os dois precisam chegar ao mesmo shape
// normalizado antes de gravar.

const COMPLETO = {
    cep: '88955000',
    logradouro: 'Estrada Geral Palmeira',
    numero: '123',
    bairro: 'Interior',
    cidade: 'Balneario Gaivota',
    uf: 'sc',
};

test('endereço completo passa e volta normalizado', () => {
    const { valores, erros } = validarEndereco(COMPLETO);

    assert.deepEqual(erros, []);
    assert.equal(valores.endereco_cep, '88955-000', 'CEP gravado com máscara');
    assert.equal(valores.endereco_uf, 'SC', 'UF em caixa alta');
    assert.equal(valores.endereco_logradouro, 'Estrada Geral Palmeira');
});

test('campos acima do limite da migration são recusados antes do 500', () => {
    const bairroLongo = validarEndereco({ ...COMPLETO, bairro: 'a'.repeat(121) });
    assert.match(bairroLongo.erros.join('; '), /bairro.*120/i);
    assert.equal(bairroLongo.valores, null, 'nada é gravado quando há erro');

    const cidadeLonga = validarEndereco({ ...COMPLETO, cidade: 'a'.repeat(121) });
    assert.match(cidadeLonga.erros.join('; '), /cidade.*120/i);

    const logradouroLongo = validarEndereco({ ...COMPLETO, logradouro: 'a'.repeat(256) });
    assert.match(logradouroLongo.erros.join('; '), /logradouro.*255/i);

    const numeroLongo = validarEndereco({ ...COMPLETO, numero: '1'.repeat(21) });
    assert.match(numeroLongo.erros.join('; '), /número.*20/i);

    const complementoLongo = validarEndereco({ ...COMPLETO, complemento: 'a'.repeat(256) });
    assert.match(complementoLongo.erros.join('; '), /complemento.*255/i);
});

test('o limite exato do banco é aceito', () => {
    const { erros } = validarEndereco({
        ...COMPLETO,
        logradouro: 'a'.repeat(255),
        complemento: 'a'.repeat(255),
        bairro: 'a'.repeat(120),
        cidade: 'a'.repeat(120),
    });

    assert.deepEqual(erros, []);
});

test('UF inválida e CEP fora do formato são recusados', () => {
    assert.match(validarEndereco({ ...COMPLETO, uf: 'XX' }).erros.join('; '), /UF inválida/i);
    assert.match(validarEndereco({ ...COMPLETO, cep: '123' }).erros.join('; '), /8 dígitos/i);
});

test('campos obrigatórios faltando são indicados', () => {
    const { erros } = validarEndereco({ cep: '88955000' });
    assert.equal(erros.filter((e) => /Informe/i.test(e)).length, 5, 'logradouro, número, bairro, cidade e UF');
});

test('em retirada (opcional) sem nada preenchido o endereço é descartado', () => {
    const { valores, erros } = validarEndereco({}, { obrigatorio: false });
    assert.deepEqual(erros, []);
    assert.equal(valores, null);
});

test('em retirada com algo preenchido o endereço ainda é validado', () => {
    const { erros } = validarEndereco({ bairro: 'a'.repeat(121) }, { obrigatorio: false });
    assert.match(erros.join('; '), /bairro.*120/i);
});

test('lerEndereco aceita as formas aninhada e achatada', () => {
    const aninhado = lerEndereco({ endereco: { cep: '88955000', cidade: 'Joinville', uf: 'sc' } });
    const achatado = lerEndereco({ endereco_cep: '88955000', endereco_cidade: 'Joinville', endereco_uf: 'sc' });

    assert.equal(aninhado.cep, '88955000');
    assert.equal(achatado.cidade, 'Joinville');
});

test('enderecoPreenchido distingue "nada" do objeto de sete nulos', () => {
    assert.equal(enderecoPreenchido(lerEndereco({})), false);
    assert.equal(enderecoPreenchido(lerEndereco({ endereco_uf: 'SC' })), true);
});

test('formatarCep só aplica a máscara quando há oito dígitos', () => {
    assert.equal(formatarCep('88955000'), '88955-000');
    assert.equal(formatarCep('88955-000'), '88955-000');
    assert.equal(formatarCep('123'), '123');
});
