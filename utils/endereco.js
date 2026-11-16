'use strict';

// Normalização e validação de endereço.
//
// Existe porque o endereço entra por dois caminhos muito diferentes — o JSON do
// checkout (public/js/carrinho.js) e o formulário HTML do admin — e os dois
// precisam acabar no MESMO formato antes de gravar. Sem um ponto único de
// verdade, o admin gravaria "SC" e o cliente "sc", e a consulta por cidade
// passaria a depender de caixa.
//
// A regra de ouro: normalizar SEMPRE na entrada, e gravar o resultado
// normalizado. Guardar a string como o usuário digitou é o que faz o relatório
// divergir depois.

// As 27 unidades federativas. Uma UF solto passaria no VARCHAR(2) e viraria
// lixo silencioso no relatório.
const UFS = [
    'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT',
    'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
];

// Tira o que não é dígito e devolve só os 8. Aceita o CEP com e sem máscara
// ("88955-000" e "88955000" são o mesmo CEP; gravar os dois formatos faria a
// mesma endereço não ser encontrado por busca).
const normalizarCep = (valor) => String(valor ?? '').replace(/\D/g, '');

// O formato gravado é sempre o do correio, "88955-000": é o que o cliente
// reconhece e o que aparece no comprovante. Um VÁRIO sem hífen também existe no
// correio, mas representá-lo exigiria guardar a forma original por cima, o que
// não compensa para um campo só.
const formatarCep = (cep) => {
    const d = normalizarCep(cep);
    return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
};

// Espaços das pontas e, no meio, espaços duplicados viram um só. Compressão
// interna não é exagero: "Rua  das  Palmeiras" colado de um celular chega com
// espaço duplo quase sempre, e isso quebra a busca por logradouro.
const limparTexto = (valor) =>
    String(valor ?? '').trim().replace(/\s{2,}/g, ' ');

const ehCepValido = (cep) => normalizarCep(cep).length === 8;
const ehUfValida = (uf) => UFS.includes(String(uf || '').trim().toUpperCase());

// Campos obrigatórios só quando a entrega é em domicílio. Complemento é
// opcional em qualquer caso (apartamento/sala é opcional mesmo em prédio).
const ROTULOS = {
    logradouro: 'o logradouro',
    numero: 'o número',
    bairro: 'o bairro',
    cidade: 'a cidade',
    uf: 'a UF',
};

const CAMPOS_OBRIGATORIOS = Object.keys(ROTULOS);

// Limites das colunas, espelhando a migration 20261001000001-pedidos-endereco.
// Sem isto, um texto maior que o VARCHAR estoura o Postgres com "value too long"
// e vira 500 em vez de 400 — o mesmo cuidado que utils/contato já toma para
// nome/e-mail/telefone. O CEP não entra aqui: normalizarCep garante que ele só
// chega ao banco com 8 dígitos (9 com o hífen).
const LIMITES = {
    logradouro: 255,
    numero: 20,
    complemento: 255,
    bairro: 120,
    cidade: 120,
};

// Como cada campo é chamado na mensagem de erro. Separado de ROTULOS porque
// lá o artigo serve à frase "Informe o logradouro"; aqui o artigo já vem junto.
const NOMES = {
    logradouro: 'O logradouro',
    numero: 'O número',
    complemento: 'O complemento',
    bairro: 'O bairro',
    cidade: 'A cidade',
};

// Lê o endereço do corpo da requisição aceitando as duas formas que existem:
// achatado (endereco_cep, endereco_logradouro...) ou aninhado (endereco: { cep,
// logradouro... }). O JSON do checkout manda aninhado; um form HTML manda
// achatado, porque inputs não se aninham sozinhos.
const lerEndereco = (body = {}) => {
    const origem = body && body.endereco && typeof body.endereco === 'object' ? body.endereco : (body || {});
    return {
        cep: origem.cep ?? origem.endereco_cep,
        logradouro: origem.logradouro ?? origem.endereco_logradouro,
        numero: origem.numero ?? origem.endereco_numero,
        complemento: origem.complemento ?? origem.endereco_complemento,
        bairro: origem.bairro ?? origem.endereco_bairro,
        cidade: origem.cidade ?? origem.endereco_cidade,
        uf: origem.uf ?? origem.endereco_uf,
    };
};

// O corpo traz endereço de verdade, ou só o objeto vazio que lerEndereco
// devolve quando nenhum campo veio?
//
// Sem isto, editar a quantidade de uma entrega apagaria o endereço: o corpo
// não tem nenhum campo de endereço, mas lerEndereco mesmo assim devolve um
// objeto com sete chaves null — que é truthy, então a checagem "veio
// endereço?" responderia sim para um formulário que não mandou nada.
const enderecoPreenchido = (entrada = {}) => {
    if (!entrada || typeof entrada !== 'object') return false;
    return Object.values(entrada).some((v) => String(v ?? '').trim() !== '');
};

// Lê o endereço de qualquer origem (body JSON ou form) e devolve
// { valores, erros }. `valores` já vem normalizado e com as chaves ausentes
// preenchidas com null — assim o UPDATE não recebe string vazia e não apaga
// coluna por engano.
const validarEndereco = (entrada = {}, opcoes = {}) => {
    // Por padrão o endereço é obrigatório (entrega). O checkout de retirada
    // chama com { obrigatorio: false } e descarta o resultado.
    const obrigatorio = opcoes.obrigatorio !== false;
    const erros = [];

    const cep = normalizarCep(entrada.cep ?? entrada.endereco_cep);
    const uf = limparTexto(entrada.uf ?? entrada.endereco_uf).toUpperCase();

    const valores = {
        endereco_cep: cep ? formatarCep(cep) : null,
        endereco_logradouro: limparTexto(entrada.logradouro ?? entrada.endereco_logradouro) || null,
        endereco_numero: limparTexto(entrada.numero ?? entrada.endereco_numero) || null,
        endereco_complemento: limparTexto(entrada.complemento ?? entrada.endereco_complemento) || null,
        endereco_bairro: limparTexto(entrada.bairro ?? entrada.endereco_bairro) || null,
        endereco_cidade: limparTexto(entrada.cidade ?? entrada.endereco_cidade) || null,
        endereco_uf: uf || null,
    };

    if (!obrigatorio) {
        // Retirada: se o cliente preencheu algo, valida do mesmo jeito; se não
        // preencheu nada, o endereço é descartado lá em cima.
        const preencheuAlgo = Object.values(valores).some((v) => v !== null);
        if (!preencheuAlgo) {
            return { valores: null, erros };
        }
    }

    if (cep && !ehCepValido(cep)) {
        erros.push('CEP deve ter 8 dígitos');
    }

    // Um campo acima do limite da coluna precisa virar 400 aqui, não 500 no
    // banco. Roda mesmo quando o endereço é opcional (retirada com algo
    // preenchido): se o cliente digitou, o dado vai ser gravado e tem que caber.
    for (const [campo, max] of Object.entries(LIMITES)) {
        const valor = valores[`endereco_${campo}`];
        if (valor && valor.length > max) {
            erros.push(`${NOMES[campo]} deve ter no máximo ${max} caracteres`);
        }
    }

    for (const campo of CAMPOS_OBRIGATORIOS) {
        if (!valores[`endereco_${campo}`]) {
            erros.push(`Informe ${ROTULOS[campo]}`);
        }
    }

    // A UF só é validada contra a lista quando veio preenchida; um campo vazio
    // já foi tratado como obrigatório acima e não precisa de duas mensagens.
    if (uf && !ehUfValida(uf)) {
        erros.push('UF inválida');
    }

    return { valores: erros.length ? null : valores, erros };
};

// Monta a linha para o banco a partir de um Pedido (ou objeto com as mesmas
// chaves), para a tela de detalhe não repetir os sete campos um por um.
const enderecoDe = (pedido) => {
    if (!pedido || !pedido.endereco_logradouro) return null;
    return {
        cep: pedido.endereco_cep,
        logradouro: pedido.endereco_logradouro,
        numero: pedido.endereco_numero,
        complemento: pedido.endereco_complemento,
        bairro: pedido.endereco_bairro,
        cidade: pedido.endereco_cidade,
        uf: pedido.endereco_uf,
    };
};

// Uma linha, para log e para o rodapé do comprovante.
const enderecoLinhaDe = (end) => {
    if (!end) return '';
    return [
        [end.logradouro, end.numero].filter(Boolean).join(', '),
        end.complemento,
        end.bairro,
        [end.cidade, end.uf].filter(Boolean).join(' - '),
        end.cep,
    ].filter(Boolean).join(' · ');
};

module.exports = {
    UFS,
    lerEndereco,
    normalizarCep,
    formatarCep,
    ehCepValido,
    ehUfValida,
    limparTexto,
    validarEndereco,
    enderecoPreenchido,
    enderecoDe,
    enderecoLinhaDe,
};