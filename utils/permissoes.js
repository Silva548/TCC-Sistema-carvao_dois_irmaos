// Quem pode fazer o quê.
//
// `role` já existe em "users" e o middleware/auth.js já reidrata a sessão a
// partir do banco a cada requisição; o que faltava era um lugar único que
// traduzisse o papel em decisões concretas. Este módulo é esse lugar.
//
// Regra do projeto: admin acessa tudo; user comum só faz pedido e acompanha os
// pedidos próprios, e só durante o prazo de utils/pedidoRules.

const { statusEditavel, statusCancelavel, dentroDoPrazoDeEdicao, prazoEdicao } = require('./pedidoRules');
const { rotuloStatus } = require('./formatar');

const ehAdmin = (req) => Boolean(req && req.session && req.session.role === 'admin');

// Cliente que a conta logada representa. `null` quando é admin (admin não é
// cliente) ou quando a conta user ainda não foi vinculada a nenhum cadastro.
const clienteIdDoUsuario = (req) => {
    const id = req && req.session ? req.session.clienteId : null;
    return id === undefined || id === null ? null : Number(id);
};

// Só o admin ignora clientes; qualquer outro precisa de um vínculo válido para
// poder usar o sistema. Id 0 ou negativo não é vínculo — ids começam em 1.
const clienteObrigatorio = (req) => {
    const clienteId = clienteIdDoUsuario(req);
    if (!Number.isInteger(clienteId) || clienteId < 1) {
        return null;
    }
    return clienteId;
};

// O pedido pertence à conta logada? Admin enxerga qualquer pedido; user, só os
// do próprio cliente.
const ehDonoDoPedido = (pedido, req) => {
    if (!pedido) return false;
    if (ehAdmin(req)) return true;
    const clienteId = clienteIdDoUsuario(req);
    return clienteId !== null && Number(pedido.cliente_id) === clienteId;
};

// Pode reescrever itens/pagamento/modalidade deste pedido?
// Admin: sim. User: só o próprio pedido, ainda pendente e dentro dos 3 dias.
//
// O prazo de 3 dias é do cliente comum — o admin não tem. A trava por status,
// porém, vale para os dois: reescrever os itens de um pedido que já saiu do
// lugar desfaria a baixa de estoque, e nem o admin mexe ali (utils/pedidoRules).
//
// Consequência que importa: podeEditarPedido precisa devolver false para o admin
// em pedido não-pendente, senão a tela de detalhe ofrece o botão "editar" e a
// tela de edição recusa o clique com "só pedidos pendentes".
const podeEditarPedido = (pedido, req, agora = new Date()) => {
    if (!pedido || !statusEditavel(pedido)) return false;
    if (ehAdmin(req)) return true;
    if (!ehDonoDoPedido(pedido, req)) return false;
    return dentroDoPrazoDeEdicao(pedido, agora);
};

// Pode cancelar este pedido?
// Admin: sim, sem prazo. User: só o próprio pedido, dentro dos 3 dias.
//
// A diferença em relação a podeEditarPedido é o status. Editar itens exige
// 'pendente' porque reescrever a lista desfaria a baixa de estoque. Cancelar
// pode ser pendente/processando/enviado para os DOIS, porque o cancelamento
// devolve o estoque ao produto e aí a conta fecha (services/pedidoService
// chamar devolverEstoque). O que nenhum dos dois pode fazer é cancelar 'entregue'
// ou 'cancelado' — ver STATUS_CANCELAVEIS.
//
// Consequência que importa: assim como podeEditarPedido, devolve false (e não
// lança) para que a tela de detalhe esconda o botão em vez de mostrar um que
// volta 403 no clique.
const podeCancelarPedido = (pedido, req, agora = new Date()) => {
    if (!pedido || !statusCancelavel(pedido)) return false;
    if (ehAdmin(req)) return true;
    if (!ehDonoDoPedido(pedido, req)) return false;
    return dentroDoPrazoDeEdicao(pedido, agora);
};

// Versões que lançam erro, para os controllers não repetirem o mesmo if. O
// erro já carrega o status e cai no errorHandler global, que decide JSON ou
// página (403.ejs) pelo formato da requisição.
const erroComStatus = (status, message) => Object.assign(new Error(message), { status });

// Mensagem do 403 de cancelamento. Separada das permissões porque o texto
// diferencia "não pode mais" (status) de "espera mais" (prazo): o cliente
// precisa saber se é questão de tempo ou de estado do pedido.
const erroCancelamento = (pedido, req, agora = new Date()) => {
    if (!statusCancelavel(pedido)) {
        return erroComStatus(
            403,
            `Este pedido não pode mais ser cancelado (${rotuloStatus(pedido.status).toLowerCase()}).`
        );
    }
    // Admin não tem cliente_id na sessão (a conta é do Seed, sem vínculo com
    // Cliente), então a titularidade só se aplica a quem não é admin. Testar a
    // dona antes do admin faria todo cancelamento de admin cair no 403 de
    // "só os seus próprios pedidos".
    if (!ehAdmin(req) && !ehDonoDoPedido(pedido, req)) {
        return erroComStatus(403, 'Você só pode cancelar os seus próprios pedidos.');
    }
    if (!ehAdmin(req) && !dentroDoPrazoDeEdicao(pedido, agora)) {
        const limite = prazoEdicao(pedido);
        return erroComStatus(
            403,
            `O prazo para cancelar este pedido encerrou em ${limite ? limite.toLocaleString('pt-BR') : '-'}. Fale com a loja para cancelar depois disso.`
        );
    }
    return null;
};

const exigirAdmin = (req) => {
    if (!ehAdmin(req)) {
        throw erroComStatus(403, 'Acesso restrito a administradores');
    }
};

const exigirCliente = (req) => {
    const clienteId = clienteObrigatorio(req);
    if (clienteId === null) {
        throw erroComStatus(403, 'Sua conta ainda não está vinculada a um cliente. Procure o administrador.');
    }
    return clienteId;
};

module.exports = {
    ehAdmin,
    clienteIdDoUsuario,
    clienteObrigatorio,
    ehDonoDoPedido,
    podeEditarPedido,
    podeCancelarPedido,
    erroCancelamento,
    exigirAdmin,
    exigirCliente,
};
