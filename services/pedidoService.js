// Regras de escrita de pedido — a única implementação.
//
// A API JSON e a UI web (HTML) atendem no mesmo path `/pedidos`, então as
// duas chamam estas funções em vez de repetir a lógica. A duplicação seria
// especialmente perigosa aqui: a agregação de itens repetidos por produto e
// a validação de estoque já tiveram um bug real (estoque negativo), e uma
// segunda cópia poderia reintroduzi-lo só no caminho do navegador.

const { Pedido, ItemPedido, Cliente, Produto, sequelize } = require('../models');
const { Op } = require('sequelize');
const {
    STATUS_VALIDOS,
    FORMAS_PAGAMENTO,
    TIPOS_ENTREGA,
    MODALIDADE_PADRAO,
    STATUS_EDITAVEIS,
    transicaoValida,
    precoDaModalidade,
    calcularTotalCentavos,
    prazoEdicao,
    dentroDoPrazoDeEdicao,
} = require('../utils/pedidoRules');
const { rotuloStatus } = require('../utils/formatar');
const { excedeDecimal } = require('../utils/limites');
const { validarEndereco, enderecoPreenchido } = require('../utils/endereco');
// Checagem canônica de "inteiro positivo dentro do INTEGER do Postgres" — a
// mesma usada para params de rota e para o corpo da API JSON.
const { ehInteiroPositivo } = require('../middleware/validate');

const falha = (status, message) => Object.assign(new Error(message), { status });

// Total do pedido em reais, já conferido contra a coluna.
//
// Só o teto do DECIMAL(12,2) é problema real aqui: as faixas de preço já são
// validadas no cadastro do produto (utils/limites), mas o TOTAL é o produto de
// preço por quantidade e multiplica. Com o teto de preço e o estoque máximo
// aceitos, 101 unidades de um produto a 99.999.999,99 já estoura a coluna —
// "numeric field overflow", que virava 500 depois de todo o trabalho de
// travar linhas e rollback. Recusar aqui devolve 400 com mensagem útil.
const totalDoPedido = (porProduto, produtos, modalidade) => {
    const valor_total =
        calcularTotalCentavos(
            [...porProduto].map(([produto_id, quantidade]) => ({ produto_id, quantidade })),
            produtos,
            modalidade
        ) / 100;

    const limite = excedeDecimal('valor_total', valor_total);
    if (limite) throw falha(400, limite);

    return valor_total;
};

const devolverEstoque = async (pedidoId, t) => {
    const itens = await ItemPedido.findAll({
        where: { pedido_id: pedidoId },
        transaction: t,
        attributes: ['produto_id', 'quantidade'],
    });

    if (!itens.length) return;

    // Uma única leitura para todos os produtos em vez de um findByPk por item:
    // o N+1 segurava uma transação aberta (com lock) enquanto fazia consultas
    // em série, alongando a janela de contenção de estoque.
    const produtos = await Produto.findAll({
        where: { id: { [Op.in]: itens.map((i) => i.produto_id) } },
        transaction: t,
        lock: t.LOCK.UPDATE,
        // orderBy explícito: sem ele a ordem dos locks depende do plano (index
        // scan costuma vir em ordem, mas não é garantido). Mesma disciplina de
        // agregarItens — ordem global única evita ciclo entre transações.
        order: [['id', 'ASC']],
    });

    const porId = new Map(produtos.map((p) => [p.id, p]));

    for (const item of itens) {
        const produto = porId.get(item.produto_id);
        if (produto) {
            await produto.increment('estoque', { by: item.quantidade, transaction: t });
        }
    }
};

// Une as linhas do formulário em [{ produto_id, quantidade }], descartando as
// linhas deixadas em branco (o formulário tem linhas fixas para o usuário poder
// preencher só o que precisa).
const itensDoFormulario = (body = {}) => {
    const produtos = body.item_produto_id || [];
    const quantidades = body.item_quantidade || [];
    const itens = [];

    const tamanho = Math.max(
        Array.isArray(produtos) ? produtos.length : 0,
        Array.isArray(quantidades) ? quantidades.length : 0,
        0
    );

    for (let i = 0; i < tamanho; i++) {
        const produto = Array.isArray(produtos) ? produtos[i] : produtos;
        const quantidade = Array.isArray(quantidades) ? quantidades[i] : quantidades;
        const produtoLimpo = String(produto ?? '').trim();
        const quantidadeLimpa = String(quantidade ?? '').trim();

        // Linha totalmente vazia: ignorada. Meia linha preenchida: erro, senão
        // o usuário perde o produto escolhido sem perceber.
        if (!produtoLimpo && !quantidadeLimpa) continue;
        if (!produtoLimpo) throw falha(400, 'Informe o produto de todos os itens preenchidos');
        if (!quantidadeLimpa) throw falha(400, 'Informe a quantidade de todos os itens preenchidos');

        itens.push({ produto_id: produtoLimpo, quantidade: quantidadeLimpa });
    }

    return itens;
};

// Aceita tanto o array da API ({ produto_id, quantidade }) quanto as linhas
// indexadas do formulário (item_produto_id[]/item_quantidade[]).
const normalizarItens = (body) =>
    Array.isArray(body.itens) ? body.itens : itensDoFormulario(body);

// Valida cada linha e soma as repetições do mesmo produto.
//
// Agregar por produto ANTES de tocar no banco é o que evita o bug de estoque
// negativo: com estoque 8 e itens [{p1,5},{p1,5}], duas validações independentes
// passariam (cada uma vê 8) e o decremento depois deixaria o estoque em -2.
// Usado por criarPedido e editarPedido para que a regra seja a mesma nos dois.
const agregarItens = (itens) => {
    const porProduto = new Map();

    for (const item of itens) {
        const quantidade = Number(item.quantidade);
        const produto_id = Number(item.produto_id);

        if (!Number.isInteger(quantidade) || quantidade < 1) {
            throw falha(400, 'A quantidade de cada item deve ser um número inteiro maior que zero');
        }
        if (!Number.isInteger(produto_id) || produto_id < 1) {
            throw falha(400, 'produto_id inválido');
        }

        porProduto.set(produto_id, (porProduto.get(produto_id) || 0) + quantidade);
    }

    // Devolve as entradas em ordem crescente de produto_id. Os locks pessimistas
    // são tomados na ordem de iteração deste Map em criarPedido/editarPedido;
    // sem ordenar, dois pedidos com os produtos em ordens opostas ([A,B] e
    // [B,A]) travariam A→B e B→A ao mesmo tempo e o Postgres abortaria um deles
    // por deadlock. Ordem global única elimina o ciclo.
    return new Map([...porProduto].sort((a, b) => a[0] - b[0]));
};

// Sentinelas do tratamento de endereço na edição. Duas constantes em vez de um
// `null` porque "não mexer no endereço" e "apagar o endereço" produzem o mesmo
// valor e ainda significam coisas opostas — com um único `null` não dava para
// distinguir "mantém" de "limpa", e o update apagaria o endereço ao editar só os
// itens de uma entrega.
const MANTER_ENDERECO = 'manter';
const PEDIDO_SEM_ENDERECO = Object.freeze({
    endereco_cep: null,
    endereco_logradouro: null,
    endereco_numero: null,
    endereco_complemento: null,
    endereco_bairro: null,
    endereco_cidade: null,
    endereco_uf: null,
});

// Endereço: obrigatório só na entrega.
//
// A decisão mora AQUI e não no controller, porque criacao e edicao são
// caminhos diferentes que-cigam no mesmo bug quando a regra é duplicada — e
// 'entregue precisa de endereço, retirado não' depende da MODALIDADE do pedido,
// que é justamente o dado que cada controller resolve de um jeito.
//
// Em retirada o endereço é zerado em vez de só ignorado: se o cliente preencheu
// a página de entrega, mudou para retirada e pediu, gravar a rua onde ele
// mora seria informação errada no pedido.
const resolverEndereco = (entrada, modalidade) => {
    const { valores, erros } = validarEndereco(entrada, { obrigatorio: modalidade === 'entrega' });
    if (erros.length) throw falha(400, erros.join('; '));
    // Devolve as sete colunas zeradas de propósito, e não null: quem consome
    // espalha o resultado com spread, e {...null} é no-op — devolver null
    // deixaria o endereço antigo sobreviver na retirada.
    return modalidade === 'entrega' ? valores : PEDIDO_SEM_ENDERECO;
};

// `contato` são os três campos de contato já validados pelo controller
// (utils/contato). Chegam vazios/ausentes no fluxo do admin, e o pedido fica
// com as colunas nulas; no fluxo do cliente são obrigatórios.
const criarPedido = async ({ cliente_id, forma_pagamento, tipo_entrega, itens, contato, endereco }) => {
    if (!cliente_id || !forma_pagamento) {
        throw falha(400, 'cliente_id e forma_pagamento são obrigatórios');
    }

    // cliente_id chega cru de dois caminhos: o formulário HTML (onde
    // cliente_id[$ne]=1 vira objeto pelo parser `extended`) e a API JSON. Sem
    // esta checagem, um objeto/array chega ao findByPk e o Postgres responde com
    // erro de tipo (500). A validação mora no serviço — não em cada controller —
    // para que os dois caminhos compartilhem a mesma regra.
    if (!ehInteiroPositivo(cliente_id)) {
        throw falha(400, 'Cliente inválido');
    }

    if (!FORMAS_PAGAMENTO.includes(forma_pagamento)) {
        throw falha(400, 'Forma de pagamento inválida. Use: ' + FORMAS_PAGAMENTO.join(', '));
    }

    // Sem valor explícito, o pedido é uma entrega — o modo mais comum e o que
    // o sistema assumia antes de a coluna existir.
    const modalidade = tipo_entrega || MODALIDADE_PADRAO;
    if (!TIPOS_ENTREGA.includes(modalidade)) {
        throw falha(400, 'Tipo de entrega inválido. Use: ' + TIPOS_ENTREGA.join(', '));
    }

    if (!Array.isArray(itens) || itens.length === 0) {
        throw falha(400, 'O pedido deve ter pelo menos um item');
    }

    const porProduto = agregarItens(itens);

    // Antes da transação: endereço inválido não deve chegar a abrir transação
    // nem a travar linha de produto para ser recusado.
    const enderecoFinal = resolverEndereco(endereco, modalidade);

    // Transação garante consistência entre pedido, itens e estoque
    const t = await sequelize.transaction();
    try {
        const cliente = await Cliente.findByPk(cliente_id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!cliente) {
            throw falha(404, 'Cliente não encontrado');
        }

        // Índice por produto_id: calcularTotalCentavos e a gravação dos itens
        // passam a olhar pelo id, não por posição no array.
        const produtos = new Map();

        for (const [produtoId, quantidadeTotal] of porProduto) {
            // Lock pessimista impede venda concorrente além do estoque
            const produto = await Produto.findByPk(produtoId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!produto) {
                throw falha(404, `Produto ${produtoId} não encontrado`);
            }

            if (produto.estoque < quantidadeTotal) {
                throw falha(
                    400,
                    `Estoque insuficiente para ${produto.nome}: disponível ${produto.estoque}, solicitado ${quantidadeTotal}`
                );
            }

            produtos.set(produtoId, produto);
        }

        // Total calculado em centavos e convertido de volta para decimal,
        // usando o preço da modalidade escolhida no pedido.
        const valor_total = totalDoPedido(porProduto, produtos, modalidade);

        const novoPedido = await Pedido.create({
            cliente_id,
            forma_pagamento,
            tipo_entrega: modalidade,
            valor_total,
            status: 'pendente',
            // Só as chaves contato_* e endereco_* (validadas antes) entram no
            // insert. Um `...(endereco || {})` vazio não sobrescreve nada.
            ...(contato || {}),
            ...(enderecoFinal || {}),
        }, { transaction: t });

        for (const [produtoId, quantidade] of porProduto) {
            const produto = produtos.get(produtoId);

            await ItemPedido.create({
                pedido_id: novoPedido.id,
                produto_id: produtoId,
                quantidade,
                preco_unitario: precoDaModalidade(produto, modalidade),
            }, { transaction: t });

            await produto.decrement('estoque', { by: quantidade, transaction: t });
        }

        await t.commit();
        return novoPedido;
    } catch (err) {
        await t.rollback();
        throw err;
    }
};

// Reescreve um pedido: itens, forma de pagamento e modalidade, recalculando o
// total e revalidando estoque. Compartilhado entre a API e a tela de edição.
//
// `prazoObrigatorio` distingue quem edita: o cliente comum está preso aos 3
// dias; o admin não. A checagem de dono do pedido é feita antes, nos
// controllers, via utils/permissoes.
//
// O contato é opcional na edição: quem não o reenvia mantém o snapshot já
// gravado no pedido, então editar itens não apaga os dados de quem comprou.
// O endereço segue a mesma regra — mas com uma diferença que importa: mudar
// entrega↔retirada tem consequências diferentes. Trocar para entrega exige
// endereço novo; trocar para retirada limpa o endereço antigo.
const editarPedido = async (id, { forma_pagamento, tipo_entrega, itens, contato, endereco }, { prazoObrigatorio = true } = {}) => {
    if (!Array.isArray(itens) || itens.length === 0) {
        throw falha(400, 'O pedido deve ter pelo menos um item');
    }

    if (forma_pagamento && !FORMAS_PAGAMENTO.includes(forma_pagamento)) {
        throw falha(400, 'Forma de pagamento inválida. Use: ' + FORMAS_PAGAMENTO.join(', '));
    }

    if (tipo_entrega && !TIPOS_ENTREGA.includes(tipo_entrega)) {
        throw falha(400, 'Tipo de entrega inválido. Use: ' + TIPOS_ENTREGA.join(', '));
    }

    const porProduto = agregarItens(itens);

    const t = await sequelize.transaction();
    try {
        const pedido = await Pedido.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!pedido) {
            throw falha(404, 'Pedido não encontrado');
        }

        // A modalidade final só é conhecida depois de ler o pedido, e é ela que
        // decide se o endereço é obrigatório. Usar só o `tipo_entrega` do corpo
        // validaria o endereço contra a modalidade antiga, e o UPDATE gravaria
        // uma modalidade diferente daquela contra a qual o endereço foi validado.
        const modalidadeFinal = tipo_entrega || pedido.tipo_entrega;
        const ehEntrega = modalidadeFinal === 'entrega';

        // Endereço na edição, com três casos. O primeiro é o que mais importa:
        // se o cliente só mexeu nos itens e não reenviou o endereço, o que está
        // gravado é preservado. Sem este caso, editar a quantidade de uma
        // entrega apagaria o endereço que o cliente já tinha informado.
        let enderecoParaGravar = MANTER_ENDERECO;
        // enderecoPreenchido, e não um teste de truthiness: lerEndereco sempre
        // devolve um objeto com sete chaves, então `if (endereco)` seria sempre
        // verdadeiro e o caso "manter" logo abaixo nunca rodaria.
        if (enderecoPreenchido(endereco)) {
            // Veio endereço novo: valida. Em retirada, resolverEndereco zera.
            enderecoParaGravar = resolverEndereco(endereco, modalidadeFinal);
        } else if (ehEntrega && !pedido.endereco_logradouro) {
            // Virou entrega e não há endereço nem no corpo nem no pedido: sem
            // recusar aqui o pedido ficaria marcado como entrega e sem lugar
            // para entregar.
            throw falha(400, 'Informe o endereço de entrega');
        } else if (!ehEntrega) {
            // Virou retirada: limpa o endereço, que deixou de valer.
            enderecoParaGravar = PEDIDO_SEM_ENDERECO;
        }

        // Reescrita de itens só é possível enquanto nada saiu do lugar. O
        // estoque de um pedido já processado/enviado/entregue já foi consumido;
        // devolvê-lo aqui desfaria a baixa de verdade do negócio.
        if (!STATUS_EDITAVEIS.includes(pedido.status)) {
            throw falha(
                403,
                `Pedido ${rotuloStatus(pedido.status).toLowerCase()} não pode mais ser alterado. Só pedidos pendentes aceitam edição.`
            );
        }

        // O admin não tem prazo; o cliente tem 3 dias. A checagem fica dentro da
        // transação para o prazo ser lido com a linha travada.
        if (prazoObrigatorio && !dentroDoPrazoDeEdicao(pedido)) {
            const limite = prazoEdicao(pedido);
            throw falha(
                403,
                `O prazo de edição deste pedido encerrou em ${limite ? limite.toLocaleString('pt-BR') : '-'}.`
            );
        }

        const pagamentoFinal = forma_pagamento || pedido.forma_pagamento;

        // Devolve o que os itens antigos ocupavam ANTES de validar os novos: sem
        // isso, trocar 5 unidades do produto A por 5 do produto B falharia por
        // estoque de B mesmo que a devolução fosse liberá-lo na sequência.
        await devolverEstoque(pedido.id, t);

        const produtos = new Map();
        for (const [produtoId, quantidadeTotal] of porProduto) {
            const produto = await Produto.findByPk(produtoId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!produto) {
                throw falha(404, `Produto ${produtoId} não encontrado`);
            }
            if (produto.estoque < quantidadeTotal) {
                throw falha(
                    400,
                    `Estoque insuficiente para ${produto.nome}: disponível ${produto.estoque}, solicitado ${quantidadeTotal}`
                );
            }
            produtos.set(produtoId, produto);
        }

        const valor_total = totalDoPedido(porProduto, produtos, modalidadeFinal);

        // Substitui a lista inteira. O preço unitário é recalculado com a
        // modalidade final: trocar entrega por retirada reflete o preço de
        // retirada em TODOS os itens, não só nos novos.
        await ItemPedido.destroy({ where: { pedido_id: pedido.id }, transaction: t });

        for (const [produtoId, quantidade] of porProduto) {
            const produto = produtos.get(produtoId);

            await ItemPedido.create({
                pedido_id: pedido.id,
                produto_id: produtoId,
                quantidade,
                preco_unitario: precoDaModalidade(produto, modalidadeFinal),
            }, { transaction: t });

            await produto.decrement('estoque', { by: quantidade, transaction: t });
        }

        await pedido.update(
            {
                forma_pagamento: pagamentoFinal,
                tipo_entrega: modalidadeFinal,
                valor_total,
                ...(contato || {}),
                // Só entra no update quando o endereço realmente mudou: a
                // sentinela MANTER_ENDERECO é uma string, e espalhá-la no
                // update criaria colunas novas na tabela do nada.
                ...(enderecoParaGravar === MANTER_ENDERECO ? {} : enderecoParaGravar),
            },
            { transaction: t }
        );

        await t.commit();
        return pedido;
    } catch (err) {
        await t.rollback();
        throw err;
    }
};

const mudarStatus = async (id, status) => {
    if (!STATUS_VALIDOS.includes(status)) {
        throw falha(400, 'Status inválido. Use: ' + STATUS_VALIDOS.join(', '));
    }

    // Leitura, validação da transição e escrita na MESMA transação, com lock
    // pessimista na linha do pedido. Sem isso, duas requisições simultâneas
    // validariam a mesma transição a partir da mesma leitura obsoleta, e um
    // cancelamento poderia devolver estoque em duplicidade.
    const t = await sequelize.transaction();
    let pedido;

    try {
        pedido = await Pedido.findByPk(id, {
            transaction: t,
            lock: t.LOCK.UPDATE,
        });

        if (!pedido) {
            throw falha(404, 'Pedido não encontrado');
        }

        if (!transicaoValida(pedido.status, status)) {
            throw falha(
                400,
                `Transição inválida: "${pedido.status}" → "${status}"`
            );
        }

        // Cancelamento devolve os itens ao estoque
        if (status === 'cancelado') {
            await devolverEstoque(pedido.id, t);
        }

        await pedido.update({ status }, { transaction: t });
        await t.commit();
        return pedido;
    } catch (err) {
        await t.rollback();
        throw err;
    }
};

const excluirPedido = async (id) => {
    const t = await sequelize.transaction();

    try {
        const pedido = await Pedido.findByPk(id, {
            transaction: t,
            lock: t.LOCK.UPDATE,
        });

        if (!pedido) {
            throw falha(404, 'Pedido não encontrado');
        }

        // Pedidos já cancelados tiveram o estoque devolvido no cancelamento
        if (pedido.status !== 'cancelado') {
            await devolverEstoque(pedido.id, t);
        }

        await pedido.destroy({ transaction: t });
        await t.commit();
    } catch (err) {
        await t.rollback();
        throw err;
    }
};

module.exports = {
    falha,
    criarPedido,
    editarPedido,
    mudarStatus,
    excluirPedido,
    normalizarItens,
    itensDoFormulario,
    agregarItens,
    devolverEstoque,
};
