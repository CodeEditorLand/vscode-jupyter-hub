// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Imports mocha for the browser, defining the `mocha` global.
// require(`./extension.test.ts`);
export function run(): Promise<void> {
    require('mocha/mocha');
    return new Promise((c, e) => {
        mocha.setup({
            ui: 'bdd',
            reporter: undefined
        });

        // Bundles all files in the current directory matching `*.test`
        const importAll = (r: __WebpackModuleApi.RequireContext) => r.keys().forEach(r);
        importAll(require.context('.', true, /\.test$/));

        try {
            // Run the mocha test
            mocha.run((failures) => {
                if (failures > 0) {
                    e(new Error(`${failures} tests failed.`));
                } else {
                    c();
                }
            });
        } catch (err) {
            console.error(err);
            e(err);
        }
    });
}
