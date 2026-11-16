// Store de rate limit persistido no PostgreSQL, no lugar do MemoryStore padrão.
//
// Dois problemas que o MemoryStore deixa abertos:
//
// 1. Um restart do processo zera todas as janelas. Com windowMs de 15 minutos,
//    reiniciar o servidor passa a valer como "renovar o limite".
// 2. Com mais de uma instância (dois containers, um deploy durante o outro),
//    cada processo conta os mesmos clientes por conta própria: o limite efetivo
//    é multiplicado pelo número de réplicas.
//
// Guardar o contador no banco resolve os dois, e reaproveita a infraestrutura
// que já existe (Postgres e pool) sem introduzir Redis.
//
// A chave chega prefixada pelo chamador, não pela lib: o express-rate-limit
// passa a chave crua para increment() e só usa store.prefix na checagem de
// double-count. Por isso cada limitador recebe seu próprio prefixo, e é ele que
// impede "login:1.2.3.4" e "cadastro:1.2.3.4" de colidirem na mesma linha.

const { sequelize } = require('../config/db');

// Só usado pelo ler() para calcular o resetAt de uma chave que ainda não existe
// (o chamador quer um prazo, não um histórico).
const JANELA_PADRAO_MS = 15 * 60 * 1000;

// Instância por limitador: a lib recusa reutilizar a mesma Store entre dois
// middlewares (unsharedStore), e o prefixo precisa differir por rota de qualquer
// forma.
// Upsert compartilhado: faz o incremento e zera a janela vencida em um único
// statement, sem read-then-write (que abriria corrida entre requisições
// paralelas do mesmo cliente). O ON CONFLICT só reinicia a contagem quando a
// janela anterior já expirou; caso contrário só soma. Usado tanto pelo
// increment() do middleware quanto pelo contar() do throttleConta — antes os
// dois tinham cópias idênticas do SQL, que podiam divergir em silêncio.
const upsertContagem = async (chave, janelaMs) => {
    const [resultados] = await sequelize.query(
        `INSERT INTO rate_limit (chave, total_hits, reset_at, created_at, updated_at)
         VALUES (:chave, 1, NOW() + (:janela || ' milliseconds')::interval, NOW(), NOW())
         ON CONFLICT (chave) DO UPDATE SET
             total_hits = CASE
                 WHEN rate_limit.reset_at <= NOW() THEN 1
                 ELSE rate_limit.total_hits + 1
             END,
             reset_at = CASE
                 WHEN rate_limit.reset_at <= NOW()
                     THEN NOW() + (:janela || ' milliseconds')::interval
                 ELSE rate_limit.reset_at
             END,
             updated_at = NOW()
         RETURNING total_hits, reset_at`,
        { replacements: { chave, janela: String(janelaMs) } },
    );

    return resultados[0];
};

class RateLimitPostgresStore {
    constructor(prefixo) {
        this.prefix = prefixo;
        // O banco é compartilhado entre processos, então as chaves deste store
        // podem colidir com as de outra instância. Declarar localKeys = false
        // desliga as validações que assumiriam o contrário.
        this.localKeys = false;
        this.windowMs = 15 * 60 * 1000;
    }

    init(options) {
        if (options && options.windowMs) {
            this.windowMs = options.windowMs;
        }
    }

    chaveDe(key) {
        return `${this.prefix}:${key}`;
    }

    async increment(key) {
        const linha = await upsertContagem(this.chaveDe(key), this.windowMs);
        return { totalHits: linha.total_hits, resetTime: new Date(linha.reset_at) };
    }

    async decrement(key) {
        // Usado pelo skipSuccessfulRequests: o voto do request não deve contar.
        await sequelize.query(
            `UPDATE rate_limit
                SET total_hits = GREATEST(total_hits - 1, 0), updated_at = NOW()
              WHERE chave = :chave`,
            { replacements: { chave: this.chaveDe(key) } },
        );
    }

    async resetKey(key) {
        await sequelize.query(
            'DELETE FROM rate_limit WHERE chave = :chave',
            { replacements: { chave: this.chaveDe(key) } },
        );
    }

    async resetAll() {
        // Um DELETE por prefixo usando LIKE: as chaves do limitador são geradas
        // por ipKeyGenerator e contêm pontuação, mas não '%' nem '_', então o
        // prefixo literal funciona como está. Só as linhas deste limitador: o
        // reset de um não pode liberar outro.
        await sequelize.query(
            `DELETE FROM rate_limit WHERE chave LIKE :prefixo`,
            { replacements: { prefixo: `${this.prefix}:%` } },
        );
    }
}

const limparExpirados = () =>
    sequelize.query('DELETE FROM rate_limit WHERE reset_at <= NOW()');

// Limpeza periódica. Roda de hora em hora numa única instância com unref: não
// segura o event loop (não impede o processo de encerrar) e o custo é um index
// scan sobre idx_rate_limit_reset_at, sem concorrência entre processos.
//
// Se um processo morrer logo após o unref, a limpeza simply acontece no
// processo seguinte — a tabela é acumulativa por natureza, então perder uma
// rodada só adia a remoção de linhas já sem efeito no limite.
let timerLimpeza = null;

const iniciarLimpeza = (intervaloMs) => {
    if (timerLimpeza) return;
    timerLimpeza = setInterval(() => {
        limparExpirados().catch((err) =>
            console.warn('[rate-limit] falha na limpeza:', err.message));
    }, intervaloMs);
    timerLimpeza.unref?.();
};

// Store + limpeza, em um único ponto de uso.
const criarStore = (prefixo, { janelaMs, limparAposMs = 60 * 60 * 1000 } = {}) => {
    const store = new RateLimitPostgresStore(prefixo);
    if (janelaMs) store.windowMs = janelaMs;
    iniciarLimpeza(limparAposMs);
    return store;
};

// Contadores usados fora do fluxo de middleware (ver throttleConta.js).
// Mesma tabela e mesma semântica de janela; separado porque quem chama quer o
// total e o reset, não um middleware.
const contar = async (chave, janelaMs) => {
    const linha = await upsertContagem(chave, janelaMs);
    return { total: linha.total_hits, resetAt: new Date(linha.reset_at) };
};

// Consulta sem incrementar. Devolve total 0 quando a linha não existe, para o
// chamador não precisar distinguir "nunca falhou" de "falhou e a janela venceu".
const ler = async (chave) => {
    const [resultados] = await sequelize.query(
        `SELECT total_hits, reset_at
           FROM rate_limit
          WHERE chave = :chave
            AND reset_at > NOW()`,
        { replacements: { chave } },
    );

    if (!resultados.length) return { total: 0, resetAt: new Date(Date.now() + JANELA_PADRAO_MS) };

    const linha = resultados[0];
    return { total: linha.total_hits, resetAt: new Date(linha.reset_at) };
};

const zerar = (chave) =>
    sequelize.query('DELETE FROM rate_limit WHERE chave = :chave', { replacements: { chave } });

module.exports = {
    RateLimitPostgresStore,
    criarStore,
    contar,
    ler,
    zerar,
    limparExpirados,
    iniciarLimpeza,
};