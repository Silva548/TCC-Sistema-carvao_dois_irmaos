// Senhas padrão conhecidas, para recusar a aplicação em vez de confiar nelas.
const bcrypt = require('bcryptjs');

// O seed já gera senha aleatória em produção, mas o caminho mais comum até uma
// credencial previsível não passa por ele: alguém cria o banco em
// desenvolvimento (onde a senha é admin123), exporta um dump e promove para
// produção. O seed não roda de novo, porque é idempotente e o admin já existe —
// então o banco entra no ar com a senha padrão e nada avisa.
const SENHAS_PADRAO_CONHECIDAS = ['admin123'];

// Custo do bcrypt para senhas de usuário. 10 era o padrão histórico; 12 dobra
// o custo do atacante por tentativa sem tornar o login perceptivelmente lento
// (algumas dezenas de ms). Centralizado para que trocar de novo seja editar um
// único lugar — o hash guarda o próprio custo, então hashes antigos continuam
// válidos e são re-hasheados naturalmente quando a senha muda.
const BCRYPT_COST = 12;

// Comprimento mínimo de senha, em caracteres. 6 era curto demais para os
// padrões atuais; 8 é o mínimo recomendado pela OWASP quando não há segundo
// fator. Compartilhado pelos controllers; as views repetem o número no
// atributo `minlength` porque não têm acesso a este módulo.
const SENHA_MINIMA = 8;

// Confere a senha em claro contra a lista. Compara com bcrypt porque não há
// como ler o hash de volta; a verificação custa um bcrypt.compare por senha.
const usaSenhaPadraoConhecida = async (user, senhas = SENHAS_PADRAO_CONHECIDAS) => {
    if (!user || !user.password || !Array.isArray(senhas) || senhas.length === 0) {
        return false;
    }

    for (const senha of senhas) {
        // bcrypt.compare não lança com hash malformado: devolve false. Mesmo
        // assim, um erro aqui não deve derrubar a checagem de segurança.
        if (await bcrypt.compare(senha, user.password).catch(() => false)) {
            return true;
        }
    }
    return false;
};

module.exports = { SENHAS_PADRAO_CONHECIDAS, usaSenhaPadraoConhecida, BCRYPT_COST, SENHA_MINIMA };
