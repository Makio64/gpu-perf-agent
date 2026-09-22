/**
 * Self-contained, zero-dependency interactive HTML report generator.
 * Produces an offline-first, dark-themed performance dashboard with
 * interactive SVG charts, diagnostic filters, and actionable fix guides.
 */

export function generateHtmlReport(report) {
  const summary = report.summary || {};
  const inPageSummary = report.inPage?.summary || {};
  const analysis = report.diagnostics || {};
  const recs = analysis.recommendations || summary.recommendations || [];
  const resources = analysis.resources || {};
  const warmup = report.inPage?.warmup || summary.warmup || null;
  const slowFrames = report.inPage?.slowFrames || report.slowFrames || [];
  const apiSupport = report.inPage?.apiSupport || {};

  const fps = summary.fps ?? inPageSummary.fps?.mean ?? null;
  const cadence = summary.cadence ?? inPageSummary.cadence ?? null;
  const frameTimeMean = summary.frameTimeMsMean ?? inPageSummary.frameTimeMsMean?.mean ?? null;
  const frameTimeP95 = summary.frameTimeMsP95 ?? inPageSummary.frameTimeMsP95?.mean ?? null;
  const frameTimeP99 = inPageSummary.frameTimeMsP99?.mean ?? null;
  const maxJitter = summary.maxJitterMs ?? inPageSummary.maxJitter?.mean ?? null;
  const gpuFrameMs = summary.gpuFrameMsMean ?? (inPageSummary.gpuTimeNs?.mean ? inPageSummary.gpuTimeNs.mean / 1e6 : null);
  const computeMs = inPageSummary.computeTimeNs?.mean ? inPageSummary.computeTimeNs.mean / 1e6 : null;
  const renderMs = inPageSummary.renderTimeNs?.mean ? inPageSummary.renderTimeNs.mean / 1e6 : null;

  const totalVramMiB = summary.trackedVram?.totalMiB ?? ((resources.totalBytes || 0) / 1024 / 1024);
  const textureMiB = summary.trackedVram?.textureMiB ?? ((resources.textureBytes || 0) / 1024 / 1024);
  const bufferMiB = summary.trackedVram?.bufferMiB ?? ((resources.bufferBytes || 0) / 1024 / 1024);
  const textureCount = summary.trackedVram?.textureCount ?? resources.textureCount ?? 0;
  const bufferCount = summary.trackedVram?.bufferCount ?? resources.bufferCount ?? 0;

  const pipelines = summary.pipelines || report.inPage?.memory?.after?.trackedGpuMemory?.pipelines || null;
  const syncPipelines = pipelines?.syncCount ?? (recs.find(r => r.id === "pipeline-sync-stall")?.value || 0);
  const asyncPipelines = pipelines?.asyncCount ?? 0;
  const shaderModules = pipelines?.shaderModules ?? 0;

  const bindGroups = summary.bindGroups || report.inPage?.memory?.after?.trackedGpuMemory?.bindGroups || null;
  const bindGroupsCreated = bindGroups?.createdCount ?? (recs.find(r => r.id === "bind-group-churn")?.value || 0);

  const ops = summary.webgpuOps || {};
  const drawCalls = ops.drawCalls ?? inPageSummary.drawCalls?.mean ?? null;
  const dispatchCalls = ops.dispatchCalls ?? inPageSummary.dispatchCalls?.mean ?? null;

  const verdict = analysis.validity?.valid === false ? "invalid" : summary.verdict || "unknown";
  const url = (typeof report.target === "string" ? report.target : (report.target?.file || report.target?.url)) ||
              report.inPage?.location ||
              report.location ||
              "WebGPU Application";
  const timestamp = report.timestamp || report.createdAt || new Date().toISOString();
  const adapterInfo = apiSupport.webgpu?.adapter || null;
  const adapterDesc = adapterInfo?.description || adapterInfo?.name || (adapterInfo?.vendor ? `${adapterInfo.vendor} ${adapterInfo.architecture || ""}` : "WebGPU Adapter");

  const verdictColor = verdict === "excellent" ? "#10b981" :
                       verdict === "good" ? "#3b82f6" :
                       verdict === "needs-work" ? "#f59e0b" : "#ef4444";

  // SVG Frame Distribution Curve generator
  const samples = report.inPage?.samples || [];
  const frameDeltas = [];
  for (const s of samples) {
    if (s.measurement?.frameTimeMs?.mean) {
      frameDeltas.push(s.measurement.frameTimeMs.mean);
    }
  }

  let sparklineSvg = "";
  if (frameDeltas.length >= 2) {
    const width = 500;
    const height = 120;
    const padding = 20;
    const minVal = Math.max(0, Math.min(...frameDeltas) * 0.8);
    const maxVal = Math.max(20, Math.max(...frameDeltas) * 1.2);
    const range = maxVal - minVal || 1;

    const points = frameDeltas.map((v, i) => {
      const x = padding + (i / (frameDeltas.length - 1)) * (width - padding * 2);
      const y = height - padding - ((v - minVal) / range) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    const line60y = height - padding - ((16.67 - minVal) / range) * (height - padding * 2);

    sparklineSvg = `
      <svg viewBox="0 0 ${width} ${height}" class="chart-svg">
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        ${line60y >= padding && line60y <= height - padding ? `
          <line x1="${padding}" y1="${line60y}" x2="${width - padding}" y2="${line60y}" stroke="#64748b" stroke-dasharray="4 4" stroke-width="1"/>
          <text x="${width - padding}" y="${line60y - 4}" fill="#94a3b8" font-size="10" text-anchor="end">16.67ms (60 FPS)</text>
        ` : ""}
        <polyline points="${points}" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        ${frameDeltas.map((v, i) => {
          const x = padding + (i / (frameDeltas.length - 1)) * (width - padding * 2);
          const y = height - padding - ((v - minVal) / range) * (height - padding * 2);
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="#60a5fa" stroke="#0f172a" stroke-width="1.5"/>`;
        }).join("")}
      </svg>
    `;
  }

  // Recommendations HTML
  const recCards = recs.map((r, idx) => {
    const sevBadge = r.severity === "critical" ? "sev-critical" : r.severity === "warning" ? "sev-warning" : "sev-info";
    const catBadge = r.category || "general";
    return `
      <div class="rec-card" data-category="${catBadge}" data-severity="${r.severity}">
        <div class="rec-header">
          <span class="badge ${sevBadge}">${r.severity.toUpperCase()}</span>
          <span class="badge badge-cat">${catBadge.toUpperCase()}</span>
          <h3 class="rec-title">${escapeHtml(r.title)}</h3>
        </div>
        <div class="rec-body">
          <div class="rec-field">
            <span class="rec-label">Evidence:</span>
            <span class="rec-text evidence">${escapeHtml(r.evidence)}</span>
          </div>
          <div class="rec-field">
            <span class="rec-label">Actionable Solution:</span>
            <span class="rec-text action">${escapeHtml(r.action)}</span>
          </div>
        </div>
      </div>
    `;
  }).join("\n");

  // Slow frames table
  let slowFramesHtml = "";
  if (slowFrames.length > 0) {
    slowFramesHtml = `
      <section class="section">
        <h2>⚠️ Slow Frame Timeline (${slowFrames.length} captured)</h2>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Time (ms)</th>
                <th>Frame Duration</th>
                <th>Render Passes</th>
                <th>Compute Passes</th>
                <th>Draw Calls</th>
                <th>Dispatches</th>
                <th>Sync Pipelines</th>
                <th>New BindGroups</th>
              </tr>
            </thead>
            <tbody>
              ${slowFrames.map(f => `
                <tr>
                  <td>${Math.round(f.timestamp)}ms</td>
                  <td class="bad">${f.frameDurationMs.toFixed(1)}ms</td>
                  <td>${f.stats?.renderPasses ?? "—"}</td>
                  <td>${f.stats?.computePasses ?? "—"}</td>
                  <td>${f.stats?.drawCalls ?? "—"}</td>
                  <td>${f.stats?.dispatchCalls ?? "—"}</td>
                  <td>${f.stats?.syncPipelines ?? "—"}</td>
                  <td>${f.stats?.bindGroupsCreated ?? "—"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>WebGPU Optimizer Report — ${escapeHtml(url)}</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #131b2e;
      --card-border: #1e293b;
      --card-hover: #1e2942;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --emerald: #10b981;
      --amber: #f59e0b;
      --rose: #ef4444;
      --radius: 12px;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.5;
      padding: 32px 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 20px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 32px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-icon {
      width: 40px; height: 40px; border-radius: 10px;
      background: linear-gradient(135deg, #2563eb, #38bdf8);
      display: flex; align-items: center; justify-content: center;
      color: white; font-weight: bold; font-family: var(--mono);
    }
    .brand h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
    .brand-url { font-family: var(--mono); font-size: 13px; color: var(--text-muted); word-break: break-all; }
    .header-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .verdict-badge {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 16px; border-radius: 9999px;
      font-weight: 700; font-size: 14px; text-transform: uppercase;
      letter-spacing: 0.05em;
      background: rgba(255,255,255,0.05);
      border: 1px solid currentColor;
    }
    .meta-time { font-size: 12px; color: var(--text-muted); font-family: var(--mono); }
    .adapter-badge {
      font-size: 12px; font-family: var(--mono); color: var(--text-muted);
      background: rgba(255,255,255,0.04); padding: 4px 10px; border-radius: 6px;
    }

    /* Grid cards */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .metric-title { font-size: 13px; color: var(--text-muted); font-weight: 500; margin-bottom: 8px; }
    .metric-val { font-size: 28px; font-weight: 800; font-family: var(--mono); letter-spacing: -0.03em; }
    .metric-val.good { color: var(--emerald); }
    .metric-val.warn { color: var(--amber); }
    .metric-val.bad { color: var(--rose); }
    .metric-sub { font-size: 12px; color: var(--text-muted); margin-top: 8px; font-family: var(--mono); }

    /* Visualizations */
    .chart-container {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 24px;
      margin-bottom: 32px;
    }
    .chart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .chart-header h2 { font-size: 16px; font-weight: 600; }
    .chart-svg { width: 100%; height: auto; display: block; overflow: visible; }

    /* Recommendations */
    .section { margin-bottom: 32px; }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
    }
    .section-header h2 { font-size: 18px; font-weight: 700; }
    .filters { display: flex; gap: 8px; flex-wrap: wrap; }
    .filter-btn {
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .filter-btn:hover, .filter-btn.active {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
    }
    .search-input {
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      outline: none;
      width: 200px;
    }
    .search-input:focus { border-color: var(--primary); }

    .rec-list { display: flex; flex-direction: column; gap: 12px; }
    .rec-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 16px 20px;
      transition: border-color 0.15s ease;
    }
    .rec-card:hover { border-color: #334155; }
    .rec-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .badge {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      padding: 3px 8px; border-radius: 4px; font-family: var(--mono);
    }
    .sev-critical { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    .sev-warning { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .sev-info { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }
    .badge-cat { background: rgba(255,255,255,0.05); color: var(--text-muted); }
    .rec-title { font-size: 15px; font-weight: 600; }
    .rec-body { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
    .rec-field { display: flex; gap: 8px; align-items: baseline; }
    .rec-label { color: var(--text-muted); font-weight: 600; min-width: 130px; font-size: 12px; }
    .rec-text.evidence { color: #cbd5e1; }
    .rec-text.action { color: #60a5fa; font-weight: 500; }

    /* Tables */
    .table-container {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      overflow-x: auto;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; font-family: var(--mono); }
    th { padding: 12px 16px; background: rgba(255,255,255,0.02); color: var(--text-muted); font-size: 11px; text-transform: uppercase; border-bottom: 1px solid var(--card-border); }
    td { padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,0.03); }
    tr:last-child td { border-bottom: none; }
    td.bad { color: var(--rose); font-weight: 600; }

    /* JSON Drawer */
    details {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 16px;
      margin-top: 32px;
    }
    summary { font-weight: 600; cursor: pointer; color: var(--text-muted); outline: none; }
    summary:hover { color: var(--text); }
    pre {
      margin-top: 12px;
      padding: 16px;
      background: #060911;
      border-radius: 8px;
      overflow-x: auto;
      font-family: var(--mono);
      font-size: 12px;
      color: #cbd5e1;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">GPU</div>
        <div>
          <h1>WebGPU Performance Report</h1>
          <div class="brand-url">${escapeHtml(url)}</div>
        </div>
      </div>
      <div class="header-meta">
        <div class="verdict-badge" style="color: ${verdictColor};">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:currentColor"></span>
          VERDICT: ${escapeHtml(verdict.toUpperCase())}
        </div>
        <div class="adapter-badge">${escapeHtml(adapterDesc)}</div>
        <div class="meta-time">${new Date(timestamp).toLocaleString()}</div>
      </div>
    </header>

    <div class="metrics-grid">
      <!-- Frame Rate & Cadence -->
      <div class="metric-card">
        <div class="metric-title">FRAME RATE & CADENCE</div>
        <div class="metric-val ${fps != null && fps >= 58 ? "good" : fps != null && fps >= 45 ? "warn" : "bad"}">
          ${fps != null ? fps.toFixed(1) : "--"} <span style="font-size:16px;color:var(--text-muted)">FPS</span>
        </div>
        <div class="metric-sub">
          ${cadence ? `Target: ${cadence.hz} Hz (${cadence.intervalMs}ms)${cadence.hitRate != null ? ` · ${(cadence.hitRate * 100).toFixed(1)}% hits` : ""}` : "Uncapped / VSync"}
        </div>
      </div>

      <!-- Frame Time -->
      <div class="metric-card">
        <div class="metric-title">FRAME TIME (CPU/GPU)</div>
        <div class="metric-val ${frameTimeMean != null && frameTimeMean <= 16.7 ? "good" : "warn"}">
          ${frameTimeMean != null ? frameTimeMean.toFixed(2) : "--"} <span style="font-size:16px;color:var(--text-muted)">ms</span>
        </div>
        <div class="metric-sub">
          p95: ${frameTimeP95 != null ? frameTimeP95.toFixed(1) : "--"}ms · p99: ${frameTimeP99 != null ? frameTimeP99.toFixed(1) : "--"}ms${maxJitter != null ? ` · jitter ${maxJitter.toFixed(1)}ms` : ""}
        </div>
      </div>

      <!-- GPU Execution Time -->
      <div class="metric-card">
        <div class="metric-title">GPU EXECUTION TIME</div>
        <div class="metric-val ${gpuFrameMs != null && gpuFrameMs <= 13 ? "good" : "warn"}">
          ${gpuFrameMs != null ? gpuFrameMs.toFixed(2) : "--"} <span style="font-size:16px;color:var(--text-muted)">ms</span>
        </div>
        <div class="metric-sub">
          ${computeMs != null ? `Compute: ${computeMs.toFixed(2)}ms · ` : ""}${renderMs != null ? `Render: ${renderMs.toFixed(2)}ms` : "Timestamp query supported"}
        </div>
      </div>

      <!-- VRAM Memory -->
      <div class="metric-card">
        <div class="metric-title">TRACKED GPU VRAM</div>
        <div class="metric-val ${totalVramMiB < 250 ? "good" : totalVramMiB < 500 ? "warn" : "bad"}">
          ${totalVramMiB.toFixed(1)} <span style="font-size:16px;color:var(--text-muted)">MiB</span>
        </div>
        <div class="metric-sub">
          Textures: ${textureMiB.toFixed(1)} MiB (${textureCount}) · Buffers: ${bufferMiB.toFixed(1)} MiB (${bufferCount})
        </div>
      </div>

      <!-- Pipelines -->
      <div class="metric-card">
        <div class="metric-title">PIPELINES & SHADERS</div>
        <div class="metric-val ${syncPipelines === 0 ? "good" : "bad"}">
          ${syncPipelines} <span style="font-size:16px;color:var(--text-muted)">sync stalls</span>
        </div>
        <div class="metric-sub">
          Async pipelines: ${asyncPipelines} · Shader modules: ${shaderModules}
        </div>
      </div>

      <!-- WebGPU Operations -->
      <div class="metric-card">
        <div class="metric-title">WEBGPU OPS / FRAME</div>
        <div class="metric-val ${drawCalls != null && drawCalls < 200 ? "good" : "warn"}">
          ${drawCalls != null ? Math.round(drawCalls) : "--"} <span style="font-size:16px;color:var(--text-muted)">draws</span>
        </div>
        <div class="metric-sub">
          Dispatches: ${dispatchCalls != null ? Math.round(dispatchCalls) : "0"} · BindGroups created: ${bindGroupsCreated}
        </div>
      </div>
    </div>

    ${sparklineSvg ? `
      <div class="chart-container">
        <div class="chart-header">
          <h2>Frame Time Stability Across Samples</h2>
          <span style="font-size:12px;color:var(--text-muted);font-family:var(--mono)">Lower and flatter is better</span>
        </div>
        ${sparklineSvg}
      </div>
    ` : ""}

    <!-- Recommendations Section -->
    <section class="section">
      <div class="section-header">
        <h2>Optimization Recommendations (${recs.length})</h2>
        <div class="filters">
          <input type="text" class="search-input" id="searchInput" placeholder="Search recommendations..."/>
          <button class="filter-btn active" data-filter="all">All (${recs.length})</button>
          <button class="filter-btn" data-filter="critical">Critical (${recs.filter(r => r.severity === "critical").length})</button>
          <button class="filter-btn" data-filter="warning">Warning (${recs.filter(r => r.severity === "warning").length})</button>
          <button class="filter-btn" data-filter="pipeline">Pipeline</button>
          <button class="filter-btn" data-filter="memory">Memory</button>
        </div>
      </div>

      <div class="rec-list" id="recList">
        ${recCards.length > 0 ? recCards : `<div style="padding:24px;text-align:center;color:var(--text-muted)">✨ No performance bottlenecks detected. Excellent work!</div>`}
      </div>
    </section>

    ${slowFramesHtml}

    <details>
      <summary>View Complete JSON Report</summary>
      <pre><code>${escapeHtml(JSON.stringify(report, null, 2))}</code></pre>
    </details>
  </div>

  <script>
    // Filter recommendations by category / severity / search
    const filterBtns = document.querySelectorAll('.filter-btn');
    const searchInput = document.getElementById('searchInput');
    const recCards = document.querySelectorAll('.rec-card');

    let activeFilter = 'all';
    let searchQuery = '';

    function applyFilter() {
      recCards.forEach(card => {
        const cat = card.getAttribute('data-category');
        const sev = card.getAttribute('data-severity');
        const text = card.textContent.toLowerCase();

        const matchesFilter = activeFilter === 'all' || activeFilter === sev || activeFilter === cat;
        const matchesSearch = !searchQuery || text.includes(searchQuery);

        card.style.display = matchesFilter && matchesSearch ? 'block' : 'none';
      });
    }

    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.getAttribute('data-filter');
        applyFilter();
      });
    });

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase().trim();
        applyFilter();
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
