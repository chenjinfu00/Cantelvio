import {build} from 'esbuild';
import fs from 'node:fs/promises';
await build({stdin:{contents:"export {sha256} from '@noble/hashes/sha2.js';",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',target:'safari15',minify:true,outfile:'docs/vendor/sha256.js'});
await fs.copyFile('node_modules/@noble/hashes/LICENSE','docs/vendor/noble-hashes-LICENSE.txt');
