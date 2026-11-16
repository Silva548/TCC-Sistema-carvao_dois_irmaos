const { sequelize } = require('../config/db');

const CACHE_MS = 5000;
let ultimaVerificacao = 0;
let ultimoResultado = null;
let ultimoErro = null;
let verificacaoEmAndamento = null;

const verificarBanco = () => {
    if (verificacaoEmAndamento) {
        return verificacaoEmAndamento;
    }

    verificacaoEmAndamento = sequelize.authenticate()
        .then(() => {
            ultimoErro = null;
            return true;
        })
        .catch((err) => {
            ultimoErro = err;
            return false;
        })
        .finally(() => {
            verificacaoEmAndamento = null;
        });

    return verificacaoEmAndamento;
};

// Sonda de saúde para orquestradores (Render, Railway, Docker, Kubernetes).
// Pública por definição: quem monitora não tem sessão do sistema.
const healthCheck = async (req, res) => {
    if (Date.now() - ultimaVerificacao >= CACHE_MS) {
        ultimoResultado = await verificarBanco();
        ultimaVerificacao = Date.now();

        if (!ultimoResultado) {
            console.error(`[Health][${req.id}] banco indisponível:`, ultimoErro && ultimoErro.message);
        }
    }

    if (ultimoResultado) {
        return res.status(200).json({ status: 'ok', database: 'up' });
    }

    res.status(503).json({ status: 'degraded', database: 'down' });
};

module.exports = { healthCheck };
