// Regras de negócio de pedidos — módulo puro, sem dependência de banco

const STATUS_VALIDOS = ['pendente', 'processando', 'enviado', 'entregue', 'cancelado'];
const FORMAS_PAGAMENTO = ['credito', 'debito', 'pix', 'boleto', 'dinheiro'];

// Modalidade do pedido. Cada produto tem um preço para cada uma; a escolha
// acontece no pedido, não no produto, porque o mesmo carvão pode ser entregue
// ou retirado.
const TIPOS_ENTREGA = ['entrega', 'retirada'];
const MODALIDADE_PADRAO = 'entrega';

// Coluna de preço correspondente a cada modalidade
const COLUNA_PRECO = {
    entrega: 'preco_entrega',
    retirada: 'preco_retirada',
};

const modalidadeValida = (tipo) => TIPOS_ENTREGA.includes(tipo);

// Preço do produto na modalidade do pedido. Modalidade desconhecida cai no
// padrão em vez de devolver undefined e contaminar o total com NaN.
const precoDaModalidade = (produto, tipoEntrega) =>
    produto[COLUNA_PRECO[modalidadeValida(tipoEntrega) ? tipoEntrega : MODALIDADE_PADRAO]];

// Transições permitidas entre status de pedido
const TRANSICOES_STATUS = {
    pendente: ['processando', 'cancelado'],
    processando: ['enviado', 'cancelado'],
    enviado: ['entregue', 'cancelado'],
    entregue: [],
    cancelado: [],
};

const transicaoValida = (atual, novo) =>
    Boolean(STATUS_VALIDOS.includes(novo) && TRANSICOES_STATUS[atual] && TRANSICOES_STATUS[atual].includes(novo));

// -----------------------------------------------------------------------------
// Prazo de alteração pelo cliente
// -----------------------------------------------------------------------------
//
// O usuário comum só mexe no próprio pedido durante os primeiros dias. Passado
// o prazo o pedido continua visível, porém travado — o histórico não some, ele
// apenas deixa de ser editável.
//
// O prazo é medido a partir de `pedido.data` (a data do pedido, não o
// updatedAt): mexer no pedido não pode empurrar a própria validade para frente.

const PRAZO_EDICAO_DIAS = 3;

// Só o pedido que ainda não saiu pode ter seus itens reescritos. Um pedido já
// processado, enviado, entregue ou cancelado tem o estoque movimentado de forma
// definitiva — trocar a lista de produtos ali desfaria o histórico, então nem
// o admin mexe.
const STATUS_EDITAVEIS = ['pendente'];

// Pedidos que podem ser cancelados.
//
// Mais largo que STATUS_EDITAVEIS de propósito: cancelar um pedido em
// processamento ou enviado devolve o estoque corretamente (mudarStatus chama
// devolverEstoque), então não existe o problema de integridade que impede a
// reescrita de itens. 'entregue' e 'cancelado' ficam de fora — a mercadoria já
// saiu ou o cancelamento já aconteceu, e desfazer mentiria sobre o estoque.
//
// Vale para o admin também, que cancela sem prazo: o teto aqui é físico (o
// estoque já foi movimentado), não temporal.
const STATUS_CANCELAVEIS = ['pendente', 'processando', 'enviado'];

const MS_POR_DIA = 24 * 60 * 60 * 1000;

// Instante-limite da edição, ou null se o pedido não tem data utilizável.
const prazoEdicao = (pedido) => {
    if (!pedido || !pedido.data) return null;
    const data = new Date(pedido.data);
    if (Number.isNaN(data.getTime())) return null;
    return new Date(data.getTime() + PRAZO_EDICAO_DIAS * MS_POR_DIA);
};

const dentroDoPrazoDeEdicao = (pedido, agora = new Date()) => {
    const limite = prazoEdicao(pedido);
    return Boolean(limite) && agora.getTime() <= limite.getTime();
};

const statusEditavel = (pedido) => Boolean(pedido) && STATUS_EDITAVEIS.includes(pedido.status);

const statusCancelavel = (pedido) => Boolean(pedido) && STATUS_CANCELAVEIS.includes(pedido.status);

// As duas condições juntas, que é o que os controllers consultam. A checagem de
// dono do pedido NÃO é feita aqui: ela depende de quem está logado e mora em
// utils/permissoes.
const pedidoEditavel = (pedido, agora = new Date()) =>
    statusEditavel(pedido) && dentroDoPrazoDeEdicao(pedido, agora);

// Trabalha em centavos (inteiros) para evitar erros de arredondamento binário
const paraCentavos = (valorDecimal) => Math.round(parseFloat(valorDecimal) * 100);

// Média por pedido raramente fecha em centavos: 310 / 7 dá
// 44.285714285714285, e um campo de dinheiro com 17 dígitos significativos vira
// lixo na tela e no JSON consumido por outro sistema. Arredonda na fronteira,
// depois da divisão — arredondar antes mudaria o resultado.
const mediaEmCentavos = (total, quantidade) => {
    const n = Number(quantidade);
    if (!Number.isFinite(Number(total)) || !Number.isFinite(n) || n <= 0) {
        return 0;
    }
    return Math.round((Number(total) / n) * 100) / 100;
};

// itens:   [{ produto_id, quantidade }]
// produtos: Map<produto_id, { preco_entrega, preco_retirada }>
// tipoEntrega: 'entrega' | 'retirada' (define qual preço do produto vale)
//
// O preço é buscado pelo id, e não pela posição no array: quando o mesmo
// produto aparece em mais de uma linha, a agregação muda o tamanho da lista e
// qualquer alinhamento posicional passaria a associar quantidade ao preço
// errado — ou estourar o array e devolver NaN.
const calcularTotalCentavos = (itens, produtos, tipoEntrega = MODALIDADE_PADRAO) =>
    itens.reduce(
        (acc, item) =>
            acc +
            paraCentavos(precoDaModalidade(produtos.get(item.produto_id), tipoEntrega)) *
                Number(item.quantidade),
        0
    );

module.exports = {
    STATUS_VALIDOS,
    FORMAS_PAGAMENTO,
    TIPOS_ENTREGA,
    MODALIDADE_PADRAO,
    TRANSICOES_STATUS,
    transicaoValida,
    modalidadeValida,
    precoDaModalidade,
    paraCentavos,
    mediaEmCentavos,
    calcularTotalCentavos,
    PRAZO_EDICAO_DIAS,
    STATUS_EDITAVEIS,
    STATUS_CANCELAVEIS,
    statusCancelavel,
    prazoEdicao,
    dentroDoPrazoDeEdicao,
    statusEditavel,
    pedidoEditavel,
};
