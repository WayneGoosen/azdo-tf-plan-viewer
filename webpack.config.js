// Webpack config for the tab bundle.
//
// We use webpack (not esbuild) because azure-devops-extension-api ships only
// AMD modules; esbuild can't consume AMD inputs and webpack handles them
// natively. Output is an IIFE that exposes the named exports of tab.ts
// on window.TerraformPlanViewer so the local dev harness can call renderPlan
// directly.

const path = require('path');

module.exports = (env, argv) => ({
    mode: argv.mode === 'development' ? 'development' : 'production',
    entry: './tab/tab.ts',
    devtool: 'source-map',
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                use: {
                    loader: 'ts-loader',
                    options: {
                        configFile: 'tsconfig.tab.json',
                        compilerOptions: { noEmit: false },
                    },
                },
            },
        ],
    },
    resolve: {
        extensions: ['.ts', '.js'],
        // Force a single SDK copy. The api package's AMD modules import
        // 'azure-devops-extension-sdk' separately and the package's `exports`
        // map can resolve our `import` and the api's AMD `define([…])`
        // dependency to different files. Aliasing both to the AMD SDK.js
        // file keeps a single instance — the SDK runs its "already loaded"
        // guard otherwise.
        alias: {
            // Path to the actual file (bypassing the package's `exports` map),
            // resolved relative to the workspace's node_modules.
            'azure-devops-extension-sdk$': path.resolve(__dirname, 'node_modules/azure-devops-extension-sdk/SDK.js'),
        },
    },
    output: {
        path: path.resolve(__dirname, 'dist/tab'),
        filename: 'tab.js',
        library: {
            name: 'TerraformPlanViewer',
            type: 'window',
        },
    },
    performance: {
        // The bundled SDK pushes us past 244 KiB; that's expected, not a problem.
        hints: false,
    },
});
