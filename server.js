// Ponto de entrada do servidor. Fica separado de app.js para que o app possa ser
// importado por testes sem subir um listener nem prender a porta 3000.
const app = require('./app');
const { sequelize, sessionPool } = require('./config/db');
const { User } = require('./models');
const { usaSenhaPadraoConhecida } = require('./utils/credenciais');

const PORT = process.env.PORT || 3000;

// Em produção, recusa subir com um admin de senha padrão conhecida. Preferir a
// aplicação fora do ar a um admin com senha admin123 é a diferença entre um
// incidente e um aviso de boot. Devolve true quando achou uma.
const adminUsaSenhaPadrao = async () => {
    if (process.env.NODE_ENV !== 'production') {
        return false;
    }

    const admin = await User.findOne({ where: { username: 'admin' } });
    return Boolean(admin) && usaSenhaPadraoConhecida(admin);
};

const iniciar = async () => {
    try {
        await sequelize.authenticate();
    } catch (err) {
        console.error('Falha ao conectar ao banco de dados:', err.message);
        console.error('Aplique as migrations antes de iniciar: npm run migrate');
        process.exit(1);
    }

    // authenticate() só prova que existe um Postgres com credencial boa, não
    // que o schema está em dia. Com a tabela rate_limit faltando (migration
    // esquecida no deploy), o limitador passaria a errar em toda requisição
    // dinâmica — o site inteiro cairia, mas o boot teria dado "ok". Checar a
    // tabela explicitamente transforma esse caso em uma falha de boot visível.
    try {
        await sequelize.query('SELECT 1 FROM rate_limit LIMIT 1');
    } catch (err) {
        console.error('A tabela "rate_limit" não existe ou está inacessível:', err.message);
        console.error('Aplique as migrations antes de iniciar: npm run migrate');
        process.exit(1);
    }

    try {
        if (await adminUsaSenhaPadrao()) {
            console.error('');
            console.error('✖ Recusando iniciar: o usuário "admin" ainda usa a senha padrão "admin123".');
            console.error('  Troque-a no painel de Usuários antes de expor a aplicação,');
            console.error('  ou defina ADMIN_SENHA e rode "npm run seed" em um banco vazio.');
            console.error('');
            process.exit(1);
        }
    } catch (err) {
        console.error('Falha ao verificar as credenciais do admin:', err.message);
        process.exit(1);
    }

    const server = app.listen(PORT, () => {
        console.log(`Conectado ao PostgreSQL. Server is running on port ${PORT}`);
    });

    // Encerramento gracioso: fecha o listener e as conexões antes de sair,
    // para não deixar transações penduradas nem conexões órfãs
    const encerrar = (sinal) => async () => {
        console.log(`\n${sinal} recebido, encerrando...`);
        server.close(async () => {
            try {
                await sequelize.close();
                await sessionPool.end();
            } catch (err) {
                console.error('Erro ao fechar conexões:', err.message);
            }
            process.exit(0);
        });
    };

    process.on('SIGTERM', encerrar('SIGTERM'));
    process.on('SIGINT', encerrar('SIGINT'));
};


// Tratamento de rejeições não tratadas e exceções não capturadas.
// Express 4 não trata rejected promises em handlers async fora de try/catch;
// sem estes handlers, o processo pode abortar de forma abrupta no Node.
process.on('unhandledRejection', (reason, _promise) => {
    console.error('[unhandledRejection] Rejeição não tratada em promise:', reason);
    if (reason && reason.stack) {
        console.error(reason.stack);
    }
});

process.on('uncaughtException', (err) => {
    console.error('[uncaughtException] Exceção não capturada:', err);
    if (err && err.stack) {
        console.error(err.stack);
    }
    // Depois de uma exceção não capturada o estado do processo é indefinido.
    // Sair deixa o gestor de processos reiniciar em vez de seguir servindo com
    // conexões e transações possivelmente inconsistentes.
    process.exit(1);
});

iniciar();
