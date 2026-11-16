// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts` (Node 22). It reads every case from
// /input/cases.json (a JSON array of {id, markdown}), renders each one on
// its own with parse() from ./parse.js, and writes /output/html.json: a
// JSON array of the HTML strings, one per case and in the cases' order.
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.
//
// parse.js is a from-scratch, dependency-free renderer written to return
// exactly what marked 18.1.3 returns with its default options. The driver
// itself does no rendering: it only moves the cases in and the HTML out,
// so the measured time is the renderer's time.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
) as { id: string; markdown: string }[];

const html = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
