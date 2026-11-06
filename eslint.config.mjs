import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: [
            'dist/',
            '.dev/',
            'node_modules/',
            'buildAndReleaseTask/node_modules/',
            '*.vsix',
            'webpack.config.js',
            'vitest.config.ts',
            'eslint.config.js',
            'site/',
            'design/',
            'test-results/',
            'playwright-report/',
        ],
    },
    {
        files: ['dev-fixtures/dev.js'],
        languageOptions: {
            globals: {
                window: 'readonly',
                document: 'readonly',
                fetch: 'readonly',
                setTimeout: 'readonly',
                URLSearchParams: 'readonly',
            },
        },
    },
    {
        files: ['e2e/serve.mjs'],
        languageOptions: {
            globals: { process: 'readonly', URL: 'readonly' },
        },
    },
    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            'preserve-caught-error': 'off',
        },
    }
);
