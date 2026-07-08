import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export async function macOSProfilerStatus() {
  if (process.platform !== "darwin") {
    return {
      available: false,
      reason: "macOS xctrace profiling is only available on darwin."
    };
  }

  const xctrace = await capture("xcrun", ["--find", "xctrace"]);
  const templates = xctrace.ok
    ? await capture("xcrun", ["xctrace", "list", "templates"])
    : null;

  return {
    available: xctrace.ok,
    templates: templates?.ok ? parseTemplates(templates.stdout) : [],
    xctracePath: xctrace.ok ? xctrace.stdout.trim() : null,
    xctraceError: xctrace.ok ? null : xctrace.stderr || xctrace.stdout
  };
}

export async function recordMacOSXctrace(options = {}) {
  if (process.platform !== "darwin") {
    throw new Error("xctrace recording is only supported on macOS.");
  }

  const target = options.url || (options.file ? pathToFileURL(path.resolve(options.file)).href : null);
  if (!target) {
    throw new Error("A target is required. Pass --url or --file.");
  }

  const chrome = options.app || defaultChromeBinary();
  const output = path.resolve(options.out || path.join("reports", `xctrace-${timestamp()}.trace`));
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "gpu-perf-agent-chrome-"));
  await mkdir(path.dirname(output), { recursive: true });

  const chromeArgs = [
    `--user-data-dir=${userDataDir}`,
    "--disable-background-timer-throttling",
    "--disable-default-apps",
    "--disable-renderer-backgrounding",
    "--enable-precise-memory-info",
    "--enable-unsafe-webgpu",
    "--enable-dawn-features=allow_unsafe_apis",
    "--no-first-run",
    target
  ];

  const args = [
    "xctrace",
    "record",
    "--template",
    options.template || "Metal System Trace",
    "--time-limit",
    options.timeLimit || "15s",
    "--output",
    output,
    "--launch",
    "--",
    chrome,
    ...chromeArgs
  ];

  await run("xcrun", args, { inherit: true });
  return {
    app: chrome,
    command: ["xcrun", ...args],
    output,
    target,
    template: options.template || "Metal System Trace"
  };
}

function defaultChromeBinary() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ];
  return candidates[0];
}

function parseTemplates(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^=+/.test(line))
    .slice(0, 200);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function capture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, ok: code === 0, stderr, stdout });
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}
