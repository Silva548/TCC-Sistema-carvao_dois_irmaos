'use strict';

// Dados da empresa em um lugar só.
//
// Antes, "Carvão Dois Irmãos" estava repetido em quatro arquivos (title do
// layout, marca da navbar, h1 da home e rodapé) e telefone/endereço não
// existiam em lugar nenhum do projeto. Divir o mesmo dado em N arquivos é como
// a informação fica desatualizada na metade deles: trocar o telefone vira caça
// ao tesouro. Aqui o dado é escrito uma vez e as views leem daqui.
//
// Origem: página "Localização" do protótipo (`c_prototipo/cliente/
// localizacao.html`), que é a versão com os dados reais. O README do protótipo
// ainda traz os placeholders `(11) 1234-5678` e
// `contato@carvaodoisirmaos.com.br`; foram descartados de propósito.
//
// Telefone e WhatsApp: o protótipo escreve `(48)998498867` com `tel:
// +55998498867`. Os dois formatos ficam separados porque um serve para
// exibir e o outro, para o link — número com máscara não funciona no
// `tel:`/`wa.me`.

const empresa = {
    nome: 'Carvão Especial Dois Irmãos',
    // Versão curta para o título e a navbar, onde o nome completo não cabe.
    nomeCurto: 'Carvão Dois Irmãos',
    slogan: 'Qualidade e tradição há mais de 20 anos',

    // Logomarca. Fica em public/img, servida por express.static, e é
    // referenciada pelas views via empresa.logo para o caminho existir em um
    // só lugar. O texto alternativo é o próprio nome da empresa.
    logo: '/img/logo.jpeg',

    endereco: {
        logradouro: 'Estrada Geral Palmeira',
        complemento: 'Interior',
        cidade: 'Balneário Gaivota',
        uf: 'SC',
        cep: '88955-000',
    },

    contato: {
        telefone: '(48) 99849-8867',
        // Só dígitos com código do país, usado em tel: e wa.me.
        telefoneLink: '55998498867',
        email: 'dasilvanicolas117@gmail.com',
    },

    // Link de mapa da própria empresa. O protótipo usava a API do Google Maps
    // (que exige chave e conta paga), então aqui fica o link que abre o app de
    // mapas do celular: não depende de chave, não carrega script de terceiro e
    // não adiciona origem nenhuma à CSP.
    mapaUrl: 'https://maps.google.com/maps/search/Carv%C3%A3o%20dois%20irm%C3%A3os/@-29.07238713,-49.53898147,17z?hl=pt-BR',

    // Usado no schema.org da página de localização, para o buscador achar a
    // loja pelo endereço.
    coordenadas: {
        latitude: -29.07238713,
        longitude: -49.53898147,
    },

    // Horários como texto pronto, para não repetir a lógica de "está aberto
    // agora?" em EJS.
    horario: [
        { dias: 'Segunda a Sexta', horas: '7h às 11h e 13h às 17h', aberto: true },
        { dias: 'Sábado', horas: '7h às 12h', aberto: true },
        { dias: 'Domingo', horas: 'Fechado', aberto: false },
    ],
};

// Endereço em uma linha, para o rodapé e para a mensagem do mapa.
const enderecoLinha = (e = empresa.endereco) =>
    [e.logradouro, e.complemento, `${e.cidade} - ${e.uf}`, e.cep]
        .filter(Boolean)
        .join(', ');

// Link de WhatsApp com mensagem pronta: abre o app já com o texto, o que evita
// o "oi?" e a pessoa precisar lembrar o que queria.
const whatsappUrl = (mensagem = 'Olá! Vim pelo site e gostaria de um orçamento.') =>
    `https://wa.me/${empresa.contato.telefoneLink}?text=${encodeURIComponent(mensagem)}`;

module.exports = {
    empresa,
    enderecoLinha,
    whatsappUrl,
};