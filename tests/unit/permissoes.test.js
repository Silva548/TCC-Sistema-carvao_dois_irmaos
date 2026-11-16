const { test } = require('node:test');
const assert = require('node:assert');
const {
    ehAdmin,
    clienteIdDoUsuario,
    clienteObrigatorio,
    ehDonoDoPedido,
    podeEditarPedido,
    podeCancelarPedido,
    erroCancelamento,
    exigirAdmin,
    exigirCliente,
} = require('../../utils/permissoes');

const reqAdmin = { session: { role: 'admin', clienteId: null } };
const reqUser = (clienteId = 7) => ({ session: { role: 'user', clienteId } });

// ---------------------------------------------------------------------------
// Papel e vínculo
// ---------------------------------------------------------------------------

test('ehAdmin só reconhece o papel admin', () => {
    assert.equal(ehAdmin(reqAdmin), true);
    assert.equal(ehAdmin(reqUser()), false);
    assert.equal(ehAdmin({}), false);
    assert.equal(ehAdmin(null), false);
});

test('clienteIdDoUsuario normaliza para número e usa null sem vínculo', () => {
    assert.equal(clienteIdDoUsuario(reqUser(7)), 7);
    assert.equal(clienteIdDoUsuario(reqUser('7')), 7);
    assert.equal(clienteIdDoUsuario(reqAdmin), null);
    assert.equal(clienteIdDoUsuario({ session: {} }), null);
    assert.equal(clienteIdDoUsuario({}), null);
});

test('clienteObrigatorio recusa vínculo ausente ou inválido', () => {
    assert.equal(clienteObrigatorio(reqUser(7)), 7);
    assert.equal(clienteObrigatorio(reqUser('9')), 9);
    assert.equal(clienteObrigatorio({ session: { role: 'user', clienteId: null } }), null);
    assert.equal(clienteObrigatorio({ session: { role: 'user', clienteId: 'abc' } }), null);
    assert.equal(clienteObrigatorio({ session: { role: 'user', clienteId: 0 } }), null);
});

// ---------------------------------------------------------------------------
// Dono do pedido
// ---------------------------------------------------------------------------

test('admin é dono de qualquer pedido; user só do próprio cliente', () => {
    assert.equal(ehDonoDoPedido({ cliente_id: 99 }, reqAdmin), true);
    assert.equal(ehDonoDoPedido({ cliente_id: 7 }, reqUser(7)), true);
    assert.equal(ehDonoDoPedido({ cliente_id: 8 }, reqUser(7)), false);
    // Vínculo ausente não casa com pedido nenhum
    assert.equal(ehDonoDoPedido({ cliente_id: 7 }, reqUser(null)), false);
    assert.equal(ehDonoDoPedido(null, reqAdmin), false);
});

// ---------------------------------------------------------------------------
// Edição
// ---------------------------------------------------------------------------

test('admin edita pedido de qualquer cliente, sem prazo', () => {
    const antigo = { cliente_id: 99, status: 'pendente', data: new Date('2020-01-01T00:00:00Z') };
    assert.equal(podeEditarPedido(antigo, reqAdmin, new Date('2026-01-01T00:00:00Z')), true);
});

test('a trava por status vale para o admin também', () => {
    // Regressão: podeEditarPedido devolvia true para o admin sem olhar o status,
    // e a tela de detalhe passava a oferecer o botão "editar" num pedido já
    // enviado — cujo clique a tela de edição recusava com "só pedidos pendentes".
    const agora = new Date('2026-09-02T12:00:00Z');
    for (const status of ['processando', 'enviado', 'entregue', 'cancelado']) {
        const pedido = { cliente_id: 99, status, data: new Date('2026-09-01T12:00:00Z') };
        assert.equal(podeEditarPedido(pedido, reqAdmin, agora), false, `admin não deveria editar ${status}`);
        assert.equal(podeEditarPedido(pedido, reqUser(99), agora), false, `user não deveria editar ${status}`);
    }

    // Pendente continua editável por ambos (o admin não tem prazo)
    const pendente = { cliente_id: 99, status: 'pendente', data: new Date('2026-09-01T12:00:00Z') };
    assert.equal(podeEditarPedido(pendente, reqAdmin, agora), true);
    assert.equal(podeEditarPedido(pendente, reqUser(99), agora), true);
});

test('user edita o próprio pedido só se pendente e dentro do prazo', () => {
    const agora = new Date('2026-09-02T12:00:00Z');
    const pendente = { cliente_id: 7, status: 'pendente', data: new Date('2026-09-01T12:00:00Z') };

    assert.equal(podeEditarPedido(pendente, reqUser(7), agora), true);
    // Fora do prazo
    assert.equal(podeEditarPedido(pendente, reqUser(7), new Date('2026-09-10T12:00:00Z')), false);
    // Já processado
    assert.equal(podeEditarPedido({ ...pendente, status: 'enviado' }, reqUser(7), agora), false);
    // De outro cliente
    assert.equal(podeEditarPedido({ ...pendente, cliente_id: 8 }, reqUser(7), agora), false);
});

// ---------------------------------------------------------------------------
// Guardas
// ---------------------------------------------------------------------------

test('exigirAdmin lança 403 para quem não é admin', () => {
    assert.doesNotThrow(() => exigirAdmin(reqAdmin));

    assert.throws(
        () => exigirAdmin(reqUser()),
        (err) => err.status === 403
    );
});

test('exigirCliente devolve o id e lança 403 sem vínculo', () => {
    assert.equal(exigirCliente(reqUser(7)), 7);

    assert.throws(
        () => exigirCliente(reqUser(null)),
        (err) => err.status === 403
    );
});

// ---------------------------------------------------------------------------
// Cancelamento
// ---------------------------------------------------------------------------

const AGORA = new Date('2026-09-02T12:00:00Z');
const pedidoEm = (status, diasAtras, clienteId = 7) => ({
    cliente_id: clienteId,
    status,
    data: new Date(AGORA.getTime() - diasAtras * 86400000),
});

test('cancelamento: admin cancela pendente, processando e enviado, mesmo fora do prazo', () => {
    for (const status of ['pendente', 'processando', 'enviado']) {
        // 30 dias atrás: bem além dos 3 dias, mas o admin não tem prazo.
        assert.equal(podeCancelarPedido(pedidoEm(status, 30), reqAdmin, AGORA), true, `admin deveria cancelar ${status}`);
    }
});

test('cancelamento: cliente cancela o próprio pedido dentro de 3 dias', () => {
    for (const status of ['pendente', 'processando', 'enviado']) {
        assert.equal(podeCancelarPedido(pedidoEm(status, 1), reqUser(7), AGORA), true, `cliente deveria cancelar ${status}`);
    }
    assert.equal(podeCancelarPedido(pedidoEm('pendente', 4), reqUser(7), AGORA), false, 'passou do prazo');
});

test('cancelamento: ninguém cancela entregue nem já cancelado', () => {
    // 'entregue' está fora porque a mercadoria saiu: devolver estoque mentiria.
    for (const req of [reqAdmin, reqUser(7)]) {
        assert.equal(podeCancelarPedido(pedidoEm('entregue', 1), req, AGORA), false);
        assert.equal(podeCancelarPedido(pedidoEm('cancelado', 1), req, AGORA), false);
    }
});

test('cancelamento: cliente não cancela pedido de outro cliente', () => {
    assert.equal(podeCancelarPedido(pedidoEm('pendente', 1, 99), reqUser(7), AGORA), false);
});

test('erroCancelamento traduz o motivo: status, titularidade e prazo', () => {
    // Status: não é mais cancelável.
    const porStatus = erroCancelamento(pedidoEm('entregue', 1), reqUser(7), AGORA);
    assert.equal(porStatus.status, 403);
    assert.match(porStatus.message, /não pode mais ser cancelado/i);

    // Titularidade: pedido de outro cliente, ainda pendente e no prazo.
    const porDono = erroCancelamento(pedidoEm('pendente', 1, 99), reqUser(7), AGORA);
    assert.equal(porDono.status, 403);
    assert.match(porDono.message, /seus próprios pedidos/i);

    // Prazo: o próprio pedido, cancelável, mas velho demais.
    const porPrazo = erroCancelamento(pedidoEm('pendente', 10), reqUser(7), AGORA);
    assert.equal(porPrazo.status, 403);
    assert.match(porPrazo.message, /prazo para cancelar/i);

    assert.equal(erroCancelamento(pedidoEm('pendente', 1), reqUser(7), AGORA), null);
});

test('erroCancelamento deixa o admin passar sem cliente vinculado na sessão', () => {
    // Regressão: a conta admin do Seed não tem cliente_id. Checar a titularidade
    // antes do papel transformava todo cancelamento de admin em 403, e como
    // podeCancelarPedido devolvia true, a tela mostrava o botão e o clique
    // voltava erro.
    assert.equal(reqAdmin.session.clienteId, null);
    assert.equal(erroCancelamento(pedidoEm('processando', 30), reqAdmin, AGORA), null);
});
