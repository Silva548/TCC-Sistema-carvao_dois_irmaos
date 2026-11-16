/*
 * Tema claro/escuro.
 *
 * Carregado no <head> SEM defer, ou seja, bloqueando a renderização. É
 * deliberado: um script com defer roda depois do HTML ser pintado, e a página
 * apareceria um instante no tema errado antes de o JS corrigir — o "flash"
 * que faz tema escuro parecer quebrado. Como arquivo externo e same-origin,
 * passa na CSP (scriptSrc 'self'), que proíbe script inline. O custo é uma
 * ida ao cache no primeiro acesso de cada sessão, e o arquivo tem poucos bytes.
 *
 * A preferência vive em localStorage (não em cookie) porque é por navegador e
 * por aparelho, não por usuário: trocar de tema não deve afectar quem entra
 * depois no mesmo computador.
 */
(function () {
    'use strict';

    var CHAVE = 'tema';
    var CLARO = 'claro';
    var ESCURO = 'escuro';

    // localStorage lança exceção em navegação privada em alguns navegadores.
    // Um erro aqui não pode impedir a página de carregar, então o tema só
    // deixa de ser lembrado.
    function lerPreferencia() {
        try {
            var v = window.localStorage.getItem(CHAVE);
            return v === CLARO || v === ESCURO ? v : null;
        } catch {
            return null;
        }
    }

    function gravarPreferencia(tema) {
        try {
            window.localStorage.setItem(CHAVE, tema);
        } catch {
            // Sem persistência o tema ainda funciona na sessão atual.
        }
    }

    function aplicar(tema) {
        document.documentElement.setAttribute('data-tema', tema);
        // A barra de rolagem e os controles nativos do navegador (checkbox,
        // select, scrollbar) acompanham o tema pelo atributo, sem CSS
        // próprio para cada um.
        document.documentElement.style.colorScheme = tema;
    }

    function preferenciaDoSistema() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
            ? ESCURO
            : CLARO;
    }

    function temaAtual() {
        return document.documentElement.getAttribute('data-tema') === ESCURO ? ESCURO : CLARO;
    }

    function alternar() {
        var novo = temaAtual() === ESCURO ? CLARO : ESCURO;
        aplicar(novo);
        gravarPreferencia(novo);

        // A transição vale só para a troca em si. Uma transição permanente no
        // body atrasaria a rolagem de páginas longas, então o atributo que a
        // habilita é removido logo depois.
        var raiz = document.documentElement;
        raiz.setAttribute('data-tema-movendo', '');
        window.setTimeout(function () {
            raiz.removeAttribute('data-tema-movendo');
        }, 250);
    }

    // Executa já no <head>, antes de qualquer elemento existir.
    aplicar(lerPreferencia() || preferenciaDoSistema());

    // Se o usuário não escolheu nada, seguir o sistema é o comportamento
    // esperado do SO. Depois de uma escolha explícita, a escolha manda e a
    // mudança do SO passa a ser ignorada.
    if (window.matchMedia) {
        var consulta = window.matchMedia('(prefers-color-scheme: dark)');
        var aoMudar = function (evento) {
            if (!lerPreferencia()) aplicar(evento.matches ? ESCURO : CLARO);
        };
        if (consulta.addEventListener) {
            consulta.addEventListener('change', aoMudar);
        } else if (consulta.addListener) {
            // Safari antigo só tem addListener.
            consulta.addListener(aoMudar);
        }
    }

    // Delegação em document: funciona independente da ordem de carregamento e
    // sem listener por botão — o botão vive no layout, que também é usado por
    // telas de erro (400/403/404/500) onde não há nenhum outro script.
    document.addEventListener('click', function (evento) {
        var botao = evento.target.closest && evento.target.closest('[data-alternar-tema]');
        if (botao) alternar();
    });
})();