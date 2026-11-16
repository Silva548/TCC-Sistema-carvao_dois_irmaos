// Testes de integração: sobem o app real (config/db.js, sessão, CSRF, rotas)
// em uma porta efêmera e falam HTTP com fetch.
//
// Sem dependência nova (nada de supertest): o app já exporta a instância
// express, então basta listen(0) e usar a porta que o sistema escolher.
//
// Estes testes exigem o banco de testes, preparado por scripts/setup-test-db.js
// (roda sozinho no `pretest`). Sem DB_NAME_TEST ou sem servidor no ar, a
// suíte inteira é omitida em vez de derrubar `npm test`.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { Sequelize } = require('sequelize');

const TEST_DB = process.env.DB_NAME_TEST;

// Precisa vir antes de qualquer require que carregue config/db.js, senão o app
// conecta no banco de desenvolvimento
if (TEST_DB) {
    process.env.DB_NAME = TEST_DB;
}

const semBanco = !TEST_DB;
const BASE = { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 5432, dialect: 'postgres' };

let app;
let server;
let baseUrl;
let sequelize;
let autenticado;
let User;
let Cliente;
let Categoria;
let Produto;

const USUARIO = { username: 'teste_integracao', password: 'Senha@123', role: 'admin' };
// Conta de cliente comum: vinculada a `clienteTeste` no semear(). É a partir
// dela que os testes provam o recorte de acesso (só pedidos próprios).
const USUARIO_CLIENTE = { username: 'teste_cliente', password: 'Senha@123', role: 'user' };

let clienteTeste;
let outroCliente;

// Precisa ser definido antes de require('../app'): os limitadores leem o env
// na construção do módulo
process.env.LOGIN_RATE_LIMIT = process.env.LOGIN_RATE_LIMIT || '1000';
process.env.CADASTRO_RATE_LIMIT = process.env.CADASTRO_RATE_LIMIT || '1000';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '10000';
// O freio por conta conta falhas de login, e a suíte faz login errado de
// propósito em vários testes. Sem erguer o limite, uma conta testada esgotaria o
// contador e passaria a recuar login legítimo nos testes seguintes.
process.env.LOGIN_CONTA_RATE_LIMIT = process.env.LOGIN_CONTA_RATE_LIMIT || '1000';

// ---------------------------------------------------------------------------
// Infraestrutura
// ---------------------------------------------------------------------------

const bancoDisponivel = async () => {
    if (semBanco) return false;
    sequelize = new Sequelize(TEST_DB, process.env.DB_USER, process.env.DB_PASSWORD, {
        ...BASE, username: process.env.DB_USER, password: process.env.DB_PASSWORD, logging: false,
    });
    try {
        await sequelize.authenticate();
        return true;
    } catch {
        return false;
    }
};

// Cliente HTTP com cookie jar: mantém a sessão entre requisições, como um browser
const criarCliente = (base) => {
    const cookies = new Map();

    return async (caminho, { method = 'GET', body, headers = {}, redirect = 'manual', raw = false } = {}) => {
        const cabecalhos = { ...headers };
        if (cookies.size) {
            cabecalhos.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
        }

        let corpo;
        if (body !== undefined) {
            if (raw) {
                // multipart: o próprio FormData gera a boundary, então
                // Content-Type não pode ser montado aqui.
                corpo = body;
            } else {
                cabecalhos['Content-Type'] = 'application/x-www-form-urlencoded';
                // Aceita lista de pares além do objeto, porque é o único jeito de
                // repetir uma chave: new URLSearchParams({ 'a[]': [1, 2] }) gera
                // "a[]=1%2C2" (uma string com vírgula), enquanto o browser envia
                // "a[]=1&a[]=2". O formulário de pedidos depende dessa repetição.
                corpo = new URLSearchParams(body).toString();
            }
        }

        const res = await fetch(`${base}${caminho}`, { method, headers: cabecalhos, body: corpo, redirect });

        for (const bruto of res.headers.getSetCookie?.() || []) {
            const [par] = bruto.split(';');
            const idx = par.indexOf('=');
            cookies.set(par.slice(0, idx).trim(), par.slice(idx + 1).trim());
        }

        return res;
    };
};

const extrairCsrf = async (cliente, caminho = '/login', opcoes = {}) => {
    // opcoes existe porque a rota precisa do Accept de navegador: sem ele o
    // despachante responde JSON e a página nem chega a ser renderizada.
    const res = await cliente(caminho, opcoes);
    const html = await res.text();
    const match = html.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(match, `não encontrei o token CSRF em ${caminho} (status ${res.status})`);
    return match[1];
};

// O destino de pós-login viaja como campo hidden `next` do formulário — o
// middleware/auth.js o coloca na query do redirect, e o controller o repassa
// para o form. Ler os dois do HTML reflete o round-trip real do browser.
const abrirLogin = async (cliente, caminho = '/login') => {
    const res = await cliente(caminho);
    const html = await res.text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/);
    const next = html.match(/name="next" value="([^"]*)"/);
    assert.ok(csrf, `formulário de login sem token CSRF em ${caminho}`);
    return { csrf: csrf[1], proximo: next ? next[1] : '' };
};

// Reproduz o round-trip do browser numa rota protegida: /produtos responde 302
// para /login?next=%2Fprodutos. O cliente usa redirect:'manual', então o
// Location precisa ser seguido à mão — senão o formulário é renderizado sem o
// `next` e o teste passaria por vazio.
const abrirLoginAposRedirect = async (cliente, rotaProtegida = '/produtos') => {
    const redirecionado = await cliente(rotaProtegida);
    assert.equal(redirecionado.status, 302, 'rota protegida deveria redirecionar');

    const location = redirecionado.headers.get('location');
    assert.match(location, /^\/login\?next=/);

    const url = new URL(location, baseUrl);
    return abrirLogin(cliente, url.pathname + url.search);
};

const fazerLogin = async (cliente, usuario = USUARIO) => {
    const csrf = await extrairCsrf(cliente, '/login');
    const res = await cliente('/login', {
        method: 'POST',
        body: { username: usuario.username, password: usuario.password, _csrf: csrf },
    });
    assert.equal(res.status, 302, `login falhou: ${res.status} ${await res.text()}`);
    return res;
};

const semear = async () => {
    const { hashSync } = bcrypt;

    // Um TRUNCATE só, com CASCADE: destruir modelo por modelo falha em
    // "clientes" por causa da FK de "pedidos".
    //
    // "rate_limit" entra na lista porque os limitadores são persistidos (o
    // MemoryStore zava a janela num restart, mas não entre dois testes da mesma
    // execução). Sem limpar, um teste que esgota um limite barra os seguintes.
    await sequelize.query(
        `TRUNCATE TABLE "itens_pedidos", "pedidos", "produtos", "categorias", "clientes", "users", "rate_limit", "session" RESTART IDENTITY CASCADE`
    );

    await User.create({ username: USUARIO.username, password: hashSync(USUARIO.password, 10), role: USUARIO.role });
    await Categoria.create({ nome: 'Carvão Vegetal' });

    clienteTeste = await Cliente.create({ nome: 'Cliente Teste', email: 'cliente@teste.com', documento: '12345678901' });
    outroCliente = await Cliente.create({ nome: 'Cliente Outro', email: 'outro@teste.com', documento: '10987654321' });

    // O usuário comum representa EXATAMENTE um cliente. O vínculo é o que
    // permite a ele ver e criar pedidos, e apenas para este cliente.
    await User.create({
        username: USUARIO_CLIENTE.username,
        password: hashSync(USUARIO_CLIENTE.password, 10),
        role: USUARIO_CLIENTE.role,
        cliente_id: clienteTeste.id,
    });
};test.before(async () => {
    if (semBanco) {
        console.warn('[integração] DB_NAME_TEST não definido — suíte de integração omitida.');
        return;
    }
    if (!(await bancoDisponivel())) {
        console.warn(`[integração] banco "${TEST_DB}" inacessível — suíte de integração omitida.`);
        return;
    }

    // app só depois do ajuste de DB_NAME
    app = require('../app');
    ({ User, Cliente, Categoria, Produto } = require('../models'));

    await semear();

    await new Promise((resolve) => {
        server = app.listen(0, resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Sessão compartilhada: evita refazer login (e estourar o limitador) em
    // cada teste que só precisa estar autenticado
    autenticado = criarCliente(baseUrl);
    await fazerLogin(autenticado);
});

test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (sequelize) await sequelize.close();
});

const pular = () => (semBanco || !baseUrl);

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test('app sobe e responde no /health', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    const res = await cliente('/health');

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', database: 'up' });
});

test('toda resposta carrega X-Request-Id e o cliente pode propagá-lo', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    const gerado = await cliente('/health');
    assert.match(gerado.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);

    const meu = 'req-abc-123';
    const res = await cliente('/health', { headers: { 'X-Request-Id': meu } });
    assert.equal(res.headers.get('x-request-id'), meu, 'o id enviado deve ser preservado');
});

test('X-Request-Id malformado é substituído por um gerado', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    // Valor aceito pelo transporte HTTP mas rejeitado pela regex do middleware
    // (que só admite /[\w.:-]/). Uma quebra de linha não serve aqui: o próprio
    // fetch a recusa antes de sair, então o teste não exercitaria o middleware.
    const malformado = 'id invalido com espacos';
    const res = await cliente('/health', { headers: { 'X-Request-Id': malformado } });

    assert.notEqual(res.headers.get('x-request-id'), malformado);
    assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('API /pedidos responde 401 em JSON, não 302 de browser', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);

    // Regressão de F12: com Accept: */* (padrão de curl/fetch) a API respondia
    // com redirect HTML em vez de 401
    const padrao = await cliente('/pedidos');
    assert.equal(padrao.status, 401);
    assert.match(padrao.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await padrao.json(), { error: 'Não autenticado' });

    const explicito = await cliente('/pedidos', { headers: { Accept: 'application/json' } });
    assert.equal(explicito.status, 401);

    // Navegação de browser continua redirecionando para o login
    const nav = await cliente('/pedidos', { headers: { Accept: 'text/html,application/xhtml+xml' } });
    assert.equal(nav.status, 302);
    assert.match(nav.headers.get('location'), /^\/login\?next=/);
});

test('rota inexistente em rota JSON devolve 404 em JSON', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    // autenticado: sem sessão o requireAuth responde 401 antes da 404
    // Caminho com dois segmentos: um único segmento cai em router.param('id') e
    // responderia 400 (id inválido), que não é o que este teste exercita.
    const res = await autenticado('/pedidos/1/rota-que-nao-existe');

    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
});

test('rota inexistente em navegação devolve HTML', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    const res = await cliente('/pagina-que-nao-existe', { headers: { Accept: 'text/html' } });

    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /text\/html/);
});

test('login bem-sucedido cria sessão e libera a API', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    const login = await fazerLogin(cliente);

    assert.equal(login.headers.get('location'), '/');
    assert.match(login.headers.get('set-cookie') || '', /sessionId=/);

    const pedidos = await cliente('/pedidos');
    assert.equal(pedidos.status, 200);

    const corpo = await pedidos.json();
    assert.ok(Array.isArray(corpo.pedidos));
    assert.equal(corpo.pedidos.length, 0, 'banco limpo, então não há pedidos');
    assert.equal(corpo.paginacao.total, 0);
});

test('cookie de sessão é httpOnly e SameSite', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    const csrf = await extrairCsrf(cliente, '/login');
    const res = await cliente('/login', {
        method: 'POST',
        body: { username: USUARIO.username, password: USUARIO.password, _csrf: csrf },
    });

    const cookie = (res.headers.getSetCookie?.() || []).join(';');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
});

test('login sem token CSRF é recusado com 403', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await extrairCsrf(cliente, '/login');
    const res = await cliente('/login', {
        method: 'POST',
        body: { username: USUARIO.username, password: USUARIO.password },
    });

    assert.equal(res.status, 403);
});

test('senha errada não autentica', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    const csrf = await extrairCsrf(cliente, '/login');
    const res = await cliente('/login', {
        method: 'POST',
        body: { username: USUARIO.username, password: 'senha-errada', _csrf: csrf },
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login', 'falha devolve ao formulário, não avança');

    const pedidos = await cliente('/pedidos');
    assert.equal(pedidos.status, 401, 'sessão anônima após falha');
});

test('login recusa tipos não escalares sem estourar 500', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    const csrf = await extrairCsrf(cliente, '/login');

    const senhaArray = await cliente('/login', {
        method: 'POST',
        body: [['username', USUARIO.username], ['password[]', 'x'], ['_csrf', csrf]],
    });
    assert.equal(senhaArray.status, 302, 'senha em array deve voltar ao formulário, não 500');

    const usuarioObjeto = await cliente('/login', {
        method: 'POST',
        body: [['username[$ne]', USUARIO.username], ['password', 'x'], ['_csrf', csrf]],
    });
    assert.equal(usuarioObjeto.status, 302, 'username como objeto deve voltar ao formulário, não 500');
});

test('credenciais inválidas na API devolvem 401 sem revelar se o usuário existe', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    const csrf = await extrairCsrf(cliente, '/login');

    const inexistente = await cliente('/login', {
        method: 'POST',
        body: { username: 'nao_existe_ninguem', password: 'x', _csrf: csrf },
    });
    const existente = await cliente('/login', {
        method: 'POST',
        body: { username: USUARIO.username, password: 'x', _csrf: csrf },
    });

    assert.equal(inexistente.status, existente.status, 'respostas devem ser indistinguíveis');
});

test('returnTo malicioso não vira redirect para fora do site', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);

    // O vetor real é o campo `next` do POST /login: ele vem do corpo da
    // requisição, totalmente controlado pelo atacante, e vira o Location do
    // redirect de sucesso. (requireAuth põe o next na query, mas só sob
    // /produtos|/categorias|... , onde o originalUrl nunca começa com "//".)
    const { csrf } = await abrirLogin(cliente);

    const res = await cliente('/login', {
        method: 'POST',
        body: {
            username: USUARIO.username,
            password: USUARIO.password,
            _csrf: csrf,
            next: '//evil.com/x',
        },
    });

assert.equal(res.status, 302);
    const destino = res.headers.get('location');
    assert.equal(destino, '/', `um next protocol-relative deve cair em "/", veio "${destino}"`);
    assert.ok(!destino.startsWith('//'), `destino não pode ser protocol-relative: "${destino}"`);
});

test('returnTo legítimo é preservado após o login', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    const { csrf, proximo } = await abrirLoginAposRedirect(cliente);
    assert.equal(proximo, '/produtos', 'o destino legítimo deve chegar ao formulário');

    const res = await cliente('/login', {
        method: 'POST',
        body: { username: USUARIO.username, password: USUARIO.password, _csrf: csrf, next: proximo },
    });

    assert.equal(res.headers.get('location'), '/produtos');
});

// ---------------------------------------------------------------------------
// Criação de conta
// ---------------------------------------------------------------------------

// Documento de teste: exatamente 11 dígitos (CPF), como a validação exige.
//
// O contador entra porque dois testes podem pedir o documento no mesmo
// milissegundo e o índice UNIQUE de clientes.documento não perdoa: sem ele, a
// segunda geração colide com a primeira e o teste falha por motivo errado.
let contadorDocumento = 0;
const documentoNovo = () => {
    const semente = `${String(Date.now()).slice(-9)}${String(contadorDocumento++).padStart(2, '0')}`;
    return semente.padStart(11, '0').slice(-11);
};

test('cadastro guarda o CPF só com dígitos e a pontuação não contorna o UNIQUE', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    // Regressão: clientes.documento tem índice UNIQUE, mas a unicidade é da
    // STRING. Sem normalizar, "555.444.333-22" e "55544433322" eram duas linhas
    // diferentes para o mesmo CPF e o índice não reclamava.
    const cru = documentoNovo();
    const formatado = cru.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    assert.notEqual(formatado, cru, 'o teste precisa de duas formas diferentes');

    const primeiro = criarCliente(baseUrl);
    const { csrf } = await abrirLogin(primeiro, '/registrar');
    await primeiro('/registrar', {
        method: 'POST',
        body: {
            _csrf: csrf,
            username: `cpf_${cru.slice(-6)}`,
            password: 'Senha@123',
            nome: 'Cpf Formatado',
            email: `cpf_${cru}@exemplo.com`,
            documento: formatado,
            telefone: '11955554444',
        },
    });

    const salvo = await Cliente.findOne({ where: { email: `cpf_${cru}@exemplo.com` } });
    assert.ok(salvo, 'o cadastro formatado deveria ter sido aceito');
    assert.equal(salvo.documento, cru, 'o documento precisa ser guardado sem pontuação');

    // O mesmo CPF sem pontuação tem que colidir.
    const segundo = criarCliente(baseUrl);
    const { csrf: csrf2 } = await abrirLogin(segundo, '/registrar');
    const res = await segundo('/registrar', {
        method: 'POST',
        body: {
            _csrf: csrf2,
            username: `cpfdup_${cru.slice(-6)}`,
            password: 'Senha@123',
            nome: 'Cpf Duplicado',
            email: `cpfdup_${cru}@exemplo.com`,
            documento: cru,
            telefone: '11955554444',
        },
    });
    assert.match(res.headers.get('location'), /^\/registrar/, 'o CPF repetido tem que ser recusado');
    assert.equal(await Cliente.count({ where: { documento: cru } }), 1, 'não pode existir CPF duplicado');

    const user = await User.findOne({ where: { username: `cpf_${cru.slice(-6)}` } });
    await user.destroy();
    await salvo.destroy();
});

test('cadastro recusa documento que não é CPF nem CNPJ', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    const username = `doccurto_${documentoNovo().slice(-6)}`;
    const { csrf } = await abrirLogin(cliente, '/registrar');

    const res = await cliente('/registrar', {
        method: 'POST',
        body: {
            _csrf: csrf,
            username,
            password: 'Senha@123',
            nome: 'Documento Curto',
            email: `${username}@exemplo.com`,
            documento: '123',
            telefone: '11955554444',
        },
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /CPF|CNPJ/);
    assert.equal(await User.count({ where: { username } }), 0);
});

test('a tela de login oferece o caminho de cadastro e a de cadastro é pública', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);

    const login = await cliente('/login');
    assert.equal(login.status, 200);
    assert.match(await login.text(), /href="\/registrar"/, 'o login precisa linkar para o cadastro');

    const cadastro = await cliente('/registrar');
    assert.equal(cadastro.status, 200);
    const html = await cadastro.text();
    assert.match(html, /name="username"/);
    assert.match(html, /name="nome"/);
    assert.match(html, /name="email"/);
    assert.match(html, /name="documento"/);
    assert.match(html, /name="telefone"/);
    // O formulário não pode oferecer escolha de papel: admin não se cadastra
    // por aqui (continua vindo do seed).
    assert.doesNotMatch(html, /name="role"/, 'o formulário não deve expor o campo role');
});

test('cadastro cria cliente e usuário vinculados, e o usuário entra logo em seguida', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    const username = `novo_${documentoNovo().slice(-8)}`;
    const email = `${username}@exemplo.com`;
    const documento = documentoNovo();

    const { csrf } = await abrirLogin(cliente, '/registrar');

    const res = await cliente('/registrar', {
        method: 'POST',
        body: {
            _csrf: csrf,
            username,
            password: 'Senha@123',
            nome: 'Cliente Novo Teste',
            email,
            documento,
            telefone: '11955554444',
        },
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/login/);

    const user = await User.findOne({ where: { username } });
    assert.ok(user, 'o usuário não foi criado');
    // O vínculo é o que dá sentido à conta: sem cliente_id o usuário não
    // consegue comprar nada (utils/permissoes -> clienteObrigatorio).
    assert.ok(user.cliente_id, 'o usuário ficou sem cliente vinculado');
    assert.equal(user.role, 'user');

    const clienteCriado = await Cliente.findByPk(user.cliente_id);
    assert.equal(clienteCriado.email, email);
    assert.equal(clienteCriado.documento, documento);

    // E a conta funciona de verdade: entra e vê o catálogo.
    const entrada = criarCliente(baseUrl);
    await fazerLogin(entrada, { username, password: 'Senha@123' });
    const home = await entrada('/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id="carrinho-contador"/, 'a conta nova precisa enxergar o carrinho');

    await user.destroy();
    await clienteCriado.destroy();
});

test('cadastro ignora role=admin no corpo da requisição', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    // Este é o teste de segurança da tela nova. Um campo escondido no
    // formulário não protege nada: o papel precisa ser ignorado pelo servidor.
    const cliente = criarCliente(baseUrl);
    const username = `mal_${documentoNovo().slice(-8)}`;

    const { csrf } = await abrirLogin(cliente, '/registrar');
    const res = await cliente('/registrar', {
        method: 'POST',
        body: {
            _csrf: csrf,
            username,
            password: 'Senha@123',
            role: 'admin',
            nome: 'Tentativa De Admin',
            email: `${username}@exemplo.com`,
            documento: documentoNovo(),
            telefone: '11955554444',
        },
    });
    assert.equal(res.status, 302);

    const user = await User.findOne({ where: { username } });
    assert.ok(user, 'o usuário não foi criado');
    assert.equal(user.role, 'user', 'um POST não pode escolher o próprio papel');

    // E o mais importante: a conta não ganhou nenhum acesso de admin.
    const sessao = criarCliente(baseUrl);
    await fazerLogin(sessao, { username, password: 'Senha@123' });
    // requireRole devolve 403 direto (não redireciona): quem não é admin não
    // entra no painel, e a resposta não pode ser 200 nem 302 para o login.
    const admin = await sessao('/produtos');
    assert.equal(admin.status, 403, 'a conta auto-cadastrada não pode alcançar o painel');

    // O cadastro em si é público, então /users precisa fechar igual.
    const usuarios = await sessao('/users');
    assert.equal(usuarios.status, 403, 'a conta auto-cadastrada não pode gerenciar usuários');

    const clienteCriado = await Cliente.findByPk(user.cliente_id);
    await user.destroy();
    await clienteCriado.destroy();
});

test('cadastro recusado não deixa conta pela metade e devolve o formulário', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);

    // E-mail inválido: volta 400 com o formulário, sem gravar nada.
    const { csrf } = await abrirLogin(cliente, '/registrar');
    const username = `ruim_${documentoNovo().slice(-8)}`;
    const res = await cliente('/registrar', {
        method: 'POST',
        body: {
            _csrf: csrf,
            username,
            password: 'Senha@123',
            nome: 'Sem Email Valido',
            email: 'nao-e-email',
            documento: documentoNovo(),
            telefone: '11955554444',
        },
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /e-mail válido/);
    assert.equal(await User.count({ where: { username } }), 0, 'nada pode ser criado');
    assert.equal(
        await Cliente.count({ where: { email: 'nao-e-email' } }),
        0,
        'um cadastro recusado não pode deixar cliente órfão'
    );
});

test('cadastro sem token CSRF é recusado', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const username = `semcsrf_${documentoNovo().slice(-8)}`;
    const cliente = criarCliente(baseUrl);
    const res = await cliente('/registrar', {
        method: 'POST',
        body: {
            username,
            password: 'Senha@123',
            nome: 'Sem Csrf',
            email: `${username}@exemplo.com`,
            documento: documentoNovo(),
            telefone: '11955554444',
        },
    });

    assert.equal(res.status, 403);
    assert.equal(await User.count({ where: { username } }), 0);
});

test('e-mail ou documento repetidos recusam sem dizer qual campo foi', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const username = `dup_${documentoNovo().slice(-8)}`;
    const email = `${username}@exemplo.com`;
    const documento = documentoNovo();

    const primeiro = criarCliente(baseUrl);
    const { csrf } = await abrirLogin(primeiro, '/registrar');
    await primeiro('/registrar', {
        method: 'POST',
        body: { _csrf: csrf, username, password: 'Senha@123', nome: 'Primeiro', email, documento, telefone: '11955554444' },
    });

    // Segundo cadastro com o MESMO e-mail e outro username.
    const segundo = criarCliente(baseUrl);
    const { csrf: csrf2 } = await abrirLogin(segundo, '/registrar');
    await segundo('/registrar', {
        method: 'POST',
        body: {
            _csrf: csrf2,
            username: `${username}_b`,
            password: 'Senha@123',
            nome: 'Segundo',
            email,
            documento: documentoNovo(),
            telefone: '11955554444',
        },
    });

    const html = await (await segundo('/registrar')).text();
    assert.match(html, /já usados/, 'a colisão deve ser avisada');
    // Não basta dizer que falhou: dizer QUAL campo colidiu confirmaria que
    // aquela conta/e-mail existe.
    assert.doesNotMatch(html, /email[^<]*já cadastrado/i, 'a mensagem não pode apontar o campo');
    assert.equal(await User.count({ where: { username: `${username}_b` } }), 0);

    const user = await User.findOne({ where: { username } });
    const clienteCriado = await Cliente.findByPk(user.cliente_id);
    await user.destroy();
    await clienteCriado.destroy();
});

test('query inválida devolve 400 em vez de 500', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);

    const statusRuim = await cliente('/pedidos?status=nao-existe');
    assert.equal(statusRuim.status, 400);
    assert.deepEqual(await statusRuim.json(), {
        error: 'Status inválido. Use: pendente, processando, enviado, entregue, cancelado',
    });

    // Não numérico viraria erro de tipo do Postgres (HTTP 500)
    const clienteRuim = await cliente('/pedidos?cliente_id=abc');
    assert.equal(clienteRuim.status, 400);

    const paginaRuim = await cliente('/pedidos?page=zero');
    assert.equal(paginaRuim.status, 200, 'page inválida cai no padrão 1, não é erro');
});

test('valores válidos de filtro são aceitos', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);

    const clienteId = await Cliente.findOne({ attributes: ['id'] });

    for (const caminho of ['/pedidos?status=pendente', `/pedidos?cliente_id=${clienteId.id}`, '/pedidos?page=1&limit=10']) {
        const res = await cliente(caminho);
        assert.equal(res.status, 200, `${caminho} deveria ser aceito`);
    }
});

test('página absurda é limitada em vez de varrer a tabela', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);

    const res = await cliente('/pedidos?page=999999999');
    assert.equal(res.status, 200);

    const corpo = await res.json();
    assert.equal(corpo.paginacao.pagina, 10000, 'teto de páginas aplicado');
});

test('produtos carregam a categoria associada', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const categoria = await Categoria.findOne();
    await Produto.create({
        nome: 'Carvão 5kg', preco_entrega: 25.5, preco_retirada: 22, embalagem: 'premium',
        peso_kg: 5, estoque: 10, categoria_id: categoria.id,
    });

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);

    const res = await cliente('/produtos');
    assert.equal(res.status, 200);

    const html = await res.text();
    assert.match(html, /Carvão 5kg/);
    assert.match(html, /Carvão Vegetal/, 'nome da categoria deve aparecer na listagem');
});

test('filtro de produtos por categoria rejeita valor não numérico', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);

    const res = await cliente('/produtos?categoria_id=abc');
    assert.equal(res.status, 400);
});

test('ID de recurso não numérico devolve 400, não 500', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);

    // Erro textual vem como text/plain de propósito: se algum dia uma
    // mensagem aqui vier da query string, text/html viraria XSS refletido.
    // Ver o comentário em utils/responder.js.
    const html = await cliente('/produtos/abc');
    assert.equal(html.status, 400);
    assert.match(html.headers.get('content-type'), /text\/plain/);

    const res = await cliente('/produtos/abc', { headers: { Accept: 'application/json' } });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { error: 'ID inválido' });
});

test('rota sem sessão não cria registro na tabela de sessões', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const [antes] = await sequelize.query('SELECT count(*)::int AS n FROM "session"');
    const cliente = criarCliente(baseUrl);
    await cliente('/produtos');           // protegido, sem cookie
    await cliente('/health');
    const [depois] = await sequelize.query('SELECT count(*)::int AS n FROM "session"');

    assert.equal(depois[0].n, antes[0].n, 'visita anônima não deve persistir sessão');
});

test('a coluna senha não existe mais em clientes', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const [colunas] = await sequelize.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'clientes'"
    );
    const nomes = colunas.map((c) => c.column_name);

    assert.ok(!nomes.includes('senha'), 'a coluna senha deveria ter sido removida');
    assert.ok(nomes.includes('nome'));
    // "cpf" foi renomeado para "documento" (aceita CPF e CNPJ) na migração
    assert.ok(nomes.includes('documento'));
});

test('clientes/:id não expõe campo de senha na resposta', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);

    const res = await cliente('/clientes');
    assert.equal(res.status, 200);

    const html = await res.text();
    assert.doesNotMatch(html, /name="senha"/i, 'formulário de cliente não deve ter campo de senha');
});

test('a coluna categoria_id existe em produtos', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const [colunas] = await sequelize.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'produtos'"
    );
    assert.ok(colunas.some((c) => c.column_name === 'categoria_id'));
});

// ---------------------------------------------------------------------------
// Regressões de integridade de dados e de sessão
// ---------------------------------------------------------------------------

test('formulários de cliente abrem em 200', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);

    // Regressão: os controllers de cliente não passavam `body` para a view, e
    // as views leem `body && body.campo`. Sem essa local o EJS resolve o
    // identificador no escopo global e lança ReferenceError -> 500.
    const criar = await cliente('/clientes/new');
    assert.equal(criar.status, 200, `GET /clientes/new devolveu ${criar.status}`);

    const listado = await cliente('/clientes');
    assert.equal(listado.status, 200);
    const id = /\/clientes\/(\d+)\/edit/.exec(await listado.text())?.[1];
    assert.ok(id, 'não encontrei um cliente para editar');

    const editar = await cliente(`/clientes/${id}/edit`);
    assert.equal(editar.status, 200, `GET /clientes/${id}/edit devolveu ${editar.status}`);
});

test('CHECK de estoque impede valor negativo no banco', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await Produto.create({
        nome: 'Produto Para Check', preco_entrega: 10, preco_retirada: 9, embalagem: 'basica',
        peso_kg: 1, estoque: 0,
    });

    // finally: se a rejeição não vier, a linha fica com estoque negativo e
    // quebra a aplicação das migrations seguintes (o CHECK não pode ser
    // adicionado enquanto existirem linhas que o violem).
    try {
        await assert.rejects(
            () => Produto.update({ estoque: -1 }, { where: { id: produto.id } }),
            /estoque/i,
            'o CHECK do banco deveria recusar estoque negativo'
        );

        await produto.reload();
        assert.equal(produto.estoque, 0, 'o valor recusado não pode ter sido gravado');
    } finally {
        await Produto.update({ estoque: 0 }, { where: { id: produto.id } });
        await produto.destroy();
    }
});

test('mesmo produto em duas linhas soma as quantidades contra o estoque', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);
    const csrf = await extrairCsrf(cliente, '/produtos');

    const produto = await Produto.create({
        nome: 'Carvão Teste Agregação', preco_entrega: 10, preco_retirada: 9, embalagem: 'basica',
        peso_kg: 5, estoque: 8,
    });
    const { Cliente } = require('../models');
    const alvo = await Cliente.create({ nome: 'Cli Agreg', email: `agreg${Date.now()}@t.com`, documento: String(Date.now()).slice(-11) });

    // Regressão do estoque negativo: 5 + 5 do mesmo produto contra estoque 8.
    // Validação linha a linha lia o estoque inteiro duas vezes e deixaria -2.
    const res = await cliente('/pedidos', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: {
            _csrf: csrf,
            cliente_id: alvo.id,
            forma_pagamento: 'pix',
            ...ENDERECO_PADRAO,
            'itens[0][produto_id]': produto.id,
            'itens[0][quantidade]': 5,
            'itens[1][produto_id]': produto.id,
            'itens[1][quantidade]': 5,
        },
    });

    assert.equal(res.status, 400, 'a soma 10 > 8 deveria ser recusada');
    assert.match((await res.json()).error, /Estoque insuficiente/);

    await produto.reload();
    assert.equal(produto.estoque, 8, 'nada deveria ter sido baixado');

    await produto.destroy();
    await alvo.destroy();
});

test('pedido válido com produto repetido soma e baixa corretamente', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);
    const csrf = await extrairCsrf(cliente, '/produtos');

    const produto = await Produto.create({
        nome: 'Carvão Teste Soma', preco_entrega: 10, preco_retirada: 9, embalagem: 'basica',
        peso_kg: 5, estoque: 10,
    });
    const { Cliente } = require('../models');
    const alvo = await Cliente.create({ nome: 'Cli Soma', email: `soma${Date.now()}@t.com`, documento: String(Date.now()).slice(-11) });

    const res = await cliente('/pedidos', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: {
            _csrf: csrf,
            cliente_id: alvo.id,
            forma_pagamento: 'pix',
            ...ENDERECO_PADRAO,
            'itens[0][produto_id]': produto.id,
            'itens[0][quantidade]': 4,
            'itens[1][produto_id]': produto.id,
            'itens[1][quantidade]': 6,
        },
    });

    assert.equal(res.status, 201, `esperava 201, veio ${res.status}`);
    const { pedido } = await res.json();

    // 10 unidades a R$ 10,00
    assert.equal(Number(pedido.valor_total), 100, 'o total deve refletir 10 unidades a R$ 10');

    await produto.reload();
    assert.equal(produto.estoque, 0, 'o estoque deveria ter baixado 10 unidades');

    const { Pedido, ItemPedido } = require('../models');
    const itens = await ItemPedido.findAll({ where: { pedido_id: pedido.id } });
    assert.equal(itens.length, 1, 'as duas linhas do mesmo produto viram um item só');
    assert.equal(itens[0].quantidade, 10);

    await Pedido.destroy({ where: { id: pedido.id } });
    await produto.destroy();
    await alvo.destroy();
});

test('rebaixar um admin tira o acesso na sessão já aberta', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { User } = require('../models');
    const alvo = await User.create({
        username: `admin_${Date.now()}`,
        password: bcrypt.hashSync('Senha@123', 10),
        role: 'admin',
    });

    // Sessão separada, autenticada como o admin recém-criado
    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente, { username: alvo.username, password: 'Senha@123' });

    const antes = await cliente('/users');
    assert.equal(antes.status, 200, 'o admin deveria acessar /users antes do rebaixamento');

    // Rebaixa pelo usuário de teste, que é admin
    await User.update({ role: 'user' }, { where: { id: alvo.id } });

    // Regressão de escalada de privilégio: sem reidratar o papel a cada
    // requisição, a sessão guardava role='admin' até o TTL (2h) expirar.
    const depois = await cliente('/users');
    assert.equal(depois.status, 403, 'o admin rebaixado não deveria mais acessar /users');

    await alvo.destroy();
});

test('conta removida derruba a sessão em vez de deixar userId órfão', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { User } = require('../models');
    const alvo = await User.create({
        username: `efemero_${Date.now()}`,
        password: bcrypt.hashSync('Senha@123', 10),
        role: 'user',
    });

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente, { username: alvo.username, password: 'Senha@123' });

    await User.destroy({ where: { id: alvo.id } });

    const res = await cliente('/produtos');
    assert.equal(res.status, 302, 'sessão órfã deveria redirecionar para o login');
    assert.match(res.headers.get('location'), /^\/login/);
});

test('cliente com pedidos não pode ser excluído (RESTRICT no banco)', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { Cliente } = require('../models');
    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);
    const csrf = await extrairCsrf(cliente, '/produtos');

    const alvo = await Cliente.create({
        nome: 'Cliente Com Pedido', email: `cped${Date.now()}@t.com`, documento: String(Date.now()).slice(-11),
    });
    const produto = await Produto.create({ nome: 'P Teste FK', preco_entrega: 10, preco_retirada: 9, embalagem: 'basica', peso_kg: 1, estoque: 5 });

    const criado = await cliente('/pedidos', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: {
            _csrf: csrf,
            cliente_id: alvo.id,
            forma_pagamento: 'pix',
            ...ENDERECO_PADRAO,
            'itens[0][produto_id]': produto.id,
            'itens[0][quantidade]': 1,
        },
    });
    assert.equal(criado.status, 201);

    const res = await cliente(`/clientes/${alvo.id}?_method=DELETE`, {
        method: 'POST',
        headers: { Accept: 'text/html' },
        body: { _csrf: csrf },
    });
    // O controller recusa antes de chegar no banco e devolve o usuário à
    // listagem com a mensagem, em vez de uma página de texto puro.
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/clientes\?erro=/);

    // E o banco também: a FK é RESTRICT desde a 20260930000002
    await assert.rejects(
        () => Cliente.destroy({ where: { id: alvo.id } }),
        // O erro do Postgres é 23001 (restrict_violation), embrulhado em
        // SequelizeDatabaseError — não sai como "foreign key" no nome, e sim
        // na mensagem do erro interno.
        (err) => {
            const codigo = err.original?.code || err.parent?.code;
            return codigo === '23001' || /RESTRICT setting/.test(err.parent?.message || err.message);
        },
        'a FK deveria impedir a exclusão em cascata'
    );

    const { Pedido } = require('../models');
    await Pedido.destroy({ where: { cliente_id: alvo.id } });
    await produto.destroy();
    await alvo.destroy();
});

// ---------------------------------------------------------------------------
// UI web de pedidos (HTML) — mesma rota, mesmo serviço, formato diferente
// ---------------------------------------------------------------------------

// Default em p: chama sem argumento ao usar só o Accept, que é o caso comum
// (GET de página para ler HTML ou extrair o CSRF).
const navegador = (p = {}) => ({ ...p, headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...(p.headers || {}) } });

// Cria os dados mínimos de um pedido e devolve os ids, já com estoque
// suficiente para duas unidades.
const cenarioPedido = async (sufixo) => {
    const { Cliente, Produto, Pedido } = require('../models');
    const produto = await Produto.create({
        nome: `Carvão UI ${sufixo}`, preco_entrega: 12.5, preco_retirada: 10, embalagem: 'basica',
        peso_kg: 5, estoque: 20,
    });
    const alvo = await Cliente.create({
        nome: `Cli UI ${sufixo}`,
        email: `ui${sufixo}@teste.com`,
        documento: String(Date.now()).slice(-11),
    });
    return { produto, cliente: alvo, Pedido };
};

test('/pedidos devolve HTML para o navegador e JSON para a API no mesmo path', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);

    const html = await cliente('/pedidos', navegador({}));
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(await html.text(), /<h1[^>]*>Pedidos<\/h1>/);

    // A API continua answering JSON sem parâmetro novo: é o mesmo contrato.
    const json = await cliente('/pedidos', { headers: { Accept: 'application/json' } });
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type'), /application\/json/);
    assert.ok((await json.json()).pedidos);
});

test('?format=html e ?format=json desempatam quem não manda Accept', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente);

    // curl sem cabeçalho manda */*: a API precisa continuar JSON.
    const padrao = await cliente('/pedidos');
    assert.match(padrao.headers.get('content-type'), /application\/json/);

    const forcado = await cliente('/pedidos?format=html');
    assert.match(forcado.headers.get('content-type'), /text\/html/);

    const forcadoJson = await cliente('/pedidos?format=json');
    assert.match(forcadoJson.headers.get('content-type'), /application\/json/);
});

test('formulário de novo pedido abre com linhas de item e opções carregadas', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('form');

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const res = await nav('/pedidos/new', navegador({}));

        assert.equal(res.status, 200);
        const html = await res.text();

        assert.match(html, /name="cliente_id"/);
        assert.match(html, /name="forma_pagamento"/);
        assert.match(html, /name="item_produto_id\[\]"/);
        assert.match(html, /name="item_quantidade\[\]"/);

        // Linhas fixas, sem JavaScript: 6 selects de produto.
        assert.equal(
            (html.match(/name="item_produto_id\[\]"/g) || []).length,
            require('../controllers/pedidoViewController').LINHAS_ITEM,
            'a view deveria renderizar as linhas fixas do formulário'
        );

        assert.match(html, new RegExp(alvo.nome), 'o cliente cadastrado deve aparecer no select');
        assert.match(html, new RegExp(produto.nome), 'o produto com estoque deve aparecer no select');
    } finally {
        await Pedido.destroy({ where: {} });
        await produto.destroy();
        await alvo.destroy();
    }
});

test('criar pedido pelo formulário baixa o estoque e redireciona para o pedido', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('criar');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const res = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                // 1 linha preenchida + 2 vazias: as vazias não podem virar item.
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '2'],
                ['item_produto_id[]', ''],
                ['item_quantidade[]', ''],
                ['item_produto_id[]', ''],
                ['item_quantidade[]', ''],
                ...ENDERECO_FORM,
            ],
        }));

        // O motivo da recusa entra na mensagem do assert: sem isso, um 400 por
        // campo faltando aparece aqui como um "veio 400" sem pista nenhuma —
        // foi exatamente o que escondeu o endereço ausente do caminho HTML.
        const texto = await res.text();
        const erro = texto.match(/alert alert-danger">([^<]*)/)?.[1] ?? 'sem erro visível';
        assert.equal(res.status, 302, `esperava redirect, veio ${res.status} :: ${erro}`);
        const destino = res.headers.get('location');
        assert.match(destino, /^\/pedidos\/\d+\?msg=criado$/);

        pedidoId = Number(destino.match(/\/pedidos\/(\d+)/)[1]);
        const { ItemPedido } = require('../models');
        const pedido = await Pedido.findByPk(pedidoId, { include: [{ model: ItemPedido }] });
        assert.equal(pedido.status, 'pendente');
        assert.equal(Number(pedido.valor_total), 25, '2 unidades a R$ 12,50');
        assert.equal(pedido.ItemPedidos.length, 1, 'só a linha preenchida vira item');

        await produto.reload();
        assert.equal(produto.estoque, 18, '2 unidades devem ter saído do estoque');
    } finally {
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
        await alvo.destroy();
    }
});

test('mesmo produto em duas linhas do formulário é somado, não duplicado', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('dup');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const res = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'dinheiro'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '3'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '4'],
                ...ENDERECO_FORM,
            ],
        }));

        assert.equal(res.status, 302);
        pedidoId = Number(res.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        const { ItemPedido } = require('../models');
        const itens = await ItemPedido.findAll({ where: { pedido_id: pedidoId } });
        assert.equal(itens.length, 1, 'as duas linhas do mesmo produto viram um item');
        assert.equal(itens[0].quantidade, 7);

        await produto.reload();
        assert.equal(produto.estoque, 13, '3+4 = 7 unidades devem ter saído');
    } finally {
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
        await alvo.destroy();
    }
});

test('estoque insuficiente no formulário volta o form com erro, sem pedido gravado', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('sem-estoque');
    const antes = await Pedido.count();

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const res = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '999'],
                ...ENDERECO_FORM,
            ],
        }));

        // Reexibe o formulário (400) em vez de redirecionar: o usuário não
        // pode perder o que digitou por causa de um erro de estoque.
        assert.equal(res.status, 400);
        const html = await res.text();
        assert.match(html, /alert-danger/);
        assert.match(html, /Estoque insuficiente/);
        assert.equal(await Pedido.count(), antes, 'nenhum pedido pode ter sido criado');
    } finally {
        await produto.destroy();
        await alvo.destroy();
    }
});

test('meia linha preenchida no formulário é recusada', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('meia-linha');
    const antes = await Pedido.count();

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const res = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                // produto sem quantidade: erro em vez de item com 1
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', ''],
                ...ENDERECO_FORM,
            ],
        }));

        assert.equal(res.status, 400);
        assert.match(await res.text(), /quantidade/i);
        assert.equal(await Pedido.count(), antes);
    } finally {
        await produto.destroy();
        await alvo.destroy();
    }
});

test('a página do pedido oferece só as transições válidas do status atual', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('status');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const criado = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
                ...ENDERECO_FORM,
            ],
        }));
        pedidoId = Number(criado.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        // De "pendente" só dá para processando ou cancelado.
        const res = await nav(`/pedidos/${pedidoId}`, navegador({}));
        const html = await res.text();
        assert.equal(res.status, 200);
        assert.match(html, /value="processando"/);
        assert.match(html, /value="cancelado"/);
        assert.doesNotMatch(html, /value="entregue"/, 'entregue não é alcançável a partir de pendente');
    } finally {
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
        await alvo.destroy();
    }
});

test('mudar status pelo formulário usa a mesma regra da API', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('mudar');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const criado = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '5'],
                ...ENDERECO_FORM,
            ],
        }));
        pedidoId = Number(criado.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        // Transição inválida: pendente -> entregue
        const invalido = await nav(`/pedidos/${pedidoId}/status?_method=PUT`, navegador({
            method: 'POST',
            body: { _csrf: csrf, status: 'entregue' },
        }));
        assert.equal(invalido.status, 400);
        assert.match(await invalido.text(), /Transi..o inv.lida/);

        // Transição válida
        const valido = await nav(`/pedidos/${pedidoId}/status?_method=PUT`, navegador({
            method: 'POST',
            body: { _csrf: csrf, status: 'processando' },
        }));
        assert.equal(valido.status, 302);

        const pedido = await Pedido.findByPk(pedidoId);
        assert.equal(pedido.status, 'processando');
    } finally {
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
        await alvo.destroy();
    }
});

test('cancelar pelo formulário devolve o estoque ao produto', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('cancelar');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const criado = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '6'],
                ...ENDERECO_FORM,
            ],
        }));
        pedidoId = Number(criado.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        await produto.reload();
        assert.equal(produto.estoque, 14, '6 unidades saíram do estoque de 20');

        const res = await nav(`/pedidos/${pedidoId}/status?_method=PUT`, navegador({
            method: 'POST',
            body: { _csrf: csrf, status: 'cancelado' },
        }));
        assert.equal(res.status, 302);

        await produto.reload();
        assert.equal(produto.estoque, 20, 'o cancelamento precisa devolver as 6 unidades');
    } finally {
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
        await alvo.destroy();
    }
});

test('excluir pelo formulário devolve o estoque e volta para a lista', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('excluir');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const criado = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '4'],
                ...ENDERECO_FORM,
            ],
        }));
        pedidoId = Number(criado.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        const res = await nav(`/pedidos/${pedidoId}?_method=DELETE`, navegador({
            method: 'POST',
            body: { _csrf: csrf },
        }));

        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), '/pedidos?msg=excluido');
        assert.equal(await Pedido.findByPk(pedidoId), null);

        await produto.reload();
        assert.equal(produto.estoque, 20, 'a exclusão precisa devolver as 4 unidades');
    } finally {
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
        await alvo.destroy();
    }
});

test('filtro de status na listagem sobrevive à paginação', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const nav = criarCliente(baseUrl);
    await fazerLogin(nav);

    const res = await nav('/pedidos?status=entregue&limit=1', navegador({}));
    assert.equal(res.status, 200);
    const html = await res.text();
    // Nenhum pedido entregue existe no cenário; o que importa é o link de
    // página carregar o filtro adiante, senão o usuário pagaria vendo tudo.
    assert.doesNotMatch(html, /href="\/pedidos\?page=\d+&limit=1"/,
        'link de paginação não pode descartar o filtro de status');
});

test('pedido inexistente devolve 404 em HTML', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const nav = criarCliente(baseUrl);
    await fazerLogin(nav);

    const res = await nav('/pedidos/999999', navegador({}));
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /text\/html/);
});

test('relatório de vendas devolve resumo e não inclui pedido cancelado', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('relatorio');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const criado = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '2'],
                ...ENDERECO_FORM,
            ],
        }));
        pedidoId = Number(criado.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        const relatorio = await nav('/pedidos/relatorio/vendas', { headers: { Accept: 'application/json' } });
        assert.equal(relatorio.status, 200, 'o relatório não pode dar 500');
        const corpo = await relatorio.json();
        assert.ok(corpo.resumo, 'faltou o resumo');
        assert.equal(typeof corpo.resumo.total_vendas, 'number');
        assert.ok(corpo.pedidos.some((p) => Number(p.id) === pedidoId), 'o pedido novo deveria estar no relatório');

        // Cancelado não é venda: some do relatório
        await nav(`/pedidos/${pedidoId}/status?_method=PUT`, navegador({
            method: 'POST',
            body: [['_csrf', csrf], ['status', 'cancelado']],
        }));

        const depois = await nav('/pedidos/relatorio/vendas', { headers: { Accept: 'application/json' } });
        const corpoDepois = await depois.json();
        assert.ok(
            !corpoDepois.pedidos.some((p) => Number(p.id) === pedidoId),
            'pedido cancelado não pode aparecer como venda'
        );
    } finally {
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
        await alvo.destroy();
    }
});

test('relatório com período exato filtra por data', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('periodo');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const criado = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
                ...ENDERECO_FORM,
            ],
        }));
        pedidoId = Number(criado.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        // O relatório filtra por dia no fuso LOCAL (utils/periodo). Usar a data
        // UTC aqui quebra após as 21h de Brasília, quando o dia UTC já virou
        // mas o local não. Monta o AAAA-MM-DD a partir dos campos locais.
        const agora = new Date();
        const hoje = [
            agora.getFullYear(),
            String(agora.getMonth() + 1).padStart(2, '0'),
            String(agora.getDate()).padStart(2, '0'),
        ].join('-');
        const dentro = await nav(
            `/pedidos/relatorio/vendas?dataInicio=${hoje}&dataFim=${hoje}`,
            { headers: { Accept: 'application/json' } }
        );
        assert.equal(dentro.status, 200);
        assert.ok((await dentro.json()).pedidos.some((p) => Number(p.id) === pedidoId));

        // Período só com uma das pontas é erro de uso, não 500
        const incompleto = await nav('/pedidos/relatorio/vendas?dataInicio=2020-01-01', {
            headers: { Accept: 'application/json' },
        });
        assert.equal(incompleto.status, 400);
    } finally {
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
        await alvo.destroy();
    }
});

// ---------------------------------------------------------------------------
// Exclusão bloqueada por FK: volta para a listagem com a mensagem, em vez de
// devolver texto puro no meio da interface
// ---------------------------------------------------------------------------

test('excluir cliente com pedidos volta à lista com a mensagem de erro', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('fk-cliente');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const criado = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
                ...ENDERECO_FORM,
            ],
        }));
        pedidoId = Number(criado.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        const res = await nav(`/clientes/${alvo.id}?_method=DELETE`, navegador({
            method: 'POST',
            body: { _csrf: csrf },
        }));

        assert.equal(res.status, 302, 'deveria redirecionar, não responder texto puro');
        const destino = res.headers.get('location');
        assert.match(destino, /^\/clientes\?erro=/);

        // A mensagem diz que é preciso EXCLUIR os pedidos: cancelar não resolve,
        // porque o cancelamento não remove o vínculo com o cliente.
        const aviso = decodeURIComponent(destino.split('erro=')[1]);
        assert.match(aviso, /excluir/i);
        assert.match(aviso, /cancel[aá]?-?l?os? não basta/i);

        // E a listagem mostra a mensagem num alert, escapada
        const lista = await nav(destino, navegador({}));
        assert.equal(lista.status, 200);
        const html = await lista.text();
        assert.match(html, /alert-danger/);
        assert.match(html, /cancel[aá]?-?l?os? não basta/i);
    } finally {
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
        await alvo.destroy();
    }
});

test('admin criando pedido com cliente_id inválido retorna 400 (não 500)', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto } = await cenarioPedido('admin-cliente-invalido');
    const csrf = await extrairCsrf(autenticado, '/pedidos/new');

    try {
        const res = await autenticado('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id[$ne]', '1'],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
                ...ENDERECO_FORM,
            ],
        }));

        assert.equal(res.status, 400, 'cliente_id inválido deve retornar 400');
        const html = await res.text();
        assert.match(html, /cliente/i);
        assert.doesNotMatch(html, /500/);
        assert.doesNotMatch(html, /Erro interno/i);
    } finally {
        await produto.destroy();
    }
});



test('excluir categoria com produtos volta à lista com a mensagem', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const nav = criarCliente(baseUrl);
    await fazerLogin(nav);
    const csrf = await extrairCsrf(nav, '/produtos');

    const { Categoria, Produto } = require('../models');
    const categoria = await Categoria.create({ nome: `Cat ${Date.now()}` });
    const produto = await Produto.create({
        nome: `Prod cat ${Date.now()}`, preco_entrega: 10, preco_retirada: 9, embalagem: 'basica',
        peso_kg: 1, estoque: 5, categoria_id: categoria.id,
    });

    try {
        const res = await nav(`/categorias/${categoria.id}?_method=DELETE`, navegador({
            method: 'POST',
            body: { _csrf: csrf },
        }));

        assert.equal(res.status, 302);
        const destino = res.headers.get('location');
        assert.match(destino, /^\/categorias\?erro=/);
        assert.match(decodeURIComponent(destino.split('erro=')[1]), /produtos vinculados/i);

        const lista = await nav(destino, navegador({}));
        assert.match(await lista.text(), /alert-danger/);
    } finally {
        await produto.destroy();
        await categoria.destroy();
    }
});

test('excluir produto com pedidos volta à lista com a mensagem', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { produto, cliente: alvo, Pedido } = await cenarioPedido('fk-produto');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const criado = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
                ...ENDERECO_FORM,
            ],
        }));
        pedidoId = Number(criado.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        const res = await nav(`/produtos/${produto.id}?_method=DELETE`, navegador({
            method: 'POST',
            body: { _csrf: csrf },
        }));

        assert.equal(res.status, 302);
        assert.match(res.headers.get('location'), /^\/produtos\?erro=/);
        assert.match(decodeURIComponent(res.headers.get('location').split('erro=')[1]), /pedidos registrados/i);
    } finally {
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
        await alvo.destroy();
    }
});

test('a mensagem de erro na query é escapada, não interpretada como HTML', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const nav = criarCliente(baseUrl);
    await fazerLogin(nav);

    // Injeção direta na query: se a view usasse <%- %>, o script entraria no
    // HTML. O <%= %> tem que escapar.
    const res = await nav('/clientes?erro=' + encodeURIComponent('<script>alert(1)</script>'), navegador({}));
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'o HTML não pode conter a tag crua');
    assert.match(html, /&lt;script&gt;/, 'o texto deve aparecer escapado');
});

test('produto com categoria_id inexistente devolve o formulário com erro, não 500', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const nav = criarCliente(baseUrl);
    await fazerLogin(nav);
    const csrf = await extrairCsrf(nav, '/produtos/new');

    // categoria_id que não existe: o banco recusa o INSERT com 23503. A
    // checagem pelo nome da classe Sequel nunca casava, então isso virava 500.
    const res = await nav('/produtos', navegador({
        method: 'POST',
        body: [
            ['_csrf', csrf],
            ['nome', 'Produto sem categoria'],
            ['preco_entrega', '10,00'],
            ['preco_retirada', '9,00'],
            ['embalagem', 'basica'],
            ['peso_kg', '1'],
            ['estoque', '3'],
            ['categoria_id', '999999'],
        ],
    }));

    assert.equal(res.status, 400, `esperava 400, veio ${res.status}`);
    const html = await res.text();
    assert.match(html, /categoria informada não existe/i);
    assert.doesNotMatch(html, /Erro interno/, 'não pode cair na página de 500');
});

test('a guarda de produção reconhece um admin com senha padrão', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    // Mesmo caminho do startup de produção, contra um admin real: o teste do
    // módulo puro não prova que o bcrypt.compare acha o hash do banco.
    const { User } = require('../models');
    const bcrypt = require('bcryptjs');
    const { usaSenhaPadraoConhecida } = require('../utils/credenciais');

    const alvo = await User.create({
        username: `guarda_${Date.now()}`,
        password: await bcrypt.hash('admin123', 4),
        role: 'admin',
    });

    try {
        const recarregado = await User.findByPk(alvo.id);
        assert.equal(await usaSenhaPadraoConhecida(recarregado), true,
            'o startup de produção deveria recusar subir com esta senha');
    } finally {
        await alvo.destroy();
    }
});

test('a guarda de produção não acusa admin com senha trocada', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { User } = require('../models');
    const bcrypt = require('bcryptjs');
    const { usaSenhaPadraoConhecida } = require('../utils/credenciais');

    const alvo = await User.create({
        username: `guarda_ok_${Date.now()}`,
        password: await bcrypt.hash('senha-que-nao-e-a-padrao-123', 4),
        role: 'admin',
    });

    try {
        const recarregado = await User.findByPk(alvo.id);
        assert.equal(await usaSenhaPadraoConhecida(recarregado), false);
    } finally {
        await alvo.destroy();
    }
});

// ---------------------------------------------------------------------------
// Catálogo: dois preços, embalagem e filtros por peso/embalagem
// ---------------------------------------------------------------------------

test('produto novo grava os dois preços e a embalagem', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const nav = criarCliente(baseUrl);
    await fazerLogin(nav);
    const csrf = await extrairCsrf(nav, '/produtos/new');
    const nome = `Bolsa Teste ${Date.now()}`;
    let criado;

    try {
        const res = await nav('/produtos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['nome', nome],
                ['embalagem', 'premium'],
                ['preco_entrega', '21,00'],
                ['preco_retirada', '18,00'],
                ['peso_kg', '5'],
                ['estoque', '10'],
            ],
        }));

        assert.equal(res.status, 302, `esperava redirect, veio ${res.status}`);
        assert.equal(res.headers.get('location'), '/produtos');

        criado = await Produto.findOne({ where: { nome } });
        assert.ok(criado, 'o produto deveria ter sido criado');
        assert.equal(Number(criado.preco_entrega), 21);
        assert.equal(Number(criado.preco_retirada), 18);
        assert.equal(criado.embalagem, 'premium');
    } finally {
        if (criado) await criado.destroy();
    }
});

test('produto com embalagem inválida é recusado com 400, sem gravar', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const nav = criarCliente(baseUrl);
    await fazerLogin(nav);
    const csrf = await extrairCsrf(nav, '/produtos/new');
    const nome = `Bolsa Inválida ${Date.now()}`;

    const res = await nav('/produtos', navegador({
        method: 'POST',
        body: [
            ['_csrf', csrf],
            ['nome', nome],
            ['embalagem', 'xpto'],
            ['preco_entrega', '21,00'],
            ['preco_retirada', '18,00'],
            ['peso_kg', '5'],
            ['estoque', '10'],
        ],
    }));

    assert.equal(res.status, 400);
    assert.match(await res.text(), /embalagem deve ser premium ou basica/i);
    assert.equal(await Produto.count({ where: { nome } }), 0, 'nada pode ter sido gravado');
});

test('listagem de produtos filtra por peso e embalagem', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const suf = Date.now();
    const p5premium = await Produto.create({
        nome: `P5P ${suf}`, preco_entrega: 21, preco_retirada: 18, embalagem: 'premium', peso_kg: 5, estoque: 1,
    });
    const p3premium = await Produto.create({
        nome: `P3P ${suf}`, preco_entrega: 13, preco_retirada: 11, embalagem: 'premium', peso_kg: 3, estoque: 1,
    });
    const p5basica = await Produto.create({
        nome: `P5B ${suf}`, preco_entrega: 16, preco_retirada: 15, embalagem: 'basica', peso_kg: 5, estoque: 1,
    });

    try {
        const res = await autenticado('/produtos?peso_kg=5&embalagem=premium', navegador({}));
        assert.equal(res.status, 200);

        const html = await res.text();
        assert.match(html, new RegExp(`P5P ${suf}`), 'o produto que casa os filtros deve aparecer');
        assert.doesNotMatch(html, new RegExp(`P3P ${suf}`), 'peso diferente não pode aparecer');
        assert.doesNotMatch(html, new RegExp(`P5B ${suf}`), 'embalagem diferente não pode aparecer');
    } finally {
        await Produto.destroy({ where: { id: [p5premium.id, p3premium.id, p5basica.id] } });
    }
});

test('filtro de peso não numérico é recusado com 400', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const res = await autenticado('/produtos?peso_kg=abc', navegador({}));
    assert.equal(res.status, 400);
});

test('formulário de pedido oferece entrega/retirada e os dois preços', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await Produto.create({
        nome: `Bolsa Form ${Date.now()}`, preco_entrega: 21, preco_retirada: 18, embalagem: 'premium', peso_kg: 5, estoque: 5,
    });

    try {
        const res = await autenticado('/pedidos/new', navegador({}));
        assert.equal(res.status, 200);

        const html = await res.text();
        assert.match(html, /name="tipo_entrega"/);
        assert.match(html, /value="retirada"/);
        assert.match(html, new RegExp(produto.nome));
        assert.match(html, /entrega R\$ 21,00/, 'o preço de entrega deve aparecer na opção');
        assert.match(html, /retirada R\$ 18,00/, 'o preço de retirada deve aparecer na opção');
    } finally {
        await produto.destroy();
    }
});

test('pedido de retirada usa o preço de retirada no total', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { Cliente, Pedido, ItemPedido } = require('../models');

    const produto = await Produto.create({
        nome: `Bolsa Retirada ${Date.now()}`, preco_entrega: 21, preco_retirada: 18, embalagem: 'premium', peso_kg: 5, estoque: 10,
    });
    const alvo = await Cliente.create({
        nome: 'Cli Retirada', email: `ret${Date.now()}@t.com`, documento: String(Date.now()).slice(-11),
    });
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const res = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                ['tipo_entrega', 'retirada'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '2'],
                ...ENDERECO_FORM,
            ],
        }));

        assert.equal(res.status, 302, `esperava redirect, veio ${res.status}`);
        pedidoId = Number(res.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        const pedido = await Pedido.findByPk(pedidoId, { include: [{ model: ItemPedido }] });
        assert.equal(pedido.tipo_entrega, 'retirada');
        assert.equal(Number(pedido.valor_total), 36, '2 x R$ 18,00 de retirada');
        assert.equal(Number(pedido.ItemPedidos[0].preco_unitario), 18);

        // A modalidade precisa aparecer na página do pedido, não só no banco.
        const detalhe = await nav(`/pedidos/${pedidoId}`, navegador({}));
        assert.match(await detalhe.text(), /Retirada na empresa/);
    } finally {
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
        await alvo.destroy();
    }
});

test('pedido com tipo_entrega inválido é recusado, sem gravar', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { Cliente, Pedido } = require('../models');

    const produto = await Produto.create({
        nome: `Bolsa Inválida Pedido ${Date.now()}`, preco_entrega: 21, preco_retirada: 18, embalagem: 'basica', peso_kg: 5, estoque: 10,
    });
    const alvo = await Cliente.create({
        nome: 'Cli Inválido', email: `inv${Date.now()}@t.com`, documento: String(Date.now()).slice(-11),
    });
    const antes = await Pedido.count();

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const res = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(alvo.id)],
                ['forma_pagamento', 'pix'],
                ['tipo_entrega', 'xpto'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
                ...ENDERECO_FORM,
            ],
        }));

        assert.equal(res.status, 400);
        assert.match(await res.text(), /Tipo de entrega inválido/);
        assert.equal(await Pedido.count(), antes, 'nenhum pedido pode ter sido criado');
    } finally {
        await produto.destroy();
        await alvo.destroy();
    }
});

// ---------------------------------------------------------------------------
// Papéis: admin x usuário comum
// ---------------------------------------------------------------------------

// Cria um pedido direto no banco (sem passar pela API), para montar cenários de
// dono/prazo sem depender do formulário.
// -----------------------------------------------------------------------------
// Endereco de entrega nos pedidos
// -----------------------------------------------------------------------------
//
// A partir da coluna de endereco, pedido de entrega sem endereco e recusado. Os
// testes que criam pedido pelo FORMULARIO precisam mandar o endereco, entao ele
// vive num spread reutilizado em vez de ser repetido em cada caso.
//
// Dois formatos, porque o codigo le os dois (utils/endereco):
//   - ENDERECO_PADRAO: chaves de coluna, para Pedido.create direto.
//   - ENDERECO_FORM:   pares [nome, valor] para o corpo de um form HTML.
//   - ENDERECO_JSON:   objeto aninhado em `endereco`, para o JSON do carrinho.
const ENDERECO_PADRAO = {
    endereco_cep: '88955-000',
    endereco_logradouro: 'Estrada Geral Palmeira',
    endereco_numero: '123',
    endereco_bairro: 'Interior',
    endereco_cidade: 'Balneario Gaivota',
    endereco_uf: 'SC',
};

const ENDERECO_FORM = Object.entries(ENDERECO_PADRAO).map(([k, v]) => [k, String(v)]);

const ENDERECO_JSON = {
    cep: ENDERECO_PADRAO.endereco_cep,
    logradouro: ENDERECO_PADRAO.endereco_logradouro,
    numero: ENDERECO_PADRAO.endereco_numero,
    bairro: ENDERECO_PADRAO.endereco_bairro,
    cidade: ENDERECO_PADRAO.endereco_cidade,
    uf: ENDERECO_PADRAO.endereco_uf,
};

const criarPedidoDireto = async ({ cliente, produto, quantidade = 1, status = 'pendente', data, tipo = 'entrega', semEndereco = false }) => {
    const { Pedido, ItemPedido } = require('../models');
    const unitario = tipo === 'retirada' ? produto.preco_retirada : produto.preco_entrega;
    const pedido = await Pedido.create({
        cliente_id: cliente.id,
        status,
        data: data || new Date(),
        tipo_entrega: tipo,
        forma_pagamento: 'pix',
        valor_total: Number(unitario) * quantidade,
        // Retirada nao tem endereco; entrega tem. `semEndereco: true` existe para
        // o teste que precisa de um pedido de entrega SEM endereco gravado.
        ...(tipo === 'entrega' && !semEndereco ? ENDERECO_PADRAO : {}),
    });
    if (status !== 'cancelado') {
        await ItemPedido.create({ pedido_id: pedido.id, produto_id: produto.id, quantidade, preco_unitario: unitario });
        await produto.decrement('estoque', { by: quantidade });
    }
    return pedido;
};

const produtoPara = async (sufixo, extras = {}) => {
    const { Produto } = require('../models');
    return Produto.create({
        nome: `Carvão Perm ${sufixo}`,
        preco_entrega: 5,
        preco_retirada: 3,
        embalagem: 'basica',
        peso_kg: 5,
        estoque: 10,
        ...extras,
    });
};

test('usuário comum não acessa cadastros nem gestão de usuários', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const nav = criarCliente(baseUrl);
    await fazerLogin(nav, USUARIO_CLIENTE);

    for (const rota of ['/clientes', '/produtos', '/categorias', '/users']) {
        const res = await nav(rota, navegador({}));
        assert.equal(res.status, 403, `${rota} deveria recusar o usuário comum`);
    }
});

test('admin mantém acesso total (cadastros e relatório)', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    for (const rota of ['/clientes', '/produtos', '/categorias', '/users']) {
        const res = await autenticado(rota, navegador({}));
        assert.equal(res.status, 200, `admin deveria acessar ${rota}`);
    }

    const relatorio = await autenticado('/pedidos/relatorio/vendas', { headers: { Accept: 'application/json' } });
    assert.equal(relatorio.status, 200);
});

test('usuário comum só enxerga os pedidos do próprio cliente', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('vis');
    let meu;
    let alheio;

    try {
        meu = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1 });
        alheio = await criarPedidoDireto({ cliente: outroCliente, produto, quantidade: 1 });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);

        const res = await nav('/pedidos?format=json', { headers: { Accept: 'application/json' } });
        assert.equal(res.status, 200);
        const { pedidos } = await res.json();

        const ids = pedidos.map((p) => p.id);
        assert.ok(ids.includes(meu.id), 'o pedido do próprio cliente deve aparecer');
        assert.ok(!ids.includes(alheio.id), 'o pedido de outro cliente não pode aparecer');
        assert.ok(pedidos.every((p) => p.cliente_id === clienteTeste.id), 'só pedidos do próprio cliente');
    } finally {
        const { Pedido } = require('../models');
        if (meu) await Pedido.destroy({ where: { id: meu.id } });
        if (alheio) await Pedido.destroy({ where: { id: alheio.id } });
        await produto.destroy();
    }
});

test('pedido de outro cliente responde 404 (não 403) para não vazar existência', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('404');
    let alheio;

    try {
        alheio = await criarPedidoDireto({ cliente: outroCliente, produto, quantidade: 1 });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);

        const json = await nav(`/pedidos/${alheio.id}`, { headers: { Accept: 'application/json' } });
        assert.equal(json.status, 404);

        const html = await nav(`/pedidos/${alheio.id}`, navegador({}));
        assert.equal(html.status, 404);

        const form = await nav(`/pedidos/${alheio.id}/edit`, navegador({}));
        assert.equal(form.status, 404);
    } finally {
        const { Pedido } = require('../models');
        if (alheio) await Pedido.destroy({ where: { id: alheio.id } });
        await produto.destroy();
    }
});

test('ao criar pedido, o usuário comum não consegue escolher outro cliente', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('dono');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const res = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                // Tenta forjar o pedido para OUTRO cliente; o servidor deve ignorar.
                ['cliente_id', String(outroCliente.id)],
                ['forma_pagamento', 'pix'],
                // O cliente comum precisa informar o contato do pedido.
                ['contato_nome', clienteTeste.nome],
                ['contato_email', clienteTeste.email],
                ['contato_telefone', '11999990000'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
                ...ENDERECO_FORM,
            ],
        }));

        assert.equal(res.status, 302);
        pedidoId = Number(res.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        const { Pedido } = require('../models');
        const pedido = await Pedido.findByPk(pedidoId);
        assert.equal(pedido.cliente_id, clienteTeste.id, 'o cliente_id do corpo deve ser ignorado');
    } finally {
        const { Pedido } = require('../models');
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
    }
});

test('usuário comum edita o próprio pedido pendente e a modalidade muda o preço', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('edit');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 3 }); // entrega: 3 x 5 = 15
        assert.equal(Number(pedido.valor_total), 15);
        assert.equal(produto.estoque, 7);

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, `/pedidos/${pedido.id}/edit`);

        const res = await nav(`/pedidos/${pedido.id}?_method=PUT`, navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['forma_pagamento', 'dinheiro'],
                ['tipo_entrega', 'retirada'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '2'],
                ...ENDERECO_FORM,
            ],
        }));

        assert.equal(res.status, 302, `esperava redirect, veio ${res.status}`);

        const { ItemPedido } = require('../models');
        await pedido.reload();
        const itens = await ItemPedido.findAll({ where: { pedido_id: pedido.id } });

        assert.equal(Number(pedido.valor_total), 6, 'retirada: 2 x R$ 3,00');
        assert.equal(pedido.tipo_entrega, 'retirada');
        assert.equal(pedido.forma_pagamento, 'dinheiro');
        assert.equal(itens.length, 1);
        assert.equal(Number(itens[0].preco_unitario), 3);

        await produto.reload();
        assert.equal(produto.estoque, 8, 'devolve 3 e baixa 2: 10 - 2');
    } finally {
        const { Pedido, ItemPedido } = require('../models');
        if (pedido) {
            await ItemPedido.destroy({ where: { pedido_id: pedido.id } });
            await Pedido.destroy({ where: { id: pedido.id } });
        }
        await produto.destroy();
    }
});

test('fora do prazo de 3 dias o usuário comum não edita (mas ainda vê)', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('prazo');
    let pedido;
    const quatroDiasAtras = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1, data: quatroDiasAtras });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);

        // Continua visível...
        const show = await nav(`/pedidos/${pedido.id}`, navegador({}));
        assert.equal(show.status, 200);

        // ...mas a tela de edição redireciona com o motivo
        const form = await nav(`/pedidos/${pedido.id}/edit`, navegador({}));
        assert.equal(form.status, 302);
        assert.match(form.headers.get('location'), /erro=/);

        // ...e a API recusa com 403
        const csrf = await extrairCsrf(nav, '/pedidos/new');
        const put = await nav(`/pedidos/${pedido.id}?_method=PUT`, {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: [
                ['_csrf', csrf],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
                ...ENDERECO_FORM,
            ],
        });
        assert.equal(put.status, 403);
    } finally {
        const { Pedido, ItemPedido } = require('../models');
        if (pedido) {
            await ItemPedido.destroy({ where: { pedido_id: pedido.id } });
            await Pedido.destroy({ where: { id: pedido.id } });
        }
        await produto.destroy();
    }
});

// O outro lado da regra: o prazo de 3 dias é do cliente comum, o admin não tem.
//
// Regressão: as duas metades divergiam. utils/permissoes.podeEditarPedido
// devolvia true para o admin sem olhar nada, e a API JSON aceitava a edição
// (prazoObrigatorio: false). Já o motivoBloqueio da tela web cobrava o prazo de
// todo mundo, sem receber o req. O resultado: a tela de detalhe mostrava o botão
// "editar", o clique era recusado com "o prazo de 3 dias encerrou" — e o mesmo
// pedido era aceito pela API. Agora as duas metadas concordam, e o que resta é o
// admin precisar passar pelo mesmo caminho dos outros.
test('admin edita pedido pendente fora do prazo (tela e API concordam)', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('prazo-admin');
    let pedido;

    try {
        pedido = await criarPedidoDireto({
            cliente: clienteTeste,
            produto,
            quantidade: 1,
            data: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
        });

        // A tela de detalhe oferece o botão...
        const show = await autenticado(`/pedidos/${pedido.id}`, navegador({}));
        assert.equal(show.status, 200);
        const html = await show.text();
        assert.match(html, /\/edit/, 'a tela deve oferecer a edição que o admin pode fazer');

        // ...e o formulário abre, em vez de devolver para a listagem
        const form = await autenticado(`/pedidos/${pedido.id}/edit`, navegador({}));
        assert.equal(form.status, 200, `o admin não deve ser barrado pelo prazo; veio ${form.status}`);

        // A tela de detalhe não anuncia bloqueio nenhum
        assert.doesNotMatch(html, /prazo de 3 dias/i);

        // E a edição pelo formulário funciona de verdade
        const csrf = await extrairCsrf(autenticado, '/pedidos/new');
        const put = await autenticado(`/pedidos/${pedido.id}?_method=PUT`, {
            method: 'POST',
            headers: navegador({}).headers,
            body: [
                ['_csrf', csrf],
                ['forma_pagamento', 'boleto'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '2'],
                ...ENDERECO_FORM,
            ],
        });
        assert.equal(put.status, 302, `a edição do admin deveria ser aceita; veio ${put.status}`);

        await pedido.reload();
        assert.equal(pedido.forma_pagamento, 'boleto');
    } finally {
        const { Pedido, ItemPedido } = require('../models');
        if (pedido) {
            await ItemPedido.destroy({ where: { pedido_id: pedido.id } });
            await Pedido.destroy({ where: { id: pedido.id } });
        }
        await produto.destroy();
    }
});

// E o limite que continua valendo para o admin: o prazo afrouxa, o status não.
// Reescrever os itens de um pedido já enviado desfaria a baixa de estoque, então
// nem o admin mexe — e a tela não pode oferecer um botão que seria recusado.
test('admin não edita pedido que já saiu do lugar, e a tela não oferece', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('prazo-admin-status');
    let pedido;

    try {
        pedido = await criarPedidoDireto({
            cliente: clienteTeste,
            produto,
            quantidade: 1,
            status: 'enviado',
            data: new Date(),
        });

        const show = await autenticado(`/pedidos/${pedido.id}`, navegador({}));
        const html = await show.text();
        assert.equal(show.status, 200);
        assert.match(html, /Só pedidos pendentes podem ser alterados/);
        assert.doesNotMatch(html, new RegExp(`/pedidos/${pedido.id}/edit`), 'não pode oferecer editar');

        const form = await autenticado(`/pedidos/${pedido.id}/edit`, navegador({}));
        assert.equal(form.status, 302, 'a tela de edição deve recusar e devolver para o pedido');
        assert.match(form.headers.get('location'), /erro=/);

        // A API recusa com o mesmo motivo
        const csrf = await extrairCsrf(autenticado, '/pedidos/new');
        const put = await autenticado(`/pedidos/${pedido.id}?_method=PUT`, {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: [
                ['_csrf', csrf],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
                ...ENDERECO_FORM,
            ],
        });
        assert.equal(put.status, 403);
    } finally {
        const { Pedido, ItemPedido } = require('../models');
        if (pedido) {
            await ItemPedido.destroy({ where: { pedido_id: pedido.id } });
            await Pedido.destroy({ where: { id: pedido.id } });
        }
        await produto.destroy();
    }
});

test('usuário comum não muda status nem exclui pedido', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('status-acl');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1 });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const status = await nav(`/pedidos/${pedido.id}/status?_method=PUT`, {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: [['_csrf', csrf], ['status', 'processando']],
        });
        assert.equal(status.status, 403);

        const del = await nav(`/pedidos/${pedido.id}?_method=DELETE`, {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: [['_csrf', csrf]],
        });
        assert.equal(del.status, 403);

        // O pedido continua intacto
        await pedido.reload();
        assert.equal(pedido.status, 'pendente');
    } finally {
        const { Pedido, ItemPedido } = require('../models');
        if (pedido) {
            await ItemPedido.destroy({ where: { pedido_id: pedido.id } });
            await Pedido.destroy({ where: { id: pedido.id } });
        }
        await produto.destroy();
    }
});

test('conta user sem cliente vinculado não lista nem cria pedido', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const orfao = await User.create({
        username: `sem_cliente_${Date.now()}`,
        password: bcrypt.hashSync('Senha@123', 10),
        role: 'user',
        cliente_id: null,
    });

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, { username: orfao.username, password: 'Senha@123' });

        const lista = await nav('/pedidos?format=json', { headers: { Accept: 'application/json' } });
        assert.equal(lista.status, 403);

        const csrf = await extrairCsrf(nav, '/pedidos/new');
        const tentativa = await nav('/pedidos', {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: [['_csrf', csrf], ['forma_pagamento', 'pix'], ['item_produto_id[]', '1'], ['item_quantidade[]', '1']],
        });
        assert.equal(tentativa.status, 403);
    } finally {
        await orfao.destroy();
    }
});

test('admin cria usuário comum vinculando um cliente, e sem vínculo é recusado', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    let criado;
    const username = `vinc_${Date.now()}`;

    try {
        const csrf = await extrairCsrf(autenticado, '/users/new');

        // Sem cliente: recusado com a página de criação
        const semCliente = await autenticado('/users', navegador({
            method: 'POST',
            body: [['_csrf', csrf], ['username', username], ['password', 'Senha@123'], ['role', 'user']],
        }));
        assert.equal(semCliente.status, 400);
        assert.match(await semCliente.text(), /cliente/i);
        assert.equal(await User.count({ where: { username } }), 0, 'não deve gravar sem vínculo');

        // Com cliente: criado e vinculado
        const comCliente = await autenticado('/users', navegador({
            method: 'POST',
            body: [['_csrf', csrf], ['username', username], ['password', 'Senha@123'], ['role', 'user'], ['cliente_id', String(clienteTeste.id)]],
        }));
        assert.equal(comCliente.status, 302);

        criado = await User.findOne({ where: { username } });
        assert.equal(criado.cliente_id, clienteTeste.id);
    } finally {
        if (criado) await criado.destroy();
        else await User.destroy({ where: { username } });
    }
});

test('edição de usuário recusa username não escalar com 400, não 500', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const original = `tipos_${Date.now()}`;
    const alvo = await User.create({
        username: original,
        password: bcrypt.hashSync('Senha@123', 10),
        role: 'user',
        cliente_id: clienteTeste.id,
    });

    try {
        const csrf = await extrairCsrf(autenticado, `/users/${alvo.id}/edit`);
        const res = await autenticado(`/users/${alvo.id}?_method=PUT`, {
            method: 'POST',
            body: [['_csrf', csrf], ['username[]', 'x'], ['role', 'user'], ['cliente_id', String(clienteTeste.id)]],
        });

        assert.equal(res.status, 400);
        await alvo.reload();
        assert.equal(alvo.username, original, 'a transação deve ser desfeita sem alterar o usuário');
    } finally {
        await alvo.destroy();
    }
});

test('edições inválidas não vazam conexões do pool', { timeout: 15000 }, async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const original = `pool_${Date.now()}`;
    const alvo = await User.create({
        username: original,
        password: bcrypt.hashSync('Senha@123', 10),
        role: 'user',
        cliente_id: clienteTeste.id,
    });

    try {
        const csrf = await extrairCsrf(autenticado, `/users/${alvo.id}/edit`);

        for (let i = 0; i < 12; i += 1) {
            const invalida = await autenticado(`/users/${alvo.id}?_method=PUT`, {
                method: 'POST',
                body: [['_csrf', csrf], ['username', ''], ['role', 'user'], ['cliente_id', String(clienteTeste.id)]],
            });
            assert.equal(invalida.status, 400);
        }

        const valida = await autenticado(`/users/${alvo.id}?_method=PUT`, {
            method: 'POST',
            body: [['_csrf', csrf], ['username', original], ['role', 'user'], ['cliente_id', String(clienteTeste.id)]],
        });
        assert.equal(valida.status, 302, 'o pool deveria continuar disponível após os erros');
    } finally {
        await alvo.destroy();
    }
});

test('cliente com usuário vinculado não pode ser excluído', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cli = await Cliente.create({
        nome: `Cli Vinculado ${Date.now()}`,
        email: `vinculado_${Date.now()}@teste.com`,
        documento: String(Date.now()).slice(-11),
    });
    const user = await User.create({
        username: `cli_user_${Date.now()}`,
        password: bcrypt.hashSync('Senha@123', 10),
        role: 'user',
        cliente_id: cli.id,
    });

    try {
        const csrf = await extrairCsrf(autenticado, '/clientes');
        const res = await autenticado(`/clientes/${cli.id}?_method=DELETE`, navegador({
            method: 'POST',
            body: [['_csrf', csrf]],
        }));

        assert.equal(res.status, 302);
        assert.match(res.headers.get('location'), /erro=/);
        assert.match(decodeURIComponent(res.headers.get('location')), /usuário/i);
        assert.ok(await Cliente.findByPk(cli.id), 'o cliente deve continuar existindo');
    } finally {
        await user.destroy();
        await cli.destroy();
    }
});

// ---------------------------------------------------------------------------
// Contato do pedido (obrigatório para o cliente comum)
// ---------------------------------------------------------------------------

test('cliente comum só cria pedido informando nome, e-mail e WhatsApp', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { Pedido } = require('../models');
    const produto = await produtoPara('contato');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const itens = [
            ['_csrf', csrf],
            ['forma_pagamento', 'pix'],
            ['item_produto_id[]', String(produto.id)],
            ['item_quantidade[]', '1'],
            ...ENDERECO_FORM,
        ];

        const semContato = await nav('/pedidos', navegador({ method: 'POST', body: itens }));
        assert.equal(semContato.status, 400, 'sem contato o pedido não pode ser criado');
        assert.match(await semContato.text(), /nome, e-mail e WhatsApp/i);

        const contatoIncompleto = await nav('/pedidos', navegador({
            method: 'POST',
            body: [...itens, ['contato_nome', 'Só o nome'], ['contato_email', 'invalido@'], ['contato_telefone', '']],
        }));
        assert.equal(contatoIncompleto.status, 400, 'contato parcial ou com e-mail inválido é recusado');

        assert.equal(await Pedido.count({ where: { cliente_id: clienteTeste.id } }), 0);

        const completo = await nav('/pedidos', navegador({
            method: 'POST',
            body: [
                ...itens,
                ['contato_nome', 'Maria do Contato'],
                ['contato_email', 'maria@exemplo.com.br'],
                ['contato_telefone', '11988887777'],
            ],
        }));

        assert.equal(completo.status, 302);
        pedidoId = Number(completo.headers.get('location').match(/\/pedidos\/(\d+)/)[1]);

        // Snapshot: os dados ficam gravados no pedido, não emprestados do cadastro.
        const pedido = await Pedido.findByPk(pedidoId);
        assert.equal(pedido.contato_nome, 'Maria do Contato');
        assert.equal(pedido.contato_email, 'maria@exemplo.com.br');
        assert.equal(pedido.contato_telefone, '11988887777');
    } finally {
        const { Pedido } = require('../models');
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
    }
});

test('a API de criação também exige contato do cliente comum', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('contato-json');
    let pedidoId;

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, '/pedidos/new');

        const semContato = await nav('/pedidos?format=json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                _csrf: csrf,
                forma_pagamento: 'pix',
                endereco: ENDERECO_JSON,
                itens: [{ produto_id: produto.id, quantidade: 1 }],
            }),
            raw: true,
        });

        assert.equal(semContato.status, 400);
        assert.match(semContato.headers.get('content-type'), /application\/json/);
        assert.match((await semContato.json()).error, /nome, e-mail e WhatsApp/i);

        const comContato = await nav('/pedidos?format=json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                _csrf: csrf,
                forma_pagamento: 'pix',
                // Formato do carrinho da home: { nome, email, telefone }.
                contato: { nome: 'Maria JSON', email: 'maria@exemplo.com.br', telefone: '11988887777' },
                endereco: ENDERECO_JSON,
                itens: [{ produto_id: produto.id, quantidade: 1 }],
            }),
            raw: true,
        });

        assert.equal(comContato.status, 201);
        const { pedido } = await comContato.json();
        pedidoId = pedido.id;
        assert.equal(pedido.contato_email, 'maria@exemplo.com.br');
    } finally {
        const { Pedido } = require('../models');
        if (pedidoId) await Pedido.destroy({ where: { id: pedidoId } });
        await produto.destroy();
    }
});

test('editar itens não apaga o contato já gravado no pedido', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { Pedido } = require('../models');
    const produto = await produtoPara('contato-edit');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1 });
        await pedido.update({
            contato_nome: 'Nome Original',
            contato_email: 'original@exemplo.com.br',
            contato_telefone: '11911112222',
        });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, `/pedidos/${pedido.id}/edit`);

        const res = await nav(`/pedidos/${pedido.id}?_method=PUT`, navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['forma_pagamento', 'dinheiro'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '2'],
                ...ENDERECO_FORM,
            ],
        }));

        assert.equal(res.status, 302);

        const atualizado = await Pedido.findByPk(pedido.id);
        assert.equal(atualizado.contato_nome, 'Nome Original');
        assert.equal(atualizado.contato_email, 'original@exemplo.com.br');
        assert.equal(atualizado.contato_telefone, '11911112222');
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

// ---------------------------------------------------------------------------
// Home do cliente: catálogo em cards + carrinho + "Meus pedidos"
// ---------------------------------------------------------------------------

test('a home do cliente mostra o catálogo, o carrinho e os próprios pedidos', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('catalogo');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1 });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);

        const res = await nav('/', navegador({}));
        assert.equal(res.status, 200);
        const html = await res.text();

        assert.match(html, /id="catalogo"/, 'a aba do catálogo deve existir');
        assert.match(html, /id="meus-pedidos"/, 'a aba de pedidos deve existir');
        assert.match(html, new RegExp(produto.nome), 'o produto com estoque aparece no catálogo');
        assert.match(html, /\/js\/carrinho\.js/, 'o script do carrinho só entra na home do cliente');

        // Contato do carrinho já vem preenchido do cadastro do cliente.
        assert.match(html, new RegExp(clienteTeste.nome));
        assert.match(html, new RegExp(clienteTeste.email));

        // Só os pedidos da própria conta aparecem.
        assert.match(html, new RegExp(`>${pedido.id}<`));
        assert.match(html, /id="carrinho-config"/, 'o carrinho precisa do bloco de configuração');
        assert.match(html, /data-csrf="[0-9a-f]{64}"/, 'o token do carrinho é o mesmo da sessão');
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

test('a home do visitante anônimo não expõe catálogo nem carrinho', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const res = await criarCliente(baseUrl)('/', navegador({}));
    assert.equal(res.status, 200);

    const html = await res.text();
    assert.doesNotMatch(html, /\/js\/carrinho\.js/, 'visitante não recebe o carrinho');
    assert.doesNotMatch(html, /id="catalogo"/, 'visitante não recebe o catálogo');
});

test('produto sem estoque aparece no catálogo marcado como esgotado, sem botão de compra', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    // Antes este teste exigia que o produto NÃO aparecesse. Esconder foi o que
    // fez a bolsa de 5kg premium sumir da tela quando acabou, sem nenhuma pista
    // para o cliente — ele só podia concluir que a loja não vendia aquilo. O
    // comportamento certo é o oposto: mostrar e marcar.
    const esgotado = await produtoPara('sem-estoque', { estoque: 0 });

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);

        const res = await nav('/', navegador({}));
        const html = await res.text();

        assert.match(html, new RegExp(esgotado.nome), 'o produto esgotado deve continuar visível');

        // O card existe, mas não pode ser comprado: sem botão de adicionar e
        // com o selo. O `data-produto-id` é a âncora — ele só existe no botão
        // de adicionar ao carrinho.
        const card = html.slice(html.indexOf(esgotado.nome));
        assert.match(card.slice(0, 1200), /selo-esgotado[^>]*>\s*Esgotado/, 'faltou o selo de esgotado');
        assert.doesNotMatch(
            card.slice(0, 1200),
            new RegExp(`data-produto-id="${esgotado.id}"`),
            'produto esgotado não pode ter botão de adicionar ao carrinho'
        );
    } finally {
        await esgotado.destroy();
    }
});

test('produto com estoque mostra o seletor de quantidade e o card leva à ficha', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('com-seletor', { estoque: 7 });

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);

        const html = await (await nav('/', navegador({}))).text();
        const card = html.slice(html.indexOf(produto.nome));
        const trecho = card.slice(0, 2500);

        // O teto do seletor é o estoque do produto.
        assert.match(trecho, /data-seletor-qtd/, 'o card precisa do seletor de quantidade');
        assert.match(trecho, /max="7"/, 'o seletor precisa respeitar o estoque');
        assert.match(trecho, /Ver detalhes/, 'o card precisa do atalho para a ficha');
        assert.match(trecho, new RegExp(`/catalogo/${produto.id}`), 'o atalho aponta para a ficha');
    } finally {
        await produto.destroy();
    }
});

test('a ficha do produto mostra o seletor e recusa estoque zerado', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const comum = await produtoPara('ficha-comum', { estoque: 12 });
    const zerado = await produtoPara('ficha-zerado', { estoque: 0 });

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);

        const res = await nav(`/catalogo/${comum.id}`, navegador({}));
        assert.equal(res.status, 200);
        const html = await res.text();

        assert.match(html, /data-seletor-qtd/, 'a ficha precisa do seletor');
        assert.match(html, /max="12"/, 'o seletor da ficha precisa respeitar o estoque');
        assert.match(html, /icone-carrinho/, 'a ficha precisa do ícone de carrinho');
        assert.match(html, /id="finalizar-pedido"/, 'a ficha precisa do carrinho para finalizar');

        const fichaZerada = await (await nav(`/catalogo/${zerado.id}`, navegador({}))).text();
        assert.match(fichaZerada, /Produto esgotado/, 'a ficha precisa avisar que acabou');
        assert.doesNotMatch(
            fichaZerada,
            new RegExp(`data-produto-id="${zerado.id}"[^>]*>[^<]*Adicionar`),
            'produto zerado não pode ter botão de adicionar'
        );
    } finally {
        await comum.destroy();
        await zerado.destroy();
    }
});

test('a ficha exige sessão e 404 para produto inexistente', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('ficha-guarda', { estoque: 3 });

    try {
        // Anônimo: recusado antes de qualquer consulta.
        const anonimo = criarCliente(baseUrl);
        const semSessao = await anonimo(`/catalogo/${produto.id}`, navegador({}));
        assert.equal(semSessao.status, 302);
        assert.match(semSessao.headers.get('location'), /\/login/);

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const inexistente = await nav('/catalogo/99999999', navegador({}));
        assert.equal(inexistente.status, 404);
    } finally {
        await produto.destroy();
    }
});

test('id malformado na ficha e no pedido é 400, não 500', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    // Um id que só tem dígitos mas estoura o INTEGER do Postgres passava pela
    // validação de formato e quebrava dentro do banco ("integer out of
    // range"), devolvendo erro interno para uma URL malformada.
    const nav = criarCliente(baseUrl);
    await fazerLogin(nav, USUARIO_CLIENTE);

    for (const id of ['abc', '0', '-1', '99999999999999999999']) {
        const ficha = await nav(`/catalogo/${id}`, navegador({}));
        assert.equal(ficha.status, 400, `/catalogo/${id} deveria dar 400, veio ${ficha.status}`);

        const pedido = await nav(`/pedidos/${id}`, navegador({}));
        assert.equal(pedido.status, 400, `/pedidos/${id} deveria dar 400, veio ${pedido.status}`);
    }
});

// ---------------------------------------------------------------------------
// Meus dados
// ---------------------------------------------------------------------------

test('meus dados atualiza nome, e-mail e telefone sem tocar no documento', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const original = { ...clienteTeste.get() };

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);

        const form = await nav('/meus-dados', navegador({}));
        assert.equal(form.status, 200);

        const csrf = await extrairCsrf(nav, '/meus-dados');

        const res = await nav('/meus-dados?_method=PUT', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['nome', 'Cliente Editado'],
                ['email', 'editado@teste.com'],
                ['telefone', '11955554444'],
            ],
        }));

        assert.equal(res.status, 302);
        assert.match(res.headers.get('location'), /\/meus-dados/);

        const depois = await Cliente.findByPk(clienteTeste.id);
        assert.equal(depois.nome, 'Cliente Editado');
        assert.equal(depois.email, 'editado@teste.com');
        assert.equal(depois.telefone, '11955554444');
        assert.equal(depois.documento, original.documento, 'documento é território do admin');
        assert.equal(depois.tipo, original.tipo, 'tipo é território do admin');
    } finally {
        await Cliente.update(
            { nome: original.nome, email: original.email, telefone: original.telefone },
            { where: { id: clienteTeste.id } }
        );
    }
});

test('meus dados recusa e-mail inválido e mantém o cadastro', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const original = { ...clienteTeste.get() };

    try {
        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, '/meus-dados');

        const res = await nav('/meus-dados?_method=PUT', navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['nome', 'Nome qualquer'],
                ['email', 'nao-e-email'],
            ],
        }));

        assert.equal(res.status, 400);

        const depois = await Cliente.findByPk(clienteTeste.id);
        assert.equal(depois.email, original.email);
    } finally {
        await Cliente.update({ nome: original.nome, email: original.email }, { where: { id: clienteTeste.id } });
    }
});

test('meus dados exige login', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const res = await criarCliente(baseUrl)('/meus-dados', navegador({}));
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/login\?next=/);
});

// ---------------------------------------------------------------------------
// Imagem do produto (multipart)
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

// caminhoPublico começa com /uploads/produtos: dentro do app isso é relativo a
// public/, servido pelo express.static.
const caminhoNoDisco = (caminhoPublico) => path.join(__dirname, '..', 'public', caminhoPublico);

// PNG 1x1 válido: o multer decide a extensão pelo mimetype do arquivo enviado
// pelo browser, e a extensão precisa existir em disco para ser servida.
const PNG_MINIMO = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

const formComImagem = (campos, nomeArquivo = 'foto.png', conteudo = PNG_MINIMO) => {
    const form = new FormData();
    for (const [chave, valor] of campos) form.append(chave, valor);
    form.append('imagem', new Blob([conteudo], { type: 'image/png' }), nomeArquivo);
    return form;
};

const camposDoProduto = (csrf, extras = {}) => [
    ['_csrf', csrf],
    ['nome', extras.nome || `Carvão Foto ${Date.now()}`],
    ['peso_kg', '5'],
    ['preco_entrega', '9.9'],
    ['preco_retirada', '8.8'],
    ['embalagem', 'basica'],
];

// listar tolerante: com o upload atrás do requireAuth, a pasta pode nem existir
// numa instalação que nunca recebeu imagem — e "não existe" já é o estado
// seguro que o teste quer provar.
const listarUploads = () => {
    const dir = path.join(__dirname, '..', 'public', 'uploads', 'produtos');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

// Regressão: o diskStorage do multer grava em disco assim que a requisição
// chega, antes de qualquer handler rodar. Com o upload montado antes do
// requireAuth, um POST anônimo era recusado com 302 e mesmo assim deixava o
// arquivo órfão em public/uploads/produtos: o limpador de
// controllers/produtoSequelizeController nunca executa, porque o controller não
// é alcançado. Repetir o pedido virava escrita em disco por qualquer visitante.
test('POST anônimo em /produtos não deixa arquivo órfão no disco', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const antes = new Set(listarUploads());

    // Visitante comum: sem sessão, sem token CSRF.
    const res = await fetch(`${baseUrl}/produtos`, {
        method: 'POST',
        body: formComImagem([
            ['nome', 'Produto Anônimo'],
            ['peso_kg', '5'],
            ['preco_entrega', '9.9'],
            ['preco_retirada', '8.8'],
            ['embalagem', 'basica'],
        ], 'anonimo.png'),
        redirect: 'manual',
    });

    assert.equal(res.status, 302, 'sem sessão, /produtos deve redirecionar para /login');
    assert.match(res.headers.get('location'), /^\/login\?next=/);

    const orfaos = listarUploads().filter((f) => !antes.has(f));
    assert.deepEqual(orfaos, [], `nada pode ser gravado antes da checagem de sessão; sobrou: ${orfaos.join(', ')}`);
});

// O mesmo pedido, agora com sessão de cliente comum: a sessão passa, mas o
// papel não é admin. O arquivo também não pode sobrar — a recusa é do
// requireRole, e ela vem antes do multer pelo mesmo motivo do teste acima.
test('POST de cliente comum em /produtos não deixa arquivo órfão no disco', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const cliente = criarCliente(baseUrl);
    await fazerLogin(cliente, USUARIO_CLIENTE);

    // O token vem de /meus-dados, não de /produtos/new: a área do catálogo é
    // admin-only de ponta a ponta, então o cliente comum nem abre o formulário
    // (403) — o token tem que vir de uma página que ele de fato alcança.
    const csrf = await extrairCsrf(cliente, '/meus-dados');

    const antes = new Set(listarUploads());

    const res = await cliente('/produtos', {
        method: 'POST',
        body: formComImagem(camposDoProduto(csrf), 'comum.png'),
        raw: true,
    });

    assert.equal(res.status, 403, 'cliente comum não administra o catálogo');

    const orfaos = listarUploads().filter((f) => !antes.has(f));
    assert.deepEqual(orfaos, [], `nada pode ser gravado antes da checagem de papel; sobrou: ${orfaos.join(', ')}`);
});

test('produto com imagem grava o arquivo e o caminho público', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    let produto;

    try {
        const csrf = await extrairCsrf(autenticado, '/produtos/new');

        const res = await autenticado('/produtos', {
            method: 'POST',
            body: formComImagem(camposDoProduto(csrf), 'primeira.png'),
            raw: true,
        });

        assert.equal(res.status, 302, 'o formulário de produto precisa ser multipart');

        produto = await Produto.findOne({ order: [['id', 'DESC']] });
        assert.ok(produto.imagem, 'o produto deve guardar o caminho da imagem');
        assert.match(produto.imagem, /^\/uploads\/produtos\/\d+-[0-9a-z]+\.png$/);
        assert.ok(fs.existsSync(caminhoNoDisco(produto.imagem)), 'o arquivo precisa existir em disco');
    } finally {
        if (produto) {
            const { removerImagem } = require('../middleware/upload');
            await removerImagem(produto.imagem);
            await produto.destroy();
        }
    }
});

test('trocar a imagem remove o arquivo anterior', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    let produto;

    try {
        const csrf = await extrairCsrf(autenticado, '/produtos/new');

        await autenticado('/produtos', {
            method: 'POST',
            body: formComImagem(camposDoProduto(csrf), 'antiga.png'),
            raw: true,
        });
        produto = await Produto.findOne({ order: [['id', 'DESC']] });
        const caminhoAntigo = produto.imagem;
        assert.ok(caminhoAntigo && fs.existsSync(caminhoNoDisco(caminhoAntigo)));

        const res = await autenticado(`/produtos/${produto.id}?_method=PUT`, {
            method: 'POST',
            body: formComImagem([
                ['_csrf', csrf],
                ['nome', produto.nome],
                ['peso_kg', '5'],
                ['preco_entrega', '9.9'],
                ['preco_retirada', '8.8'],
                ['embalagem', 'basica'],
            ], 'nova.png'),
            raw: true,
        });

        assert.equal(res.status, 302);

        const atualizado = await Produto.findByPk(produto.id);
        assert.notEqual(atualizado.imagem, caminhoAntigo);
        assert.ok(fs.existsSync(caminhoNoDisco(atualizado.imagem)), 'a nova imagem precisa existir');
        assert.ok(!fs.existsSync(caminhoNoDisco(caminhoAntigo)), 'a imagem trocada não pode sobrar no disco');
    } finally {
        if (produto) {
            const { removerImagem } = require('../middleware/upload');
            const atual = await Produto.findByPk(produto.id);
            await removerImagem(atual && atual.imagem);
            await produto.destroy();
        }
    }
});

test('excluir produto apaga a imagem do disco', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    let produto;

    try {
        const csrf = await extrairCsrf(autenticado, '/produtos/new');

        await autenticado('/produtos', {
            method: 'POST',
            body: formComImagem(camposDoProduto(csrf), 'excluir.png'),
            raw: true,
        });
        produto = await Produto.findOne({ order: [['id', 'DESC']] });
        const caminho = produto.imagem;
        assert.ok(fs.existsSync(caminhoNoDisco(caminho)));

        const res = await autenticado(`/produtos/${produto.id}?_method=DELETE`, {
            method: 'POST',
            headers: { Accept: 'text/html' },
            body: new URLSearchParams([['_csrf', csrf]]).toString(),
        });

        assert.equal(res.status, 302);
        assert.equal(await Produto.findByPk(produto.id), null);
        assert.ok(!fs.existsSync(caminhoNoDisco(caminho)), 'a imagem não pode sobrar após o DELETE');
        produto = null;
    } finally {
        if (produto) await produto.destroy();
    }
});

// Terceira variante do mesmo problema, e a única que ainda vazava depois das
// duas anteriores: aqui a sessão é de ADMIN e o papel passa, mas o token CSRF
// está errado. O verifyCsrf roda DEPOIS do multer (o token vem no corpo
// multipart, que só o multer sabe ler), então o arquivo já estava gravado
// quando o 403 saía — e o limpador do controller nunca executa, porque o
// controller não é alcançado. Cada tentativa deixava 2 MB em disco.
test('POST de admin com CSRF inválido não deixa arquivo órfão no disco', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const antes = new Set(listarUploads());

    // Sessão válida de admin, token errado. Nada impede este pedido de chegar
    // aqui: token expirado, segundo navegador, ou um formulário reaproveitado.
    const res = await autenticado('/produtos', {
        method: 'POST',
        body: formComImagem([
            ['_csrf', 'token-invalido-de-proposito'],
            ['nome', 'Produto CSRF Inválido'],
            ['peso_kg', '5'],
            ['preco_entrega', '9.9'],
            ['preco_retirada', '8.8'],
            ['embalagem', 'basica'],
        ], 'csrf-invalido.png'),
        raw: true,
    });

    assert.equal(res.status, 403, 'o token errado tem de ser recusado');

    const orfaos = listarUploads().filter((f) => !antes.has(f));
    assert.deepEqual(orfaos, [], `o 403 do CSRF não pode deixar arquivo em disco; sobrou: ${orfaos.join(', ')}`);
});

test('upload inválido devolve 400 e não grava produto', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const antes = await Produto.count();
    const csrf = await extrairCsrf(autenticado, '/produtos/new');

    // Arquivo que não é imagem: recusado pelo filtro de mimetype.
    const form = new FormData();
    for (const [chave, valor] of camposDoProduto(csrf)) form.append(chave, valor);
    form.append('imagem', new Blob([Buffer.from('nao sou imagem')], { type: 'text/plain' }), 'nota.txt');

    const res = await autenticado('/produtos', { method: 'POST', body: form, raw: true });

    assert.equal(res.status, 400);
    assert.equal(await Produto.count(), antes, 'nenhum produto deve ser criado');
});

// ---------------------------------------------------------------------------
// Limites de coluna: 400, não 500
// ---------------------------------------------------------------------------

// Regressão: `Number.isInteger(estoque) && estoque >= 0` passa para
// 3000000000 — é um inteiro perfeito para o JavaScript. O Postgres é que
// recusava ("integer out of range for type integer"), e o erro virava 500.
// utils/limites.js existe para exatamente essa classe de bug e cobria todos os
// outros campos; o estoque era o único INTEGER sem teto.
test('estoque acima do INTEGER devolve 400, não 500', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const antes = await Produto.count();
    const csrf = await extrairCsrf(autenticado, '/produtos/new');

    for (const estoque of ['3000000000', '2147483648']) {
        const res = await autenticado('/produtos', {
            method: 'POST',
            body: camposDoProduto(csrf, { nome: `Estoque ${estoque}` }).concat([['estoque', estoque]]),
        });

        assert.equal(res.status, 400, `estoque=${estoque} deveria ser 400, veio ${res.status}`);
    }

    assert.equal(await Produto.count(), antes, 'nenhum produto deve ser criado');
});

// O total do pedido é preço x quantidade, então multiplica. Com o teto de preço
// e o estoque máximo já aceitos, 101 unidades a 99.999.999,99 estoura a coluna
// DECIMAL(12,2) do total — depois de travar linhas de estoque e dar rollback.
// services/pedidoService confere o total antes do insert.
test('pedido cujo total estoura o DECIMAL devolve 400, não 500', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    // 101 x 99999999.99 = 10.099.999.998,99 > 9999999999.99
    const produto = await Produto.create({
        nome: `Preço Teto ${Date.now()}`,
        preco_entrega: 99999999.99,
        preco_retirada: 99999999.99,
        embalagem: 'basica',
        peso_kg: 5,
        estoque: 500,
    });

    try {
        const antes = await require('../models').Pedido.count();
        const csrf = await extrairCsrf(autenticado, '/pedidos/new');

        const res = await autenticado('/pedidos', {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: [
                ['_csrf', csrf],
                ['cliente_id', String(clienteTeste.id)],
                ['forma_pagamento', 'pix'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '101'],
                ...ENDERECO_FORM,
            ],
        });

        assert.equal(res.status, 400, `total fora da coluna deveria ser 400, veio ${res.status}`);
        assert.equal(await require('../models').Pedido.count(), antes, 'nenhum pedido deve ser criado');
        await produto.reload();
        assert.equal(produto.estoque, 500, 'o estoque não pode ter sido tocado');
    } finally {
        await produto.destroy();
    }
});

// -----------------------------------------------------------------------------
// Cancelamento pelo dono do pedido
// -----------------------------------------------------------------------------

test('cliente cancela o próprio pedido pendente e o estoque volta', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('cancelar-user');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 2 });
        await produto.reload();
        assert.equal(produto.estoque, 8, 'a criação do pedido baixou 2 do estoque 10');

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, '/pedidos/new', navegador());

        const res = await nav(`/pedidos/${pedido.id}/cancelar?_method=PUT`, navegador({
            method: 'POST',
            body: { _csrf: csrf },
        }));

        assert.equal(res.status, 302, `cancelamento deveria redirecionar, veio ${res.status}`);
        assert.match(res.headers.get('location'), new RegExp(`/pedidos/${pedido.id}\\?msg=cancelado$`));

        await pedido.reload();
        assert.equal(pedido.status, 'cancelado');

        await produto.reload();
        assert.equal(produto.estoque, 10, 'cancelar precisa devolver os 2 itens ao estoque');
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

test('cancelar duas vezes não devolve o estoque em duplicidade', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('cancelar-duas-vezes');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 3 });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, '/pedidos/new', navegador());

        const primeiro = await nav(`/pedidos/${pedido.id}/cancelar?_method=PUT`, navegador({
            method: 'POST',
            body: { _csrf: csrf },
        }));
        assert.equal(primeiro.status, 302);

        const segundo = await nav(`/pedidos/${pedido.id}/cancelar?_method=PUT`, navegador({
            method: 'POST',
            body: { _csrf: csrf },
        }));
        // A segunda cai no status, não no prazo: cancelar um cancelado é
        // "não pode mais", e o estoque não pode ser tocado de novo.
        assert.equal(segundo.status, 403);
        assert.match(await segundo.text(), /não pode mais ser cancelado/i);

        await produto.reload();
        assert.equal(produto.estoque, 10, 'o estoque só pode ter voltado uma vez');
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

test('cliente não cancela pedido de outro cliente e não recebe confirmação', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('cancelar-alheio');
    let pedido;

    try {
        const outro = await Cliente.create({
            nome: 'Cli Alheio Cancel',
            email: `alheio${Date.now()}@t.com`,
            documento: String(Date.now()).slice(-11),
        });

        pedido = await criarPedidoDireto({ cliente: outro, produto, quantidade: 1 });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, '/pedidos', navegador());

        const res = await nav(`/pedidos/${pedido.id}/cancelar?_method=PUT`, navegador({
            method: 'POST',
            body: { _csrf: csrf },
        }));

        // 404 e não 403: um 403 confirmaria que o pedido existe.
        assert.equal(res.status, 404);

        await pedido.reload();
        assert.equal(pedido.status, 'pendente', 'o pedido de terceiro não pode ser tocado');

        await produto.reload();
        assert.equal(produto.estoque, 9, 'estoque intacto');

        await pedido.destroy();
        await outro.destroy();
        pedido = null;
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

test('cliente não cancela pedido fora do prazo, mas o admin cancela sem prazo', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('cancelar-prazo');
    const quatroDiasAtras = new Date(Date.now() - 4 * 86400000);
    let doCliente;

    try {
        // Fora do prazo do cliente, pendente: cancelável só pelo admin.
        doCliente = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1, data: quatroDiasAtras });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrfUser = await extrairCsrf(nav, '/pedidos/new', navegador());

        const recusado = await nav(`/pedidos/${doCliente.id}/cancelar?_method=PUT`, navegador({
            method: 'POST',
            body: { _csrf: csrfUser },
        }));
        assert.equal(recusado.status, 403);
        assert.match(await recusado.text(), /prazo para cancelar/i);

        await doCliente.reload();
        assert.equal(doCliente.status, 'pendente');

        // Admin: sem prazo.
        const admin = criarCliente(baseUrl);
        await fazerLogin(admin, USUARIO);
        const csrfAdmin = await extrairCsrf(admin, `/pedidos/${doCliente.id}`, navegador());

        const peloAdmin = await admin(`/pedidos/${doCliente.id}/cancelar?_method=PUT`, navegador({
            method: 'POST',
            body: { _csrf: csrfAdmin },
        }));
        assert.equal(peloAdmin.status, 302, `admin deveria cancelar: ${peloAdmin.status}`);

        await doCliente.reload();
        assert.equal(doCliente.status, 'cancelado');
    } finally {
        if (doCliente) await doCliente.destroy();
        await produto.destroy();
    }
});

test('pedido entregue não é cancelável nem pelo admin, e não mexe no estoque', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('cancelar-entregue');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 2, status: 'entregue' });
        await produto.reload();
        assert.equal(produto.estoque, 8);

        const admin = criarCliente(baseUrl);
        await fazerLogin(admin, USUARIO);
        const csrf = await extrairCsrf(admin, `/pedidos/${pedido.id}`, navegador());

        const res = await admin(`/pedidos/${pedido.id}/cancelar?_method=PUT`, navegador({
            method: 'POST',
            body: { _csrf: csrf },
        }));

        assert.equal(res.status, 403);
        assert.match(await res.text(), /não pode mais ser cancelado/i);

        await pedido.reload();
        assert.equal(pedido.status, 'entregue');

        await produto.reload();
        assert.equal(produto.estoque, 8, 'mercadoria entregue não volta ao estoque');
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

test('a tela do pedido só oferece cancelar quando o cancelamento é aceito', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('cancelar-botao');
    const quatroDiasAtras = new Date(Date.now() - 4 * 86400000);

    try {
        const navUser = criarCliente(baseUrl);
        await fazerLogin(navUser, USUARIO_CLIENTE);

        const dentro = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1 });
        const htmlDentro = await (await navUser(`/pedidos/${dentro.id}`, navegador())).text();
        assert.match(htmlDentro, /\/cancelar\?_method=PUT/, 'pedido no prazo deve oferecer cancelar');

        const velho = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1, data: quatroDiasAtras });
        const htmlVelho = await (await navUser(`/pedidos/${velho.id}`, navegador())).text();
        assert.doesNotMatch(htmlVelho, /\/cancelar\?_method=PUT/, 'fora do prazo não pode oferecer cancelar');

        const { Pedido } = require('../models');
        await Pedido.destroy({ where: { id: [dentro.id, velho.id] } });
    } finally {
        await produto.destroy();
    }
});

test('o botão de cancelar exige CSRF', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('cancelar-csrf');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1 });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);

        const semToken = await nav(`/pedidos/${pedido.id}/cancelar?_method=PUT`, navegador({
            method: 'POST',
            body: {},
        }));

        assert.ok(semToken.status === 403 || semToken.status === 400, `esperava recusa por CSRF, veio ${semToken.status}`);

        await pedido.reload();
        assert.equal(pedido.status, 'pendente', 'sem token o pedido não pode ser cancelado');
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

// -----------------------------------------------------------------------------
// Endereço nos formulários
// -----------------------------------------------------------------------------

test('o formulário de novo pedido traz os campos de endereço', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const nav = criarCliente(baseUrl);
    await fazerLogin(nav, USUARIO);

    const res = await nav('/pedidos/new', navegador());
    const html = await res.text();

    assert.equal(res.status, 200);
    for (const campo of ['endereco_cep', 'endereco_logradouro', 'endereco_numero', 'endereco_bairro', 'endereco_cidade', 'endereco_uf']) {
        assert.match(html, new RegExp(`name="${campo}"`), `falta o campo ${campo}`);
    }
});

test('o formulário de edição abre com o endereço já gravado', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('edit-endereco');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1 });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const res = await nav(`/pedidos/${pedido.id}/edit`, navegador());
        const html = await res.text();

        assert.equal(res.status, 200);
        assert.match(html, /value="88955-000"/, 'o CEP gravado tem de voltar preenchido');
        assert.match(html, /value="Estrada Geral Palmeira"/);
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

test('virar entrega sem endereço algum é recusado, dizendo o que falta', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('sem-endereco');
    let pedido;

    try {
        // Pedido de retirada: por definição, sem endereço gravado.
        pedido = await criarPedidoDireto({
            cliente: clienteTeste, produto, quantidade: 1, tipo: 'retirada', semEndereco: true,
        });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, `/pedidos/${pedido.id}/edit`, navegador());

        // Vira entrega sem mandar endereço: não há nem no corpo nem no pedido,
        // então o serviço tem de recusar em vez de gravar entrega sem destino.
        const res = await nav(`/pedidos/${pedido.id}?_method=PUT`, navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['forma_pagamento', 'pix'],
                ['tipo_entrega', 'entrega'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
            ],
        }));

        assert.equal(res.status, 400);
        assert.match(await res.text(), /endereço de entrega/i);

        await pedido.reload();
        assert.equal(pedido.tipo_entrega, 'retirada', 'recusar não pode gravar a modalidade');
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

test('mudar para retirada limpa o endereço gravado', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('vira-retirada');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1 });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, `/pedidos/${pedido.id}/edit`);

        const res = await nav(`/pedidos/${pedido.id}?_method=PUT`, navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['forma_pagamento', 'pix'],
                ['tipo_entrega', 'retirada'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
            ],
        }));

        assert.equal(res.status, 302);

        await pedido.reload();
        assert.equal(pedido.tipo_entrega, 'retirada');
        assert.equal(pedido.endereco_logradouro, null, 'retirada não guarda endereço');
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

test('a edição sem reenvio de endereço mantém o que já estava gravado', async (t) => {
    if (pular()) return t.skip('banco de testesadisponível');

    const produto = await produtoPara('mantem-endereco');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 1 });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, `/pedidos/${pedido.id}/edit`);

        const res = await nav(`/pedidos/${pedido.id}?_method=PUT`, navegador({
            method: 'POST',
            body: [
                ['_csrf', csrf],
                ['forma_pagamento', 'dinheiro'],
                ['tipo_entrega', 'entrega'],
                ['item_produto_id[]', String(produto.id)],
                ['item_quantidade[]', '1'],
            ],
        }));

        assert.equal(res.status, 302);

        await pedido.reload();
        assert.equal(pedido.forma_pagamento, 'dinheiro');
        assert.equal(pedido.endereco_cidade, 'Balneario Gaivota', 'endereço omitido não pode ser apagado');
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

test('usuário comum não vaza pedido de terceiro pela rota de status em HTML', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const produto = await produtoPara('idor-status');
    let pedido;

    try {
        pedido = await criarPedidoDireto({ cliente: clienteTeste, produto, quantidade: 2 });
        // Marcador único: o endereço da EMPRESA aparece no rodapé de toda
        // página por público, então só o que é do pedido serve de sinal.
        await pedido.update({ contato_nome: 'MARCA-PII-ALHEIA' });

        const nav = criarCliente(baseUrl);
        await fazerLogin(nav, USUARIO_CLIENTE);
        const csrf = await extrairCsrf(nav, '/pedidos/new', navegador());

        // Caminho HTML de uma rota restrita ao admin. A falha do exigirAdmin
        // caía no catch que reexibia o pedido: status 403, mas com o corpo
        // contendo os dados do pedido alheio e o bloco de administração.
        const res = await nav(`/pedidos/${pedido.id}/status?_method=PUT`, navegador({
            method: 'POST',
            body: { _csrf: csrf, status: 'entregue' },
        }));

        const corpo = await res.text();

        assert.equal(res.status, 403);
        assert.doesNotMatch(corpo, /MARCA-PII-ALHEIA/, 'contato do pedido de terceiro vazou');
        assert.doesNotMatch(corpo, new RegExp(`Pedido #${pedido.id}`), 'pedido de terceiro renderizado');
        assert.doesNotMatch(corpo, /Acesso restrito a administradores[\s\S]*Pedido #/, 'a página de erro não pode conter o pedido');
        // A resposta tem de ser a página de recusa, não a ficha do pedido.
        assert.match(corpo, /403 - Acesso negado/);

        // E nada pode ter mudado.
        await pedido.reload();
        assert.equal(pedido.status, 'pendente');
    } finally {
        const { Pedido } = require('../models');
        if (pedido) await Pedido.destroy({ where: { id: pedido.id } });
        await produto.destroy();
    }
});

// ---------------------------------------------------------------------------
// Rate limit persistido e freio por conta
// ---------------------------------------------------------------------------

test('contadores de rate limit sobrevivem a um novo store, e rotas não se misturam', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { criarStore } = require('../middleware/rateLimitStore');

    // store novo = "processo novo". Com MemoryStore o contador voltaria a zero
    // e o limite seria renovado de graça a cada deploy.
    const antes = criarStore('login');
    await antes.increment('203.0.113.7');
    await antes.increment('203.0.113.7');

    const depois = criarStore('login');
    const total = await depois.increment('203.0.113.7');

    assert.equal(total.totalHits, 3, 'o contador deveria vir do banco, não da memória');

    // Mesmo IP em outra rota precisa de outra linha, senão esgota o login de
    // quem só está se cadastrando.
    const cadastro = criarStore('cadastro');
    const outro = await cadastro.increment('203.0.113.7');
    assert.equal(outro.totalHits, 1, 'cadastro e login não podem compartilhar contador');

    await antes.resetAll();
    await depois.resetAll();
    await cadastro.resetAll();
});

test('janela vencida recomeça a contagem E renova o prazo', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const { criarStore } = require('../middleware/rateLimitStore');
    const store = criarStore('janela');

    await store.increment('198.51.100.9');
    await store.increment('198.51.100.9');

    // Encurta a janela no banco em vez de esperar 15 minutos.
    await sequelize.query(
        `UPDATE rate_limit SET reset_at = NOW() - interval '1 second' WHERE chave LIKE 'janela:%'`
    );

    const depois = await store.increment('198.51.100.9');
    assert.equal(depois.totalHits, 1, 'janela vencida deve recomeçar em 1');

    // A renewal precisa mover reset_at para frente. Sem isso o totalHits voltaria
    // a 1 para sempre e o rate limit ficaria desligado sem teste reprovar.
    const [linhas] = await sequelize.query(
        `SELECT reset_at FROM rate_limit WHERE chave = 'janela:198.51.100.9'`
    );
    assert.ok(
        linhas[0].reset_at.getTime() > Date.now() - 1000,
        'a janela vencida precisa ser renovada para o futuro, senão o limite nunca conta'
    );

    await store.resetAll();
});

test('freio por conta bloqueia após muitas falhas, e login certo limpa', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const throttleConta = require('../utils/throttleConta');
    const original = process.env.LOGIN_CONTA_RATE_LIMIT;
    process.env.LOGIN_CONTA_RATE_LIMIT = '3';

    try {
        // Chave por hash: a tabela de rate limit não pode virar um dicionário de
        // "quais nomes de usuário existem aqui".
        const chave = throttleConta.chaveDe('vitima');
        assert.ok(chave.startsWith('conta:'));
        assert.ok(!chave.includes('vitima'), 'o username não pode ir para o banco em texto puro');
        assert.equal(chave, throttleConta.chaveDe(' VITIMA '), 'normalizar evita contadores paralelos');

        let estado;
        for (let i = 0; i < 4; i += 1) estado = await throttleConta.registrarFalha('vitima');

        assert.equal(estado.total, 4);
        assert.equal(estado.limite, 3);
        assert.equal(estado.bloqueado, true);

        await throttleConta.limpar('vitima');
        const depois = await throttleConta.registrarFalha('vitima');
        assert.equal(depois.total, 1, 'login bem-sucedido precisa zerar o histórico');
        assert.equal(depois.bloqueado, false);

        await throttleConta.limpar('vitima');
    } finally {
        if (original === undefined) delete process.env.LOGIN_CONTA_RATE_LIMIT;
        else process.env.LOGIN_CONTA_RATE_LIMIT = original;
    }
});

test('conta trancada recusa login mesmo com a senha correta', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const throttleConta = require('../utils/throttleConta');
    const original = process.env.LOGIN_CONTA_RATE_LIMIT;
    process.env.LOGIN_CONTA_RATE_LIMIT = '2';

    try {
        const username = `presa_${Date.now()}`;
        await User.create({
            username,
            password: bcrypt.hashSync('Senha@123', 10),
            role: 'user',
            cliente_id: clienteTeste.id,
        });

        const nav = criarCliente(baseUrl);
        const tentar = async (password) => {
            const csrf = await extrairCsrf(nav, '/login');
            await nav('/login', {
                method: 'POST',
                body: { username, password, _csrf: csrf },
            });
        };

        await tentar('errada');
        await tentar('errada');

        // O ponto do teste: a SENHA ESTÁ CORRETA. Se o freio fosse decorativo
        // (só mudando a mensagem depois do bcrypt), este login entraria.
        await tentar('Senha@123');

        const res = await nav('/produtos', { redirect: 'manual' });
        assert.equal(res.status, 302, 'conta trancada não pode autenticar');
        // O destino volta para /login com o next que a rota protegida montou;
        // o que importa é não ser a própria rota protegida (200).
        assert.match(res.headers.get('location'), /^\/login/);

        // A mensagem de bloqueio não pode conviver com a de senha inválida:
        // isso mostraria que a conta existe.
        const corpo = await nav('/login').then((r) => r.text());
        assert.match(corpo, /Muitas tentativas para esta conta/);
        assert.doesNotMatch(corpo, /Usuário ou senha inválidos/);

        // Passada a janela, a conta volta a entrar. Simula zerando o contador,
        // com o usuário ainda no banco: destruí-lo antes faria o login falhar
        // por outro motivo e a asserção não provaria nada.
        await throttleConta.limpar(username);
        await tentar('Senha@123');
        // /produtos é área admin: um cliente comum que entrou leva 403, não 302
        // para /login. O 403 é a prova de que a sessão foi criada; o 302 seria o
        // estado de "continua anônimo" que o teste precisa detectar.
        const depois = await nav('/produtos', { redirect: 'manual' });
        assert.notEqual(depois.status, 302, 'com o contador zerado, o login passa');
        assert.equal(depois.status, 403, 'sessão criada: 403 de papel, não redirecionamento');

        await User.destroy({ where: { username } });
    } finally {
        if (original === undefined) delete process.env.LOGIN_CONTA_RATE_LIMIT;
        else process.env.LOGIN_CONTA_RATE_LIMIT = original;
    }
});

test('conta inexistente responde igual à existente, sem virar oráculo', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const throttleConta = require('../utils/throttleConta');
    const original = process.env.LOGIN_CONTA_RATE_LIMIT;
    process.env.LOGIN_CONTA_RATE_LIMIT = '2';

    try {
        // Nomes que não existem no banco. O contador sobe para eles igual
        // (senão a diferença de resposta revelaria quais contas existem).
        const fantasma = `fantasma_${Date.now()}`;

        const nav = criarCliente(baseUrl);
        for (let i = 0; i < 2; i += 1) {
            const csrf = await extrairCsrf(nav, '/login');
            await nav('/login', {
                method: 'POST',
                body: { username: fantasma, password: 'errada', _csrf: csrf },
            });
        }

        const csrf = await extrairCsrf(nav, '/login');
        await nav('/login', {
            method: 'POST',
            body: { username: fantasma, password: 'Senha@123', _csrf: csrf },
        });

        const corpo = await nav('/login').then((r) => r.text());
        assert.match(corpo, /Muitas tentativas para esta conta/, 'conta inexistente tranca igual');
        assert.doesNotMatch(corpo, /Usuário ou senha inválidos/);

        await throttleConta.limpar(fantasma);
    } finally {
        if (original === undefined) delete process.env.LOGIN_CONTA_RATE_LIMIT;
        else process.env.LOGIN_CONTA_RATE_LIMIT = original;
    }
});

test('login responde bloqueio por conta depois de N falhas, mesmo variando o IP', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    const throttleConta = require('../utils/throttleConta');
    const original = process.env.LOGIN_CONTA_RATE_LIMIT;
    process.env.LOGIN_CONTA_RATE_LIMIT = '2';

    try {
        // Username novo a cada rodada para não colidir com o contador de outro
        // teste.
        const username = `alvo_${Date.now()}`;

        // Insere o usuário direto: o caminho que importa é o POST /login.
        await User.create({
            username,
            password: bcrypt.hashSync('Senha@123', 10),
            role: 'user',
            cliente_id: clienteTeste.id,
        });

        const tentarSenhaErrada = async () => {
            const nav = criarCliente(baseUrl);
            const csrf = await extrairCsrf(nav, '/login');
            await nav('/login', {
                method: 'POST',
                body: { username, password: 'senha-errada', _csrf: csrf },
            });
            return nav;
        };

        await tentarSenhaErrada();
        await tentarSenhaErrada();

        // Terceira tentativa: o contador estourou, mas a senha está errada de
        // propósito — o que interessa é a mensagem.
        const nav = await tentarSenhaErrada();
        const res = await nav('/login');
        const corpo = await res.text();

        assert.match(corpo, /Muitas tentativas para esta conta/);
        assert.doesNotMatch(corpo, /Usuário ou senha inválidos/);

        await throttleConta.limpar(username);
        await User.destroy({ where: { username } });
    } finally {
        if (original === undefined) delete process.env.LOGIN_CONTA_RATE_LIMIT;
        else process.env.LOGIN_CONTA_RATE_LIMIT = original;
    }
});

test('/health responde fora do limite global e não cai com o store quebrado', async (t) => {
    if (pular()) return t.skip('banco de testes indisponível');

    // O limitador global está montado DEPOIS de /health. Se a ordem virar, uma
    // sonda de liveness a cada 10s cruza o limite de 100/15min do próprio IP e o
    // orquestrador reinicia um serviço saudável.
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', database: 'up' });

    // Store quebrado (migration esquecida, banco instável) não pode virar 500
    // geral: passOnStoreError degrada a proteção em vez de derrubar o serviço.
    const rateLimitStore = require('../middleware/rateLimitStore');
    const original = rateLimitStore.criarStore;
    const dbOriginal = require('../config/db').sequelize.query;

    try {
        // Substitui o store global por um que sempre falha, recriando o app.
        const fake = () => ({
            localKeys: false,
            init() {},
            increment: () => Promise.reject(new Error('relation "rate_limit" does not exist')),
            decrement: () => Promise.reject(new Error('relation "rate_limit" does not exist')),
            resetKey: () => Promise.resolve(),
            resetAll: () => Promise.resolve(),
        });

        rateLimitStore.criarStore = fake;
        Object.keys(require.cache)
            .filter((k) => k.includes(`${'/'}app.js`) || k.endsWith(`${'/'}routes/authRoutes.js`))
            .forEach((k) => delete require.cache[k]);

        const appQuebrado = require('../app');

        const quebrado = await new Promise((resolve) => {
            const s = appQuebrado.listen(0, () => {
                const base = `http://127.0.0.1:${s.address().port}`;
                (async () => {
                    const login = await fetch(`${base}/login`, { redirect: 'manual' });
                    const health = await fetch(`${base}/health`);
                    s.close();
                    resolve({ login: login.status, health: health.status });
                })();
            });
        });

        assert.notEqual(quebrado.login, 500, 'login não pode virar 500 por falha do store');
        assert.equal(quebrado.health, 200, '/health não depende do store de rate limit');
    } finally {
        rateLimitStore.criarStore = original;
        require('../config/db').sequelize.query = dbOriginal;
        Object.keys(require.cache)
            .filter((k) => k.endsWith(`${'/'}app.js`) || k.endsWith(`${'/'}routes/authRoutes.js`))
            .forEach((k) => delete require.cache[k]);
    }
});
