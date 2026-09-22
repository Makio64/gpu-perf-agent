# GPU Performance Agent website

A small static product page. No framework, fonts, analytics, or third-party runtime scripts.

From this directory, run `npm run dev` and open the printed preview URL. Rebuild after edits. `npm run build` writes `dist/`; `npm run preview` serves that production build. No dependency installation is needed (Node.js 22+).

The build reads the root package version and replaces `__VERSION__`. All asset URLs are relative so the page also works under the GitHub Pages project path.

`.github/workflows/pages.yml` builds and deploys changes on `master`. The published site is https://makio64.github.io/gpu-perf-agent/.

The interactive report is explicitly illustrative, not a live capture or a performance claim. The profiler runs locally; visiting this website does not profile the visitor's GPU.
