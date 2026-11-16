// Dados de contato do cliente no pedido.
//
// O cliente comum sempre informa nome, e-mail e WhatsApp no envio, e o pedido
// guarda uma cópia (snapshot) desses três campos. A cópia é o que garante que
// a loja consiga falar com quem comprou mesmo que o cadastro do cliente seja
// alterado depois — o pedido continua apontando para clientes, mas a folha de
// contato é histórica.
//
// Aceita as duas formas que chegam ao servidor:
//   - JSON do carrinho: { contato: { nome, email, telefone } }
//   - formulário HTML: contato_nome / contato_email / contato_telefone

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LIMITE_NOME = 255;
const LIMITE_EMAIL = 255;
const LIMITE_TELEFONE = 20;

const texto = (valor) => {
    if (valor === undefined || valor === null) return '';
    return String(valor).trim();
};

const lerContato = (body = {}) => {
    const origem = body && body.contato && typeof body.contato === 'object' ? body.contato : (body || {});

    return {
        contato_nome: texto(origem.contato_nome ?? origem.nome),
        contato_email: texto(origem.contato_email ?? origem.email).toLowerCase(),
        contato_telefone: texto(origem.contato_telefone ?? origem.telefone ?? origem.whatsapp),
    };
};

const contatoVazio = (contato) =>
    !contato.contato_nome && !contato.contato_email && !contato.contato_telefone;

// Devolve { dados } com apenas os três campos graváveis, ou { erro }.
//
// `obrigatorio` é o que separa os fluxos: o cliente comum tem que informar os
// três; admin e API podem criar pedido sem contato, e nesse caso um contato
// parcialmente preenchido continua sendo erro (não é "ignorar o que veio").
const validarContato = (contato, { obrigatorio = false } = {}) => {
    const { contato_nome, contato_email, contato_telefone } = contato;

    if (contatoVazio(contato)) {
        if (obrigatorio) {
            return { erro: 'Informe nome, e-mail e WhatsApp para contato' };
        }
        return { dados: {} };
    }

    if (contato_nome.length > LIMITE_NOME) {
        return { erro: `O nome do contato deve ter no máximo ${LIMITE_NOME} caracteres` };
    }
    if (contato_email.length > LIMITE_EMAIL) {
        return { erro: `O e-mail do contato deve ter no máximo ${LIMITE_EMAIL} caracteres` };
    }
    if (contato_telefone.length > LIMITE_TELEFONE) {
        return { erro: `O WhatsApp deve ter no máximo ${LIMITE_TELEFONE} caracteres` };
    }

    if (!contato_nome) return { erro: 'Informe o nome para contato' };
    if (!contato_email || !EMAIL_REGEX.test(contato_email)) return { erro: 'Informe um e-mail válido para contato' };
    if (!contato_telefone) return { erro: 'Informe o WhatsApp para contato' };

    return { dados: { contato_nome, contato_email, contato_telefone } };
};


// ---------------------------------------------------------------------------
// CPF/CNPJ
// ---------------------------------------------------------------------------
//
// Mora aqui (e não duplicado em cada controller) porque é a mesma regra para os
// dois caminhos que gravam cliente: o cadastro público e a tela do admin.
//
// O motivo de existir: clientes.documento tem índice UNIQUE, mas a unicidade só
// vale para a STRING exata. Sem normalizar, o mesmo CPF entrava duas vezes
// — "12345678901" pelo admin e "123.456.789-01" pelo cadastro público — e o
// índice não reclamava, porque são textos diferentes. Tirar tudo que não é
// dígito faz a comparação voltar a ser sobre o número.

const TAMANHOS_DOCUMENTO = [11, 14]; // CPF, CNPJ

const normalizarDocumento = (valor) => String(valor === undefined || valor === null ? '' : valor).replace(/\D/g, '');

// Devolve { dados } com o documento já normalizado, ou { erro }.
//
// A checagem de tamanho é o que separa "documento" de "número qualquer":
// aceitar "123" como CPF só joga lixo na tabela de clientes.
const validarDocumento = (valor) => {
    const documento = normalizarDocumento(valor);

    if (!documento) return { erro: 'O documento é obrigatório' };
    if (!TAMANHOS_DOCUMENTO.includes(documento.length)) {
        return { erro: 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)' };
    }

    return { dados: { documento } };
};

module.exports = {
    lerContato,
    validarContato,
    contatoVazio,
    EMAIL_REGEX,
    normalizarDocumento,
    validarDocumento,
};
