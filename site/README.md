# gpu-perf-agent — site

The static insight site for [`gpu-perf-agent`](../README.md): what it is, how the
optimize loop works, and how to install it. Built with Vite, zero runtime
dependencies, single bright theme.

```bash
npm install      # once
npm run dev      # local dev server (http://localhost:5184)
npm run build    # static build to dist/
npm run preview  # preview the production build
```

The build emits plain static files to `dist/` with relative asset paths
(`base: './'`), so it can be served from any static host or subpath.

The numbers in the "sample report" section are taken verbatim from real captured
runs in [`../reports/`](../reports/) (a three.js Cascaded Shadow Maps demo,
before and after a texture-memory fix). See `src/data/sample-report.js`.
