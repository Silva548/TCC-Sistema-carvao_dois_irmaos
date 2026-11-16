// dotenv primeiro: o guard de banco logo abaixo lê DB_NAME_TEST, e este arquivo
// roda em processo próprio (node --test isola arquivos), sem herdar nada de quem
// o iniciou.
require('dotenv').config();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..', '..');

// `app.js` decide `trust proxy` no momento do require, lendo o ambiente, e tem
// efeito colateral ao ser carregado (dotenv, pools do Sequelize, store de
// sessão, limites de taxa). Exercitar a decisão no próprio processo exigiria
// recarregar o módulo e contaminar a suíte. Um processo filho por caso é o
// isolamento mais barato que prova a configuração real como o servidor a vê.
//
// Regressão de segurança: a versão anterior ligava `trust proxy` também só por
// NODE_ENV=production. Sem proxy real na frente, o Express passa a confiar no
// X-Forwarded-For que o cliente envia, e um header novo por requisição dá um IP
// novo ao express-rate-limit — o limite de login virava decorativo.
// Sem `app.set('trust proxy', ...)`, o Express devolve o padrão `false` (não
// `undefined`). O que importa para a segurança é se o app está ou não confiando
// no X-Forwarded-For, então o teste compara o valor cru e decide por falsidade.
const CODECO_CONFIG = "const app = require('./app');process.stdout.write(JSON.stringify(app.get('trust proxy') ?? null));";

// Ambiente com TRUST_PROXY removido de propósito: o caso que importa é a
// variável *ausente*, e passá-la como string vazia testaria outra coisa.
// Este teste carrega config/db.js num processo filho e escreve nele (zerando
// contadores de rate limit). Sem redirecionar DB_NAME, ele escreveria no banco
// de DESENVOLVIMENTO — apagando os contadores de quem está trabalhando — e
// colidiria com a suíte de integração, que roda em paralelo. Mesmo esquema do
// guard de tests/integration.test.js.
const ambiente = (extra) => {
    const env = { ...process.env, ...extra };
    delete env.TRUST_PROXY;

    if (process.env.DB_NAME_TEST) {
        env.DB_NAME = process.env.DB_NAME_TEST;
    }

    return env;
};

const rodar = (codigo, env) =>
    execFileSync(process.execPath, ['-e', codigo], {
        cwd: RAIZ,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
    });

const trustProxyEm = (env) => JSON.parse(rodar(CODECO_CONFIG, env));

test('produção sem proxy declarado NÃO liga trust proxy', () => {
    // O teste central: era exatamente este caso que ligava por engano.
    assert.ok(
        !trustProxyEm(ambiente({ NODE_ENV: 'production' })),
        'produção não deve implicar que existe proxy reverso na frente'
    );
});

test('produção liga trust proxy quando TRUST_PROXY=true é declarado', () => {
    assert.equal(
        trustProxyEm({ ...process.env, NODE_ENV: 'production', TRUST_PROXY: 'true' }),
        1
    );
});

test('desenvolvimento nunca liga trust proxy', () => {
    assert.ok(!trustProxyEm(ambiente({ NODE_ENV: 'development' })));
});

test('TRUST_PROXY com valor diferente de "true" não liga', () => {
    // '1', 'sim' e 'false' são erros de digitação plausíveis; o valor precisa
    // ser a string exata para o proxy ser considerado.
    for (const valor of ['1', 'sim', 'false', 'TRUE', 'True']) {
        assert.ok(
            !trustProxyEm({ ...process.env, NODE_ENV: 'production', TRUST_PROXY: valor }),
            `TRUST_PROXY="${valor}" não deveria ligar trust proxy`
        );
    }
});

// A propriedade de segurança, e não só o valor de configuração: com trust proxy
// desligado, forjar X-Forwarded-For não pode dar um IP novo ao limitador.
//
// Roda em NODE_ENV=development porque o teste fala HTTP puro, e em produção o
// cookie de sessão é `secure` (app.js) — o express-session não devolve
// Set-Cookie fora de HTTPS, então não haveria sessão para percorrer o login.
// A decisão de trust proxy é independente de NODE_ENV (é o que os testes acima
// provam, inclusive para produção); aqui o que se exercita é a consequência:
// com o proxy desligado, o limitador conta pelo endereço real do socket.
test('X-Forwarded-For forjado não escapa do limite de login', () => {
    const env = ambiente({
        NODE_ENV: 'development',
        LOGIN_RATE_LIMIT: '2',
        RATE_LIMIT_MAX: '1000',
    });

    // Os limitadores agora persistem no Postgres, então o contador deste teste
    // sobrevive entre execuções: sem zerar, as 6 tentativas de hoje somam às 6
    // de ontem e o limite estoura já na primeira. Por isso o teste limpa o
    // que ele próprio usa, em vez de depender da ordem de execução da suíte.
    const codigo = `
        const app = require('./app');
        (async () => {
            const { criarStore } = require('./middleware/rateLimitStore');
            const throttleConta = require('./utils/throttleConta');
            const limpadas = ['login', 'global'].map((p) => criarStore(p).resetAll());
            limpadas.push(throttleConta.limpar('alvo'));
            await Promise.all(limpadas);

            const server = app.listen(0);
            await new Promise((r) => server.once('listening', r));
            const base = 'http://127.0.0.1:' + server.address().port;

            const page = await fetch(base + '/login');
            const html = await page.text();
            const csrf = (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
            const cookie = (page.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

            let bloqueados = 0;
            for (let i = 0; i < 6; i++) {
                const r = await fetch(base + '/login', {
                    method: 'POST',
                    redirect: 'manual',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        // IP novo a cada tentativa: com trust proxy ligado, o
                        // limitador contornava tudo e nada era barrado.
                        'X-Forwarded-For': '203.0.113.' + i,
                        Cookie: cookie,
                    },
                    body: new URLSearchParams({
                        username: 'alvo',
                        password: 'senha-errada',
                        _csrf: csrf,
                    }).toString(),
                });
                const alvo = r.headers.get('location') || '';
                const corpo = await r.text();
                if (r.status === 429 || /Muitas/.test(alvo + corpo)) bloqueados++;
            }

            await Promise.all(limpadas);
            process.stdout.write(JSON.stringify({ bloqueados, confia: app.get('trust proxy') ?? null }));
            server.close();
            process.exit(0);
        })();
    `;

    const { bloqueados, confia } = JSON.parse(rodar(codigo, env));

    assert.ok(!confia, 'o app não deveria estar confiando em X-Forwarded-For');

    // "Pelo menos 4" e não "exatamente 4": este teste roda no banco de testes,
    // em paralelo com a suíte de integração, e ambas as requisições vêm de
    // 127.0.0.1. O tráfego da outra suíte já consumiu parte da janela, então o
    // número exato varia. O limite inferior é o que prova a propriedade: com o
    // X-Forwarded-For confiado, cada tentativa viraria um IP distinto e NENHUMA
    // seria barrada (0 < 4), porque o limite de 2 jamais seria atingido.
    assert.ok(
        bloqueados >= 4,
        `com limite 2, ao menos 4 das 6 tentativas deveriam ser barradas; foram ${bloqueados}`
    );
});
