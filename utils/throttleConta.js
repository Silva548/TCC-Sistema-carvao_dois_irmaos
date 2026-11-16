// Freio por conta, em complemento ao freio por IP das rotas.
//
// O loginLimiter de routes/authRoutes.js conta por IP, e isso é necessário — sem
// ele um atacante varia de endereço. Mas por IP só ele não basta: um atacante
// com uma faixa de IPs (ou uma botnet) continua tentando a mesma senha contra a
// mesma conta sem nunca bater no limite, porque cada origem tem a própria
// janela. É a defesa canônica contra credential stuffing.
//
// A chave é o hash do username, não o username. O nome de usuário é entrada de
// usuário e vai parar numa tabela do banco: guardar o texto puro também
// transformaria a tabela de rate limit num dicionário de "quais nomes existem
// aqui", legível por qualquer uma com acesso de leitura. O SHA-256 resolve sem
// introduzir dependência e sem guardar nada reversível.
//
// O limite por conta é mais alto que o por IP de propósito. Se fosse mais
// apertado, bastariam algumas tentativas para trancar a conta da vítima —
// negação de serviço com efeito colateral. Como o limite por IP também existe,
// o atacante de um único endereço nem chega perto do valor por conta.
//
// O preço Known dessa desenho é que um atacante distribuído (vários IPs) ainda
// consegue trancar a conta de alguém por 15 minutos. É a escolha padrão
// nesse tipo de defesa: sem limite por conta, o credential stuffing passa
// livre; com ele, a vítima pode ser trancada. O limite alto, o reset no login
// bem-sucedido e a janela de 15 min são o que torna o efeito colateral
// aceitável.
//
// Só falhas contam. Login bem-sucedido zera o contador, senão um cliente legítimo
// que entra e sai algumas vezes acabaria trancado pelo próprio uso normal.

const crypto = require('crypto');
const { contar, ler, zerar } = require('../middleware/rateLimitStore');

const JANELA_MS = 15 * 60 * 1000;
const LIMITE_PADRAO = 20;

const limiteDe = () => Number(process.env.LOGIN_CONTA_RATE_LIMIT) || LIMITE_PADRAO;

// A chave normaliza case e espaços, de propósito: "Admin", " admin" e "ADMIN"
// são a mesma conta e precisam compartilhar o contador, senão o atacante
// escaparia trocando a capitalização a cada tentativa.
const chaveDe = (username) =>
    `conta:${crypto.createHash('sha256').update(String(username).trim().toLowerCase()).digest('hex')}`;

// Consulta o estado da conta SEM incrementar. Chamado antes do bcrypt: é este
// passo que impede o ataque de continuar, e ele precisa vir antes da comparação
// de senha — depois dela o bcrypt já gastou a CPU e a tentativa já aconteceu.
const consultar = async (username) => {
    const limite = limiteDe();
    const { total, resetAt } = await ler(chaveDe(username));
    return { total, limite, bloqueado: total >= limite, resetAt };
};

// Registra uma falha e devolve o estado. Chamado só quando a senha (ou o
// usuário) não conferiu.
const registrarFalha = async (username) => {
    const limite = limiteDe();
    const { total, resetAt } = await contar(chaveDe(username), JANELA_MS);
    return { total, limite, bloqueado: total > limite, resetAt };
};

// Login certo: limpa o histórico de falhas da conta.
const limpar = (username) => zerar(chaveDe(username));

module.exports = { chaveDe, consultar, registrarFalha, limpar, JANELA_MS, LIMITE_PADRAO };