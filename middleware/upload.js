// Upload das imagens de produto (multer).
//
// As imagens ficam em public/uploads/produtos, servidas por express.static sob
// a CSP já existente (imgSrc 'self'). O nome é gerado por nós — nunca vem do
// cliente — então não há como sobrescrever arquivos nem injetar '..' no caminho.
//
// O multer segura o arquivo EM MEMÓRIA (memoryStorage) e quem escreve em disco
// é o controller, depois de a validação passar. Isso é deliberado: com
// diskStorage o arquivo nascia em public/uploads no instante em que a requisição
// chegava, antes de qualquer checagem, e virava órfão em toda requisição recusada
// por um middleware que não seja o controller — o caso do verifyCsrf, que roda
// DEPOIS do multer porque o token vem no corpo multipart. Limpar no fim do
// ciclo da resposta não resolvia de forma confiável: 'close' dispara depois que o
// cliente já recebeu os bytes, e o unlink é assíncrono, então a limpeza corria
// em paralelo com quem fosse olhar o diretório.
//
// Não havendo escrita antes da decisão, a classe inteira do problema some: quem
// recusa não tem o que apagar.
//
// O custo é até TAMANHO_MAX (2 MB) de memória por requisição, e o upload já é
// restrito a um arquivo por requisição.
//
// ATENÇÃO À ORDEM DE MIDDLEWARES: verifyCsrf (app.js) lê req.body._csrf e roda
// globalmente ANTES das rotas. Um formulário multipart só é parseado pelo
// multer, então o upload precisa ser montado antes do verifyCsrf; caso
// contrário o token viria vazio e todo envio de produto com foto daria 403.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const PASTA_PUBLICA = '/uploads/produtos';
const DIRETORIO = path.join(__dirname, '..', 'public', 'uploads', 'produtos');

const TAMANHO_MAX = 2 * 1024 * 1024; // 2 MB
const EXTENSOES = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
};

const falha = (status, message) => Object.assign(new Error(message), { status });

// Assinatura dos formatos aceitos. O fileFilter só olha o Content-Type, que o
// cliente escolhe: mandar um HTML ou um SVG com Content-Type de JPEG passava.
// A checagem abaixo lê os primeiros bytes do arquivo de verdade, então um
// script disfarçado é recusado na origem.
const ASSINATURAS = {
    '.jpg': [0xff, 0xd8, 0xff],
    '.png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    '.webp': null, // verificado à parte: RIFF + WEBP nos offsets 0 e 8
};

const assinaturaConfere = (buffer, extensao) => {
    const esperada = ASSINATURAS[extensao];
    if (!esperada) {
        return buffer.length >= 12
            && buffer.toString('ascii', 0, 4) === 'RIFF'
            && buffer.toString('ascii', 8, 12) === 'WEBP';
    }
    return esperada.every((byte, i) => buffer[i] === byte);
};

const upload = multer({
    // Ver o comentário do topo: o arquivo fica em memória até o controller
    // decidir gravá-lo.
    storage: multer.memoryStorage(),
    // parts/fields fecham o envio de milhares de campos não-arquivo num único
    // POST multipart — com memoryStorage tudo acumularia em memória, e o
    // limit do express.urlencoded não vale para multipart.
    limits: { fileSize: TAMANHO_MAX, files: 1, parts: 20, fields: 20 },
    fileFilter: (req, file, cb) => {
        if (!EXTENSOES[file.mimetype]) {
            return cb(falha(400, 'Envie uma imagem JPG, PNG ou WEBP.'));
        }
        cb(null, true);
    },
});

// Grava o arquivo escolhido em disco e devolve o caminho público, ou null
// quando não veio arquivo nenhum (a foto é opcional).
//
// Quem chama isto é o controller, já depois de validar o formulário — então um
// cadastro recusado não chega a tocar o disco. Lança em erro de disco, e quem
// chama trata com o mesmo next(err) de sempre.
const gravarImagem = async (file) => {
    if (!file || !file.buffer) {
        return null;
    }

    // A extensão vem do mimetype, que o fileFilter já restringiu à lista acima.
    const extensao = EXTENSOES[file.mimetype] || '.bin';

    // Última porta antes do disco: o conteúdo precisa ser mesmo a imagem que a
    // extensão promete.
    if (!assinaturaConfere(file.buffer, extensao)) {
        throw falha(400, 'O arquivo enviado não é uma imagem JPG, PNG ou WEBP válida.');
    }

    const nome = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extensao}`;

    await fs.promises.mkdir(DIRETORIO, { recursive: true });
    await fs.promises.writeFile(path.join(DIRETORIO, nome), file.buffer);

    return `${PASTA_PUBLICA}/${nome}`;
};

// Apaga o arquivo de uma imagem já gravada. Melhor esforço: falha de disco não
// deve derrubar a operação principal (troca/exclusão do produto). Também engole
// o ENOENT, para o caller poder chamar sem medo de apagar duas vezes.
const removerImagem = (caminho) => {
    if (!caminho) return;

    const nome = path.basename(String(caminho));
    const absoluto = path.join(DIRETORIO, nome);

    fs.unlink(absoluto, () => {});
};

// Executa o multer e converte os erros dele em 4xx legíveis, em vez de deixar
// cair no handler global como 500.
const uploadProduto = (req, res, next) => {
    upload.single('imagem')(req, res, (err) => {
        if (!err) return next();

        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return next(falha(400, 'A imagem deve ter no máximo 2 MB.'));
            }
            return next(falha(400, 'Não foi possível processar a imagem enviada.'));
        }

        next(err);
    });
};

module.exports = {
    uploadProduto,
    gravarImagem,
    removerImagem,
    DIRETORIO,
    TAMANHO_MAX,
    EXTENSOES,
};
