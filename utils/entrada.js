const texto = (valor) =>
    (typeof valor === 'string' || typeof valor === 'number' ? String(valor).trim() : '');

const textoSenha = (valor) => (typeof valor === 'string' ? valor : '');

module.exports = { texto, textoSenha };
