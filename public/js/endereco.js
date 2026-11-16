/*
 * Preenchimento automático de endereço por CEP (ViaCEP).
 *
 * Arquivo único para as duas telas que pedem endereço — o checkout do carrinho e
 * o formulário de pedido do admin — porque o comportamento tem que ser
 * idêntico nas duas: se só um deles preenchesse, o cliente aprenderia que o
 * automático funciona e depois o admin receberia o endereço à mão.
 *
 * Externo e same-origin (scriptSrc 'self' na CSP, que proíbe script inline), e
 * carregado no layout com defer: não bloqueia a pintura e só age depois que o
 * DOM existe.
 *
 * O ViaCEP é uma API pública de terceiros e pode ficar lenta ou cair. Por isso
 * é SEMPRE opcional: a falha é silenciosa, o campo simplesmente continua vazio
 * e a pessoa digita. Nenhum botão de envio depende dele — se o preenchimento
 * automático não acontecer, o pedido ainda funciona.
 */
(function () {
    'use strict';

    var VIA_CEP = 'https://viacep.com.br/ws/';
    var CAMPOS = ['logradouro', 'bairro', 'cidade', 'uf'];

    // Só 8 dígitos contam. Digitar o CEP com máscara e sair do campo é o
    // gesto normal, e sem isto a busca rodaria com "88955-0" e sempre falharia.
    function soDigitos(valor) {
        return String(valor || '').replace(/\D/g, '');
    }

    function consultar(cep) {
        return fetch(VIA_CEP + cep + '/json/', { method: 'GET' })
            .then(function (r) {
                return r.ok ? r.json() : null;
            })
            .catch(function () {
                // Sem rede, DNS falhando, CORS, timeout: seguimos sem auto.
                return null;
            });
    }

    function preencher(alvos, dados) {
        CAMPOS.forEach(function (campo) {
            var valor = dados[campo];
            // Não sobrescreve o que a pessoa já digitou: num cadastro já
            // preenchido, corrigir o CEP para o mesmo endereço não pode apagar
            // o que ela ajustou à mão.
            if (valor && (!alvos[campo] || !alvos[campo].value)) {
                alvos[campo].value = campo === 'uf' ? String(valor).toUpperCase() : valor;
            }
        });
    }

    function ligar(cep) {
        if (!cep) return;

        // `endereco-carregando` trava um segundo pedido: sem isso, colar o CEP e
        // sair do campo duas vezes rápido dispara duas buscas, e a segunda
        // resposta pode chegar depois da primeira com outro endereço.
        cep.setAttribute('data-buscando', '1');
        cep.classList.add('is-loading');

        consultar(soDigitos(cep.value))
            .then(function (dados) {
                // O ViaCEP responde 200 com { erro: true } para CEP inexistente.
                if (!dados || dados.erro) return;

                var alvos = {};
                CAMPOS.forEach(function (campo) {
                    alvos[campo] = document.getElementById('endereco_' + campo);
                });

                preencher(alvos, dados);

                // Número é sempre o primeiro a ser preenchido numa rua, mas o
                // ViaCEP não devolve número: o foco vai para ele, que é o único
                // campo que só a pessoa conhece.
                var numero = document.getElementById('endereco_numero');
                if (numero && !numero.value && alvos.logradouro && alvos.logradouro.value) {
                    numero.focus();
                }
            })
            .then(function () {
                cep.removeAttribute('data-buscando');
                cep.classList.remove('is-loading');
            });
    }

    document.addEventListener('DOMContentLoaded', function () {
        var cep = document.getElementById('endereco_cep');
        if (!cep) return;

        // blur e não input: consultar a cada tecla dispara uma chamada por
        // dígito digitado. blur dispara uma vez, quando a pessoa termina.
        function buscarAgora() {
            if (cep.getAttribute('data-buscando')) return;
            if (soDigitos(cep.value).length !== 8) return;
            ligar(cep);
        }

        cep.addEventListener('blur', buscarAgora);

        // Permite colar o CEP e buscar sem sair do campo. O setTimeout dá um
        // turno ao navegador para colar antes de ler o valor.
        cep.addEventListener('paste', function () {
            window.setTimeout(buscarAgora, 0);
        });
    });
})();