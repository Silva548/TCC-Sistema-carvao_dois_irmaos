const js = require('@eslint/js');

module.exports = [
    {
        // O protótipo anterior (c_prototipo/) é HTML+JS soltos de outro projeto,
        // com o próprio estilo e sem as convenções daqui. Ele fica no disco
        // durante o desenvolvimento, mas não é código nosso: sem este ignore, o
        // npm run lint(reportava ~400 erros de um código que ninguém vai
        // manter. Também está no .gitignore.
        ignores: ['node_modules/', 'views/', 'c_prototipo/'],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'writable',
                __dirname: 'readonly',
                process: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                // Globais do runtime Node usados pela suíte de integração.
                // Sem declará-los aqui, `no-undef` acusaria fetch e
                // URLSearchParams como indefinidos.
                fetch: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                AbortController: 'readonly',
                setTimeout: 'readonly',
                // limpeza periódica do rate limit
                setInterval: 'readonly',
                clearInterval: 'readonly',
                // multipart nos testes de upload
                FormData: 'readonly',
                Blob: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_|^next$' }],
            'no-undef': 'error',
            eqeqeq: ['error', 'always'],
        },
    },
    {
        // JavaScript do navegador (public/js): roda no cliente, não no Node.
        files: ['public/js/**/*.js'],
        languageOptions: {
            globals: {
                document: 'readonly',
                window: 'readonly',
                fetch: 'readonly',
                localStorage: 'readonly',
                console: 'readonly',
            },
        },
    },
];
