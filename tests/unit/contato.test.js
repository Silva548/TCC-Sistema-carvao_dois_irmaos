const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lerContato, validarContato, contatoVazio, normalizarDocumento, validarDocumento } = require('../../utils/contato');

// O contato do pedido chega em duas formas: o objeto aninhado que o carrinho
// envia por JSON e os campos achatados do formulário HTML. As duas precisam
// virar o mesmo shape.

test('lerContato aceita o formato do carrinho (objeto aninhado)', () => {
    const contato = lerContato({
        contato: { nome: '  Maria Silva  ', email: ' MARIA@Exemplo.COM ', telefone: '11988887777' },
    });

    assert.deepEqual(contato, {
        contato_nome: 'Maria Silva',
        contato_email: 'maria@exemplo.com',
        contato_telefone: '11988887777',
    });
});

test('lerContato aceita os campos achatados do formulário', () => {
    const contato = lerContato({
        contato_nome: 'Maria Silva',
        contato_email: 'MARIA@Exemplo.com',
        contato_telefone: ' 11988887777 ',
    });

    assert.equal(contato.contato_nome, 'Maria Silva');
    assert.equal(contato.contato_email, 'maria@exemplo.com');
    assert.equal(contato.contato_telefone, '11988887777');
});

test('lerContato aceita "whatsapp" como apelido do telefone', () => {
    const contato = lerContato({ nome: 'Maria', email: 'maria@exemplo.com', whatsapp: '11988887777' });
    assert.equal(contato.contato_telefone, '11988887777');
});

test('lerContato não quebra com corpo vazio ou nulo', () => {
    const vazio = { contato_nome: '', contato_email: '', contato_telefone: '' };
    assert.deepEqual(lerContato({}), vazio);
    assert.deepEqual(lerContato(), vazio);
    assert.deepEqual(lerContato({ contato: null }), vazio);
});

test('contatoVazio só é verdadeiro quando os três campos faltam', () => {
    assert.equal(contatoVazio(lerContato({})), true);
    assert.equal(contatoVazio(lerContato({ nome: 'Só o nome' })), false);
    assert.equal(contatoVazio(lerContato({ telefone: '11988887777' })), false);
});

test('contato completo passa e volta só os três campos graváveis', () => {
    const { erro, dados } = validarContato(
        lerContato({ nome: 'Maria Silva', email: 'maria@exemplo.com', telefone: '11988887777' }),
        { obrigatorio: true }
    );

    assert.equal(erro, undefined);
    assert.deepEqual(Object.keys(dados).sort(), ['contato_email', 'contato_nome', 'contato_telefone']);
});

test('sem contato, só é erro quando o contato é obrigatório', () => {
    const vazio = lerContato({});

    const opcional = validarContato(vazio, { obrigatorio: false });
    assert.equal(opcional.erro, undefined);
    assert.deepEqual(opcional.dados, {}, 'fluxo do admin segue sem contato');

    const obrigatorio = validarContato(vazio, { obrigatorio: true });
    assert.match(obrigatorio.erro, /nome, e-mail e WhatsApp/i);
    assert.equal(obrigatorio.dados, undefined);
});

test('cada campo faltando é recusado com mensagem própria', () => {
    const base = { nome: 'Maria', email: 'maria@exemplo.com', telefone: '11988887777' };

    const semNome = validarContato(lerContato({ ...base, nome: '' }), { obrigatorio: true });
    assert.match(semNome.erro, /nome/i);

    const semEmail = validarContato(lerContato({ ...base, email: '' }), { obrigatorio: true });
    assert.match(semEmail.erro, /e-mail/i);

    const semTelefone = validarContato(lerContato({ ...base, telefone: '' }), { obrigatorio: true });
    assert.match(semTelefone.erro, /WhatsApp/i);
});

test('e-mail inválido é recusado mesmo preenchendo o resto', () => {
    const { erro } = validarContato(
        lerContato({ nome: 'Maria', email: 'maria@exemplo', telefone: '11988887777' }),
        { obrigatorio: true }
    );

    assert.match(erro, /e-mail válido/i);
});

test('contato parcial nunca é aceito como "não informado"', () => {
    // Ignorar o que veio deixaria o pedido com e-mail de contato e telefone
    // vazio — pior do que recusar.
    const { erro } = validarContato(lerContato({ nome: 'Só o nome' }), { obrigatorio: false });
    assert.match(erro, /e-mail/i);
});

test('campos acima do limite da migration são recusados antes do 500', () => {
    const nomeLongo = validarContato(
        lerContato({ nome: 'a'.repeat(256), email: 'maria@exemplo.com', telefone: '11988887777' }),
        { obrigatorio: true }
    );
    assert.match(nomeLongo.erro, /255/);

    const telefoneLongo = validarContato(
        lerContato({ nome: 'Maria', email: 'maria@exemplo.com', telefone: '1'.repeat(21) }),
        { obrigatorio: true }
    );
    assert.match(telefoneLongo.erro, /20/);
});

test('o limite exato do banco é aceito', () => {
    const { erro } = validarContato(
        lerContato({
            nome: 'a'.repeat(255),
            email: `${'b'.repeat(240)}@exemplo.com`,
            telefone: '1'.repeat(20),
        }),
        { obrigatorio: true }
    );

    assert.equal(erro, undefined);
});

// ---------------------------------------------------------------------------
// CPF/CNPJ
// ---------------------------------------------------------------------------

test('normalizarDocumento tira tudo que não é dígito', () => {
    assert.equal(normalizarDocumento('123.456.789-01'), '12345678901');
    assert.equal(normalizarDocumento(' 555.444.333/22 '), '55544433322');
    assert.equal(normalizarDocumento('11.222.333/0001-99'), '11222333000199');
    assert.equal(normalizarDocumento(undefined), '');
    assert.equal(normalizarDocumento(null), '');
});

test('validarDocumento aceita CPF e CNPJ, com ou sem pontuação', () => {
    const cpf = validarDocumento('123.456.789-01');
    assert.equal(cpf.erro, undefined);
    assert.equal(cpf.dados.documento, '12345678901');

    const cnpj = validarDocumento('11.222.333/0001-99');
    assert.equal(cnpj.erro, undefined);
    assert.equal(cnpj.dados.documento, '11222333000199');
});

test('validarDocumento recusa documento vazio ou de tamanho errado', () => {
    assert.match(validarDocumento('').erro, /obrigatório/);
    assert.match(validarDocumento('   ').erro, /obrigatório/);
    // Só dígitos não significa documento: 3, 10, 12 e 13 dígitos não são CPF nem
    // CNPJ, e aceitar só pioraria a qualidade da tabela de clientes.
    ['1', '123', '1234567890', '123456789012', '1234567890123'].forEach((doc) => {
        assert.match(validarDocumento(doc).erro, /CPF|CNPJ/, `"${doc}" deveria ser recusado`);
    });
});

test('a pontuação não contorna a unicidade do documento', () => {
    // O motivo de normalizar: clientes.documento tem índice UNIQUE, mas a
    // unicidade é da STRING. Sem normalizar, estes dois seriam linhas
    // diferentes para o mesmo CPF.
    const formatado = validarDocumento('123.456.789-01').dados.documento;
    const cru = validarDocumento('12345678901').dados.documento;
    assert.equal(formatado, cru, 'as duas formas precisam gerar a mesma string');
});
