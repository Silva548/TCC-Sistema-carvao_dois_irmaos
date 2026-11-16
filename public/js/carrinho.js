// Carrinho da home do cliente comum.
//
// O estado vive no localStorage deste navegador. O servidor NÃO confia nos
// preços daqui: ao finalizar, envia-se produto/quantidade e o pedido é
// revalidado e recalculado em services/pedidoService (estoque, preço atual,
// total). Este script só cuida da experiência de montar o carrinho.
//
// Carregado apenas quando a view define `carrinho` (home do user). Sem o bloco
// #carrinho-config o script não faz nada — admin e visitante não o carregam.
(function () {
    'use strict';

    var config = document.getElementById('carrinho-config');
    if (!config) return;

    var CHAVE = 'cdi_carrinho';
    var urlPedido = config.getAttribute('data-criar-pedido');
    var csrf = config.getAttribute('data-csrf') || '';

    var listaEl = document.getElementById('carrinho-lista');
    var vazioEl = document.getElementById('carrinho-vazio');
    var contadorEl = document.getElementById('carrinho-contador');
    var totalEl = document.getElementById('carrinho-total');
    var erroEl = document.getElementById('carrinho-erro');
    var pagamentoEl = document.getElementById('carrinho-pagamento');
    var entregaEl = document.getElementById('carrinho-entrega');
    var finalizarEl = document.getElementById('finalizar-pedido');

    // Endereco: existe no DOM mesmo escondido. `null` significa que o bloco nao
    // foi renderizado (admin/visitante, onde o carrinho nao aparece) e todo o
    // tratamento abaixo sai pelo atalho.
    var enderecoEls = {
        bloco: document.getElementById('carrinho-endereco'),
        cep: document.getElementById('carrinho-cep'),
        logradouro: document.getElementById('carrinho-logradouro'),
        numero: document.getElementById('carrinho-numero'),
        complemento: document.getElementById('carrinho-complemento'),
        bairro: document.getElementById('carrinho-bairro'),
        cidade: document.getElementById('carrinho-cidade'),
        uf: document.getElementById('carrinho-uf'),
    };

    var contatoEls = {
        nome: document.getElementById('carrinho-contato-nome'),
        email: document.getElementById('carrinho-contato-email'),
        telefone: document.getElementById('carrinho-contato-telefone'),
    };

    var itens = ler();

    function ler() {
        try {
            var bruto = window.localStorage.getItem(CHAVE);
            var dados = bruto ? JSON.parse(bruto) : [];
            return Array.isArray(dados) ? dados : [];
        } catch {
            return [];
        }
    }

    function salvar() {
        try {
            window.localStorage.setItem(CHAVE, JSON.stringify(itens));
        } catch {
            // Modo privado / cota cheia: o carrinho funciona na aba, mas não
            // sobrevive a recarregar a página.
        }
    }

    function numero(valor) {
        var n = Number(valor);
        return Number.isFinite(n) ? n : 0;
    }

    function moeda(valor) {
        return 'R$ ' + numero(valor).toLocaleString('pt-BR', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }

    function precoDoItem(item) {
        return entregaEl.value === 'retirada'
            ? numero(item.preco_retirada)
            : numero(item.preco_entrega);
    }

    function total() {
        return itens.reduce(function (soma, item) {
            return soma + precoDoItem(item) * item.quantidade;
        }, 0);
    }

    function contar() {
        return itens.reduce(function (soma, item) {
            return soma + item.quantidade;
        }, 0);
    }

    function acharItem(id) {
        for (var i = 0; i < itens.length; i++) {
            if (String(itens[i].produto_id) === String(id)) return itens[i];
        }
        return null;
    }

    // ----------------------------------------------------------------
    // Seletor de quantidade (os "-" / campo / "+" nos cards e na ficha)
    // ----------------------------------------------------------------

    // Procura o seletor que pertence ao botão. O botão e o seletor são irmãos
    // dentro de .produto-acoes (card) ou do mesmo flex (ficha), então subir até
    // o container comum é o que amarra os dois. Devolve null quando o botão
    // está sozinho, e aí vale 1.
    function seletorDoBotao(botao) {
        var acao = botao.closest('.produto-acoes, .produto-detalhe');
        return acao ? acao.querySelector('[data-seletor-qtd]') : null;
    }

    function quantidadeDoSeletor(seletor) {
        if (!seletor) return 1;
        var campo = seletor.querySelector('.qtd-input');
        return campo ? Math.max(1, Math.floor(numero(campo.value))) : 1;
    }

    // Aplica um teto e devolve o valor final.
    //
    // O teto é o data-estoque do botão, que vem do banco renderizado. Não é
    // confiança: quem decide de verdade é o pedidoService, que revalida
    // estoque e preço quando o pedido é fechado. Aqui é só para o contador não
    // ficar mostrando um número que o servidor vai recusar na mesma hora.
    function limitar(valor, botao) {
        var estoque = numero(botao.getAttribute('data-estoque'));
        if (estoque < 1) return 0;
        return Math.min(Math.max(1, Math.floor(valor)), estoque);
    }

    function ajustarSeletor(seletor, delta) {
        var campo = seletor.querySelector('.qtd-input');
        if (!campo) return;

        var max = numero(campo.getAttribute('max'));
        var nova = Math.floor(numero(campo.value)) + delta;

        if (nova < 1) nova = 1;
        if (max >= 1 && nova > max) nova = max;

        campo.value = String(nova);
        atualizarBotoesDoSeletor(seletor);
    }

    // O "+" no limite e o "-" embaixo de 2 desabilitam, para o controle dizer
    // sozinho que chegou no fim.
    function atualizarBotoesDoSeletor(seletor) {
        var campo = seletor.querySelector('.qtd-input');
        var menos = seletor.querySelector('.btn-qtd-menos');
        var mais = seletor.querySelector('.btn-qtd-mais');
        if (!campo) return;

        var atual = Math.floor(numero(campo.value));
        var max = numero(campo.getAttribute('max'));

        if (menos) menos.disabled = atual <= 1;
        if (mais) mais.disabled = max >= 1 && atual >= max;
    }

    function adicionar(botao) {
        var id = botao.getAttribute('data-produto-id');
        var estoque = numero(botao.getAttribute('data-estoque'));
        var existente = acharItem(id);

        // Sem estoque não entra nada. O card já vem desabilitado, mas o botão
        // pode ter ficado obsoleto na aba (outra pessoa esvaziou o estoque): a
        // checagem aqui evita mostrar um item que o servidor vai recusar.
        if (estoque < 1) {
            mostrarErro('Este produto está esgotado.');
            return;
        }

        var pedido = limitar(quantidadeDoSeletor(seletorDoBotao(botao)), botao);

        if (existente) {
            // Some as duas quantidades, não substitui: comprar "mais 2" de algo
            // que já estava no carrinho tem de virar 5.
            existente.quantidade = Math.min(existente.quantidade + pedido, estoque);
        } else {
            itens.push({
                produto_id: id,
                nome: botao.getAttribute('data-produto-nome'),
                preco_entrega: botao.getAttribute('data-preco-entrega'),
                preco_retirada: botao.getAttribute('data-preco-retirada'),
                estoque: estoque,
                quantidade: pedido,
            });
        }

        salvar();
        renderizar();
        avisarAdicionado(botao);
    }

    // Confirmação efêmera no lugar do clique. Sem isto, clicar em "Adicionar"
    // com a lista de 5 itens dá um resultado invisível — nada muda na tela e o
    // cliente não sabe se funcionou.
    function avisarAdicionado(botao) {
        var original = botao.textContent;
        botao.textContent = 'Adicionado \u2713';
        botao.disabled = true;
        setTimeout(function () {
            botao.textContent = original;
            botao.disabled = false;
        }, 1200);
    }

    function mudarQuantidade(id, delta) {
        var item = acharItem(id);
        if (!item) return;

        var nova = item.quantidade + delta;
        if (nova < 1) {
            remover(id);
            return;
        }
        if (nova > item.estoque) {
            nova = item.estoque;
        }
        item.quantidade = nova;
        salvar();
        renderizar();
    }

    function remover(id) {
        itens = itens.filter(function (item) {
            return String(item.produto_id) !== String(id);
        });
        salvar();
        renderizar();
    }

    function renderizar() {
        contadorEl.textContent = String(contar());
        totalEl.textContent = 'Total: ' + moeda(total());

        if (!itens.length) {
            vazioEl.classList.remove('d-none');
            listaEl.innerHTML = '';
            return;
        }
        vazioEl.classList.add('d-none');

        listaEl.innerHTML = '';
        itens.forEach(function (item) {
            var linha = document.createElement('div');
            linha.className = 'carrinho-item d-flex align-items-center justify-content-between border-bottom py-2';
            linha.setAttribute('data-produto-id', item.produto_id);

            var info = document.createElement('div');
            var nome = document.createElement('strong');
            nome.textContent = item.nome;
            var preco = document.createElement('div');
            preco.className = 'text-muted small';
            preco.textContent = moeda(precoDoItem(item)) + ' cada';
            info.appendChild(nome);
            info.appendChild(preco);

            var controles = document.createElement('div');
            controles.className = 'd-flex align-items-center';

            var menos = document.createElement('button');
            menos.type = 'button';
            menos.className = 'btn btn-sm btn-outline-secondary btn-diminuir';
            menos.textContent = '\u2212';

            var qtd = document.createElement('span');
            qtd.className = 'mx-2';
            qtd.textContent = String(item.quantidade);

            var mais = document.createElement('button');
            mais.type = 'button';
            mais.className = 'btn btn-sm btn-outline-secondary btn-aumentar';
            mais.textContent = '+';

            var removerBtn = document.createElement('button');
            removerBtn.type = 'button';
            removerBtn.className = 'btn btn-sm btn-link text-danger btn-remover ml-2';
            removerBtn.textContent = 'Remover';

            controles.appendChild(menos);
            controles.appendChild(qtd);
            controles.appendChild(mais);
            controles.appendChild(removerBtn);

            var subtotal = document.createElement('div');
            subtotal.className = 'ml-3';
            subtotal.textContent = moeda(precoDoItem(item) * item.quantidade);

            linha.appendChild(info);
            linha.appendChild(controles);
            linha.appendChild(subtotal);
            listaEl.appendChild(linha);
        });
    }

    function mostrarErro(mensagem) {
        erroEl.textContent = mensagem;
        erroEl.classList.remove('d-none');

        // O aviso mora dentro do modal. Se o modal estiver fechado, quem chamou
        // mostrarErro (por exemplo, o "esgotado" de um card com a aba
        // desatualizada) não veria nada e acharia que o clique não funcionou.
        // Então o modal é aberto. Quando ele já está aberto, isto não muda a
        // tela.
        var modal = document.getElementById('modal-carrinho');
        var jq = window.jQuery;
        if (modal && jq) {
            jq(modal).modal('show');
        }
    }

    function limparErro() {
        erroEl.textContent = '';
        erroEl.classList.add('d-none');
    }

    // Sincroniza a visibilidade do endereco com a modalidade escolhida. E uma
    // funcao em vez de CSS puro porque o seletor muda de valor programatica-
    // mente quando o total e recalculado, e a secao ficaria com a visibilidade
    // de um estado antigo.
    function sincronizarEndereco() {
        if (!enderecoEls.bloco) return;
        var ehEntrega = entregaEl.value === 'entrega';
        enderecoEls.bloco.classList.toggle('d-none', !ehEntrega);
        enderecoEls.bloco.setAttribute('aria-hidden', ehEntrega ? 'false' : 'true');
    }

    function finalizar() {
        limparErro();

        if (!itens.length) {
            mostrarErro('Seu carrinho está vazio.');
            return;
        }
        if (!pagamentoEl.value) {
            mostrarErro('Escolha a forma de pagamento.');
            return;
        }

        var contato = {
            nome: contatoEls.nome.value.trim(),
            email: contatoEls.email.value.trim(),
            telefone: contatoEls.telefone.value.trim(),
        };
        if (!contato.nome || !contato.email || !contato.telefone) {
            mostrarErro('Preencha nome, e-mail e WhatsApp para contato.');
            return;
        }

        // Endereco so entra no corpo quando a modalidade e entrega. Em retirada
        // ele NAO e enviado nem vazio: mandar as colunas em null deixaria o
        // servico valida-las e recusar um pedido legitimo de retirada.
        var endereco = null;
        if (entregaEl.value === 'entrega') {
            endereco = {
                cep: enderecoEls.cep.value.trim(),
                logradouro: enderecoEls.logradouro.value.trim(),
                numero: enderecoEls.numero.value.trim(),
                complemento: enderecoEls.complemento.value.trim(),
                bairro: enderecoEls.bairro.value.trim(),
                cidade: enderecoEls.cidade.value.trim(),
                uf: enderecoEls.uf.value.trim().toUpperCase(),
            };

            var faltando = [];
            if (!endereco.logradouro) faltando.push('logradouro');
            if (!endereco.numero) faltando.push('numero');
            if (!endereco.bairro) faltando.push('bairro');
            if (!endereco.cidade) faltando.push('cidade');
            if (!endereco.uf) faltando.push('UF');
            if (faltando.length) {
                mostrarErro('Preencha o endereco de entrega: ' + faltando.join(', ') + '.');
                return;
            }
            if (endereco.uf.length !== 2) {
                mostrarErro('A UF deve ter 2 letras.');
                return;
            }
        }

        finalizarEl.disabled = true;
        finalizarEl.textContent = 'Enviando...';

        fetch(urlPedido, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            credentials: 'same-origin',
            body: JSON.stringify({
                _csrf: csrf,
                forma_pagamento: pagamentoEl.value,
                tipo_entrega: entregaEl.value,
                contato: contato,
                endereco: endereco,
                itens: itens.map(function (item) {
                    return { produto_id: item.produto_id, quantidade: item.quantidade };
                }),
            }),
        })
            .then(function (resposta) {
                return resposta.json().catch(function () { return {}; }).then(function (corpo) {
                    return { status: resposta.status, corpo: corpo };
                });
            })
            .then(function (resultado) {
                // A API devolve 201 com { message, pedido }.
                var criado = resultado.corpo.pedido;
                if (resultado.status >= 200 && resultado.status < 300 && criado && criado.id) {
                    itens = [];
                    salvar();
                    window.location.href = '/pedidos/' + criado.id + '?msg=criado';
                    return;
                }
                mostrarErro(resultado.corpo.error || 'Não foi possível finalizar o pedido.');
            })
            .catch(function () {
                mostrarErro('Falha de conexão. Tente novamente.');
            })
            .then(function () {
                finalizarEl.disabled = false;
                finalizarEl.textContent = 'Finalizar pedido';
            });
    }

    // Delegação no documento: os cards são renderizados no servidor, mas o
    // listener assim sobrevive a qualquer re-render futuro.
    document.addEventListener('click', function (evento) {
        var alvo = evento.target;

        // O seletor de quantidade vem ANTES do botão no teste: o "+" esta
        // dentro de .produto-acoes, e o botao de adicionar tambem, entao sem
        // esta ordem o clique no "+" seria lido como "adicionar 1".
        var seletor = alvo.closest('[data-seletor-qtd]');
        if (seletor) {
            if (alvo.closest('.btn-qtd-mais')) {
                ajustarSeletor(seletor, 1);
                return;
            }
            if (alvo.closest('.btn-qtd-menos')) {
                ajustarSeletor(seletor, -1);
                return;
            }
        }

        if (alvo.closest('.btn-add-carrinho')) {
            adicionar(alvo.closest('.btn-add-carrinho'));
            return;
        }

        var linha = alvo.closest('.carrinho-item');
        if (!linha) return;
        var id = linha.getAttribute('data-produto-id');

        if (alvo.closest('.btn-aumentar')) {
            mudarQuantidade(id, 1);
        } else if (alvo.closest('.btn-diminuir')) {
            mudarQuantidade(id, -1);
        } else if (alvo.closest('.btn-remover')) {
            remover(id);
        }
    });

    // Estado inicial dos seletores: com estoque 1 o "+" nasce desabilitado.
    Array.prototype.forEach.call(document.querySelectorAll('[data-seletor-qtd]'), function (seletor) {
        atualizarBotoesDoSeletor(seletor);
    });

    // Nem focado, a roda do mouse muda o valor de um input[type=number]:
    // scrollar a página por cima do campo mudaria a quantidade sem querer.
    // blur() faz o scroll passar reto, com o valor intocado.
    document.addEventListener('wheel', function (evento) {
        var campo = evento.target.closest ? evento.target.closest('.qtd-input') : null;
        if (campo) campo.blur();
    }, { passive: true });

    // Digitação direta no campo. A normalização acontece no change (blur ou
    // Enter), não a cada tecla: corrigir o valor no meio da digitação
    // apagaria o último dígito antes de o usuário terminar de digitar.
    // O arredondamento e o teto são os mesmos dos botões "+"/"-" e do
    // limite aplicado em adicionar() — e o servidor revalida tudo de
    // qualquer forma no fechamento do pedido.
    function normalizarCampo(campo) {
        var max = numero(campo.getAttribute('max'));
        var valor = Math.floor(numero(campo.value));

        if (!Number.isFinite(valor) || valor < 1) valor = 1;
        if (max >= 1 && valor > max) valor = max;

        campo.value = String(valor);
    }

    document.addEventListener('change', function (evento) {
        var campo = evento.target.closest ? evento.target.closest('.qtd-input') : null;
        if (!campo) return;

        normalizarCampo(campo);
        var seletor = campo.closest('[data-seletor-qtd]');
        if (seletor) atualizarBotoesDoSeletor(seletor);
    });

    if (entregaEl) {
        entregaEl.addEventListener('change', function () {
            sincronizarEndereco();
            renderizar();
        });
    }
    if (finalizarEl) {
        finalizarEl.addEventListener('click', finalizar);
    }

    // Antes do primeiro render: sem isso a página abriria com a seção de
    // endereço já escondida (d-none no HTML) mesmo com "Entrega" selecionado.
    sincronizarEndereco();
    renderizar();
})();
