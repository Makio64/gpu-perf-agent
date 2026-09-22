# GPU Performance Agent website

A two-step quickstart: install the skill with the same `skills` command for Codex, Claude Code, Gemini CLI, and other supported agents; then ask the agent to optimize an app. A small flow diagram, measurement labels, and stacked explanations before the footer cover capture, code changes, comparison evidence, iteration options, and measurement limits. The diagram uses HTML and decorative SVG arrows, with its sequence available to screen readers. No framework, fonts, analytics, or third-party runtime scripts.

From this directory, run `npm run dev` and open the printed preview URL. Rebuild after edits. `npm run build` writes `dist/`; `npm run preview` serves that production build. No dependency installation is needed (Node.js 22+).

The build reads the root package version and replaces `__VERSION__`. All asset URLs are relative so the page also works under the GitHub Pages project path.

`.github/workflows/pages.yml` builds and deploys changes on `master`. The published site is https://makio64.github.io/gpu-perf-agent/.

The install command uses the `skills` CLI with `-g` for all projects; users choose their agent when prompted. The skill runs the profiler through `npx`, so a separate global profiler installation is unnecessary. Project-only installation is available by omitting `-g`.

Clipboard actions run entirely in the browser. Both snippets stay readable without JavaScript. The profiler runs locally when the agent executes it, with the agent's normal command permissions.
