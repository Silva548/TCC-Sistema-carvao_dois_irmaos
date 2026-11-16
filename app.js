require('dotenv').config();

const path = require('path');
const express = require('express');
const methodOverride = require('method-override');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { sessionPool } = require('./config/db');
const { empresa, enderecoLinha, whatsappUrl } = require('./config/empresa');

const indexRoutes = require('./routes/indexRoutes');
const empresaRoutes = require('./routes/empresaRoutes');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const produtoRoutes = require('./routes/produtoSequelizeRoutes');
const categoriaRoutes = require('./routes/categoriaRoutes');
const clienteRoutes = require('./routes/clienteRoutes');
const pedidoRoutes = require('./routes/pedidoRoutes');
const perfilRoutes = require('./routes/perfilRoutes');
const catalogoRoutes = require('./routes/catalogoRoutes');

const { requireAuth, requireRole, carregarUsuario } = require('./middleware/auth');
const { csrfSetup, verifyCsrf } = require('./middleware/csrf');
const { uploadProduto } = require('./middleware/upload');
const { requestId } = require('./middleware/requestId');
const { healthCheck } = require('./middleware/health');
const { criarStore } = require('./middleware/rateLimitStore');

// Carrega models/index.js para registrar as associações do Sequelize antes de
// qualquer controller — sem isso, sequelize.include() falha em runtime.
require('./models');

const app = express();

// Necessário atrás de proxy (nginx etc.) para IP real do cliente:
// rate limiting por IP e cookies secure funcionam corretamente.
//
// Só liga com TRUST_PROXY=true explícito — inclusive em produção. A versão
// anterior ligava também só por NODE_ENV=production, e isso é um furo: sem
// proxy real na frente, o Express passa a confiar no X-Forwarded-For que o
// próprio cliente envia. Um header novo a cada requisição dá um IP novo ao
// express-rate-limit, e o limite de login vira decorativo (medido: 12 tentativas
// com senha errada e IP forjado -> 0 bloqueadas, com limite 5). É exatamente o
// que o .env.example já advertia contra. Inferir "produção ⇒ existe proxy" é
// suposição que quebra em qualquer deploy direto — container, VM, service.
if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
}

if (!process.env.SESSION_SECRET) {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('SESSION_SECRET não definido. Configure-o no arquivo .env antes de rodar em produção.');
    }
    // Em desenvolvimento, gera um segredo aleatório (não persiste entre restarts)
    process.env.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
    console.warn('AVISO: SESSION_SECRET gerado aleatoriamente para desenvolvimento. Configure-o no .env.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);

// Dados da empresa disponíveis para TODAS as views, sem cada controller ter
// que passar. `app.locals` (e não `res.locals`) porque é o mesmo objeto para
// qualquer requisição: telefone e endereço não variam por usuário, e fazer
// `res.locals` obrigaria os ~30 controllers a lembrar de repassar o dado, com o
// risco de uma tela nova nascer sem contato nenhum.
app.locals.empresa = empresa;
app.locals.enderecoLinha = enderecoLinha;
app.locals.whatsappUrl = whatsappUrl;

app.use(requestId);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // views/layout.ejs carrega Bootstrap, jQuery e Popper de
            // cdn.jsdelivr.net, todos com integrity=SRI. Antes eram três
            // origens distintas (jsdelivr, code.jquery.com, maxcdn); consolidar
            // deixa a CSP com uma só e o SRI passa a ser a garantia real de que
            // o recurso não foi trocado no caminho. A versão do jQuery subiu
            // 3.5.1 -> 3.7.1 (o build slim do 3.5.1 no code.jquery.com não é
            // mais servido de forma estável). maxcdn.bootstrapcdn.com está
            // fora: se alguém voltar a usá-lo, a CSP bloqueia em vez de abrir
            // uma origem sem SRI.
            styleSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
            scriptSrc: ["'self'", 'cdn.jsdelivr.net'],
            imgSrc: ["'self'", 'data:'],
            // O preenchimento de endereço por CEP (public/js/endereco.js) consulta
            // o ViaCEP do navegador. Sem esta diretiva a chamada cairia no
            // defaultSrc e seria bloqueada — e a falha apareceria só como "o
            // CEP não preencheu", sem mensagem no console apontando a CSP.
            connectSrc: ["'self'", 'https://viacep.com.br'],
        },
    },
}));

// Arquivos estáticos próprios: CSS do tema, JS do carrinho e as imagens de
// produto enviadas pelo admin. A CSP já contempla estas origens (styleSrc e
// imgSrc com 'self'; scriptSrc com 'self').
app.use(express.static(path.join(__dirname, 'public')));

// CORS: same-origin por padrão. Sem CORS_ORIGINS configurado, nenhuma origem
// externa é atendida. Com origens listadas, apenas elas recebem headers CORS.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const ehMesmaOrigem = (origin, req) => {
    try {
        return new URL(origin).host === req.get('host');
    } catch {
        return false;
    }
};

const corsMiddleware = (req, res, next) => {
    if (ALLOWED_ORIGINS.length === 0) {
        // Sem origens configuradas: same-origin only (padrão seguro)
        return next();
    }

    // A resposta varia por Origin; sem isso um cache intermediário poderia
    // servir a resposta de uma origem autorizada para outra.
    res.vary('Origin');

    const origin = req.get('Origin');
    if (!origin) {
        // Requisições sem Origin (navegação, curl) seguem normais
        return next();
    }

    const mesmaOrigem = ehMesmaOrigem(origin, req);
    if (!mesmaOrigem && !ALLOWED_ORIGINS.includes(origin)) {
        return res.status(403).json({ error: 'Origem não permitida' });
    }

    if (!mesmaOrigem) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Requested-With, X-CSRF-Token');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.status(204).end();
    }

    next();
};

app.use(corsMiddleware);

// A sonda de saúde fica ANTES do limitador global, por dois motivos.
//
// 1. Um liveness probe a cada 10s são 90 requisições por janela de 15min, do
//    mesmo IP, somadas ao tráfego real. Dentro do limite, um serviço saudável
//    pode cruzá-lo e o orquestrador reinicia algo que está funcionando.
// 2. Se o banco cair, o limitador passa a errar também (o store é o Postgres),
//    e uma sonda dentro dele devolveria 500 — justamente o sinal de
//    "degraded" que o healthCheck existe para emitir sumiria.
app.get('/health', healthCheck);

// Store no Postgres: com o MemoryStore padrão um restart zera a janela (vale
// como renovação do limite) e cada réplica conta os clientes por conta própria.
//
// passOnStoreError degrada em vez de derrubar: sem a tabela rate_limit (migration
// esquecida no deploy) ou com o banco instável, o limitador deixa de contar, mas
// o site continua respondendo. O alternative — 500 em toda rota dinâmica —
// transformaria uma falha de infraestrutura em indisponibilidade total.
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_MAX) || 100,
    standardHeaders: true,
    legacyHeaders: false,
    store: criarStore('global'),
    passOnStoreError: true,
    // A lib já registra o erro do store pelo logger padrão; o callback abaixo é
    // redundante e a versão instalada rejeita opções desconhecidas, então não é
    // passado. O que importa é o passOnStoreError acima.
}));

app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(methodOverride('_method'));

// Sessões persistidas no PostgreSQL (sobrevive a restarts e não vaza memória).
// Reutiliza o mesmo pool do Sequelize em vez de abrir um segundo.
app.use(session({
    secret: process.env.SESSION_SECRET,
    name: 'sessionId',
    resave: false,
    saveUninitialized: false,
    store: new (require('connect-pg-simple')(session))({
        pool: sessionPool,
        createTableIfMissing: true,
        ttl: 2 * 60 * 60, // 2 horas, em segundos
    }),
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 2 * 60 * 60 * 1000, // 2 horas
    },
}));

// Reidrata a identidade do usuário a partir do banco ANTES de qualquer decisão
// de autorização, inclusive antes do gate do upload abaixo.
//
// A posição importa: os cookies de sessão guardam a fotografia do momento do
// login, então um requireAuth montado antes daqui leria um userId que pode já
// não existir no banco. Foi o que aconteceu ao proteger o upload: uma conta
// excluída com a sessão ainda viva recebia 403 (papel 'user' lido do cookie
// velho) em vez do 302 para o login que o caso realmente é.
app.use(carregarUsuario);

// Disponibiliza o usuário logado para todas as views.
// Roda depois de carregarUsuario, então role/username vêm do banco e não da
// fotografia congelada no momento do login.
app.use((req, res, next) => {
    res.locals.currentUser = req.session.userId
        ? {
            id: req.session.userId,
            username: req.session.username,
            role: req.session.role,
            clienteId: req.session.clienteId ?? null,
        }
        : null;
    next();
});

// Upload multipart precisa ser parseado ANTES do verifyCsrf: o CSRF lê o token
// de req.body, e um formulário multipart ainda estaria vazio neste ponto.
// Fica restrito a /produtos — único formulário com arquivo.
//
// Os gates de sessão e papel vêm ANTES do multer, e a ordem aqui não é
// detalhe. Com o upload montado antes do requireAuth, um POST anônimo era
// recusado com 302 e mesmo assim deixava o arquivo órfão em
// public/uploads/produtos: o limpador de
// controllers/produtoSequelizeController nunca executa, porque o controller não
// é alcançado. Repetir o pedido virava escrita em disco por qualquer visitante.
// requireAuth/requireRole não leem o body, então não interferem na ordem CSRF
// descrita acima.
//
// O outro lado do mesmo problema — o verifyCsrf, que precisa vir DEPOIS do
// multer — não pede mais nada aqui porque o upload não toca o disco: o arquivo
// fica em memória (ver middleware/upload.js) e só o controller o grava, já com o
// formulário validado. Recusado, não há arquivo para apagar.
app.use('/produtos', requireAuth, requireRole('admin'), uploadProduto);

// Proteção CSRF para todas as rotas que alteram estado
app.use(verifyCsrf);

// Expõe o token às views SEM gravar sessão de visitantes anônimos;
// a gravação ocorre apenas no formulário de login e nas áreas protegidas
app.use((req, res, next) => {
    res.locals.csrfToken = req.session.csrfToken;
    next();
});

// A sonda /health foi registrada antes do limitador global (ver o comentário
// lá em cima). Não repetir aqui: o Express usaria a primeira definição, e a
// segunda deixaria de ser alcançável.

// Rotas públicas
// app.locals (e não res.locals) porque é o escopo compartilhado que o Express
// mescla automaticamente nas opções de res.render. Assim as views de pedidos
// formatam moeda, data e status sem repetir a lógica em cada template.
app.locals.formatadores = require('./utils/formatar');

// Mesma ideia para o endereço: as sete colunas viram uma linha pronta, e a view
// não precisa montar "logradouro, número · bairro · cidade - UF · CEP" em cada
// tela que mostra o endereço (a ficha do pedido e o e-mail de confirmação).
app.locals.enderecoDe = require('./utils/endereco').enderecoDe;
app.locals.enderecoLinhaDe = require('./utils/endereco').enderecoLinhaDe;

app.use('/', authRoutes);
app.use('/', indexRoutes);
// Página pública de endereço/horário: fica com a home, fora do bloco
// protegido, porque o cliente precisa encontrá-la antes de criar conta.
app.use('/', empresaRoutes);

// Rotas protegidas (exigem autenticação)
// csrfSetup roda só aqui: garante token para os formulários sem criar
// sessão em visitas anônimas
//
// Cadastros são exclusivos de administradores: o usuário comum não mantém
// catálogo nem carteira de clientes, só faz pedidos. O gate fica aqui, e não em
// cada controller, para não existir rota esquecida sem checagem (um GET de
// listagem não passa por validação de corpo para lembrar o autor).
app.use('/produtos', requireAuth, requireRole('admin'), csrfSetup, produtoRoutes);
app.use('/categorias', requireAuth, requireRole('admin'), csrfSetup, categoriaRoutes);
app.use('/clientes', requireAuth, requireRole('admin'), csrfSetup, clienteRoutes);
app.use('/pedidos', requireAuth, csrfSetup, pedidoRoutes);

// Área do cliente comum: edição dos próprios dados de contato (nome, e-mail e
// telefone/WhatsApp). Só o cliente vinculado à conta é editável — o controller
// recusa admin (sem vínculo) e não permite tocar em documento/tipo.
app.use('/meus-dados', requireAuth, csrfSetup, perfilRoutes);

// Gestão de usuários é exclusiva de administradores
app.use('/users', requireAuth, requireRole('admin'), csrfSetup, userRoutes);

// Catálogo de leitura do cliente comum (a ficha do produto). Exige sessão
// porque é onde o carrinho vive: sem login não há para onde adicionar, então
// o requireAuth é o filtro honesto. Fica fora de /produtos de propósito — lá
// é o painel do admin.
// csrfSetup entra para que o bloco do carrinho (que a ficha inclui) receba o
// token do POST que fecha o pedido.
app.use('/catalogo', requireAuth, csrfSetup, catalogoRoutes);

const { ehJson } = require('./utils/responder');

// 404 - rota não encontrada
app.use((req, res) => {
    if (ehJson(req)) {
        return res.status(404).json({ error: 'Rota não encontrada' });
    }
    res.status(404).render('404');
});

// Tratamento central de erros (não vaza detalhes internos ao cliente)
// next é obrigatório para o Express reconhecer este como errorHandler (4 args);
// a regra no-unused-vars já ignora args por nome em ^_|^next$.
app.use((err, req, res, next) => {
    // 4xx são respostas esperadas (validação, permissão) e não precisam do
    // stack completo no log; só os 5xx ganham o dump inteiro para diagnóstico.
    const status = err.status || 500;
    if (status >= 500) {
        console.error(`[Erro][${req.id}]`, err); // log completo (com stack) apenas no servidor
    } else {
        console.warn(`[Aviso][${req.id}] ${status} ${err.message}`);
    }

    // Se a resposta já começou a sair (stream, redirect com dados, etc.),
    // tentar renderizar aqui estoura "Cannot set headers after they are sent".
    // O next() entrega o erro ao handler final do Express, que só fecha a
    // conexão.
    if (res.headersSent) {
        return next(err);
    }

    const mensagem = err.status ? err.message : 'Erro interno do servidor';

    if (ehJson(req)) {
        // O id vai junto para o cliente poder citar o log exato sem precisar
        // de acesso ao servidor.
        const corpo = { error: mensagem };
        if (status >= 500) corpo.requestId = req.id;
        return res.status(status).json(corpo);
    }

    const paginaErro = status === 404
        ? '404'
        : status === 403
            ? '403'
            : status >= 400 && status < 500
                ? '400'
                : '500';

    res.status(status).render(paginaErro, {
        erro: mensagem,
        requestId: req.id,
        // Erros podem estourar ANTES dos middlewares que publicam usuário e
        // token (o upload de /produtos, por exemplo, é montado antes). Sem
        // isto, a página de erro quebra no layout ao buscar currentUser/csrf.
        currentUser: res.locals.currentUser || null,
        csrfToken: res.locals.csrfToken || '',
    });
});

module.exports = app;
