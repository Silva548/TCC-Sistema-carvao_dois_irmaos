const { test } = require('node:test');
const assert = require('node:assert');
const {
    STATUS_VALIDOS,
    TRANSICOES_STATUS,
    TIPOS_ENTREGA,
    transicaoValida,
    modalidadeValida,
    precoDaModalidade,
    paraCentavos,
    calcularTotalCentavos,
    mediaEmCentavos,
    PRAZO_EDICAO_DIAS,
    STATUS_EDITAVEIS,
    prazoEdicao,
    dentroDoPrazoDeEdicao,
    statusEditavel,
    pedidoEditavel,
} = require('../../utils/pedidoRules');

test('status válidos cobrem todas as chaves das transições', () => {
    for (const status of STATUS_VALIDOS) {
        assert.ok(Array.isArray(TRANSICOES_STATUS[status]), `faltando transições de ${status}`);
    }
});

test('transições válidas são aceitas', () => {
    assert.equal(transicaoValida('pendente', 'processando'), true);
    assert.equal(transicaoValida('pendente', 'cancelado'), true);
    assert.equal(transicaoValida('processando', 'enviado'), true);
    assert.equal(transicaoValida('enviado', 'entregue'), true);
    assert.equal(transicaoValida('enviado', 'cancelado'), true);
});

test('transições inválidas ou reversas são rejeitadas', () => {
    assert.equal(transicaoValida('entregue', 'pendente'), false);
    assert.equal(transicaoValida('cancelado', 'processando'), false);
    assert.equal(transicaoValida('entregue', 'qualquer-coisa'), false);
    assert.equal(transicaoValida('pendente', 'entregue'), false); // pulando etapas
    assert.equal(transicaoValida('status-inexistente', 'pendente'), false);
});

test('paraCentavos evita erros de ponto flutuante', () => {
    // Casos clássicos que quebrariam aritmética binária direta
    assert.equal(paraCentavos(0.1 + 0.2), 30);
    assert.equal(paraCentavos('19.99'), 1999);
    assert.equal(paraCentavos(10), 1000);
    assert.equal(paraCentavos('0.05'), 5);
});

test('calcularTotalCentavos soma quantidade x preço sem perda de precisão', () => {
    const itens = [
        { produto_id: 1, quantidade: 3 },
        { produto_id: 2, quantidade: 2 },
    ];
    // Indexado por produto_id, não por posição
    const produtos = new Map([
        [1, { preco_entrega: '19.99', preco_retirada: '17.00' }], // 3 x 1999 = 5997
        [2, { preco_entrega: '0.1', preco_retirada: '0.05' }],     // 2 x   10 =   20
    ]);

    assert.equal(calcularTotalCentavos(itens, produtos), 6017);
});

test('calcularTotalCentavos usa o preço da modalidade do pedido', () => {
    const itens = [{ produto_id: 1, quantidade: 2 }];
    const produtos = new Map([[1, { preco_entrega: '21.00', preco_retirada: '18.00' }]]);

    assert.equal(calcularTotalCentavos(itens, produtos), 4200, 'padrão é entrega');
    assert.equal(calcularTotalCentavos(itens, produtos, 'entrega'), 4200);
    assert.equal(calcularTotalCentavos(itens, produtos, 'retirada'), 3600);
});

test('modalidade desconhecida cai no preço de entrega, sem NaN', () => {
    const itens = [{ produto_id: 1, quantidade: 1 }];
    const produtos = new Map([[1, { preco_entrega: '21.00', preco_retirada: '18.00' }]]);

    assert.equal(calcularTotalCentavos(itens, produtos, 'xpto'), 2100);
    assert.equal(precoDaModalidade(produtos.get(1), 'xpto'), '21.00');
    assert.equal(modalidadeValida('entrega'), true);
    assert.equal(modalidadeValida('retirada'), true);
    assert.equal(modalidadeValida('xpto'), false);
    assert.deepEqual(TIPOS_ENTREGA, ['entrega', 'retirada']);
});

test('calcularTotalCentavos não confunde itens quando a ordem dos produtos difere', () => {
    // Regressão do estoque negativo: a agregação por produto muda o tamanho do
    // array, então qualquer alinhamento posicional passaria a associar a
    // quantidade ao preço do produto errado.
    const itens = [
        { produto_id: 7, quantidade: 2 },
        { produto_id: 9, quantidade: 5 },
    ];
    const produtos = new Map([
        [9, { preco_entrega: '10.00' }],
        [7, { preco_entrega: '3.00' }],
    ]);

    // 2 x 300 + 5 x 1000 = 5600
    assert.equal(calcularTotalCentavos(itens, produtos), 5600);
});

test('calcularTotalCentavos soma a mesma linha repetida', () => {
    const itens = [{ produto_id: 1, quantidade: 10 }];
    const produtos = new Map([[1, { preco_entrega: '2.50' }]]);

    assert.equal(calcularTotalCentavos(itens, produtos), 2500);
});

test('pedido vazio totaliza zero', () => {
    assert.equal(calcularTotalCentavos([], new Map()), 0);
});

// ---------------------------------------------------------------------------
// mediaEmCentavos
// ---------------------------------------------------------------------------

test('a média por pedido não devolve ruído de float', () => {
    // 310 / 7 é 44.285714285714285 em ponto flutuante; num campo de dinheiro,
    // esses 17 dígitos viram lixo na tela.
    assert.equal(mediaEmCentavos(310, 7), 44.29);
    assert.equal(String(mediaEmCentavos(310, 7)).length <= 5, true);
});

test('a média arredonda para duas casas, com o valor exato preservado', () => {
    assert.equal(mediaEmCentavos(100, 4), 25);
    assert.equal(mediaEmCentavos(10, 3), 3.33);
    assert.equal(mediaEmCentavos(10, 6), 1.67);
    assert.equal(mediaEmCentavos(0, 5), 0);
});

test('a média não quebra com quantidade zero, negativa ou lixo', () => {
    assert.equal(mediaEmCentavos(310, 0), 0);
    assert.equal(mediaEmCentavos(310, -2), 0);
    assert.equal(mediaEmCentavos(NaN, 5), 0);
    assert.equal(mediaEmCentavos(310, 'abc'), 0);
    assert.equal(mediaEmCentavos(undefined, undefined), 0);
});

// ---------------------------------------------------------------------------
// Prazo de edição pelo cliente
// ---------------------------------------------------------------------------

test('prazoEdicao soma exatamente 3 dias à data do pedido', () => {
    const data = new Date('2026-09-01T10:00:00.000Z');
    const limite = prazoEdicao({ data });

    assert.equal(PRAZO_EDICAO_DIAS, 3);
    assert.equal(limite.toISOString(), '2026-09-04T10:00:00.000Z');
});

test('dentroDoPrazoDeEdicao vale até o limite, inclusive', () => {
    const pedido = { data: new Date('2026-09-01T10:00:00.000Z'), status: 'pendente' };

    assert.equal(dentroDoPrazoDeEdicao(pedido, new Date('2026-09-01T10:00:01.000Z')), true);
    assert.equal(dentroDoPrazoDeEdicao(pedido, new Date('2026-09-04T09:59:59.000Z')), true);
    // O instante-limite ainda é editável...
    assert.equal(dentroDoPrazoDeEdicao(pedido, new Date('2026-09-04T10:00:00.000Z')), true);
    // ...e o milissegundo seguinte não.
    assert.equal(dentroDoPrazoDeEdicao(pedido, new Date('2026-09-04T10:00:00.001Z')), false);
});

test('dentroDoPrazoDeEdicao recusa data ausente ou inválida', () => {
    assert.equal(dentroDoPrazoDeEdicao({}), false);
    assert.equal(dentroDoPrazoDeEdicao({ data: 'nao-e-data' }), false);
    assert.equal(dentroDoPrazoDeEdicao(null), false);
});

test('só pedido pendente é editável por status', () => {
    assert.equal(statusEditavel({ status: 'pendente' }), true);
    for (const status of ['processando', 'enviado', 'entregue', 'cancelado']) {
        assert.equal(statusEditavel({ status }), false, `${status} não deveria ser editável`);
    }
});

test('pedidoEditavel exige pendente E dentro do prazo', () => {
    const agora = new Date('2026-09-02T10:00:00.000Z');
    const base = { data: new Date('2026-09-01T10:00:00.000Z') };

    assert.equal(pedidoEditavel({ ...base, status: 'pendente' }, agora), true);
    assert.equal(pedidoEditavel({ ...base, status: 'enviado' }, agora), false);

    const antigo = { data: new Date('2026-09-01T10:00:00.000Z'), status: 'pendente' };
    assert.equal(pedidoEditavel(antigo, new Date('2026-09-10T10:00:00.000Z')), false);
});

test('STATUS_EDITAVEIS é somente pendente', () => {
    assert.deepEqual(STATUS_EDITAVEIS, ['pendente']);
});
