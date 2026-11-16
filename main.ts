// Driver for this entry: it reads every case from the input directory,
// renders each markdown string with parse() from parse.js, and writes the
// resulting HTML strings, in the cases' order, to the output directory.
// The harness runs `node /bot/main.ts`; MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output outside a container.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i += 1) {
  rendered[i] = parse(cases[i]!.markdown);
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
