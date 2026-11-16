# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Kyamii21/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Kyamii21/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A from-scratch, dependency-free Markdown renderer that produces exactly the
HTML marked 18.1.3 renders with its default options (CommonMark 0.31.2 plus
the GFM extensions: tables, task lists, strikethrough and extended
autolinks), only faster.

`parse.js` exports a single function, `parse(markdown)`, which returns the
HTML string for the input. It is a single-pass parser written for speed:
one scan over the block structure, one scan over inline content, no
dependencies, no regular-expression backtracking in the hot path.

`main.ts` is the driver the harness runs: it reads every case from the
input directory, renders each one with `parse`, and writes the HTML
strings, in order, to the output directory.

## Run it

```sh
node main.ts
```

No build step, no network: `parse.js` is a plain ES module.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rhb2d3y3&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
