import { Wasmer } from "@wasmer/sdk/browser";

const DEFAULT_CODE = `from datetime import datetime
import math

print("Hello from Python in your browser!")
print("The time is", datetime.now().strftime("%H:%M:%S"))

for number in range(1, 6):
    print(f"sqrt({number}) = {math.sqrt(number):.3f}")`;

const editor = document.querySelector("#editor");
const output = document.querySelector("#output");
const runButton = document.querySelector("#run");
const clearButton = document.querySelector("#clear");
const statusDot = document.querySelector("#status-dot");
const statusText = document.querySelector("#status-text");
const executionState = document.querySelector("#execution-state");
const executionTime = document.querySelector("#execution-time");
const codeStats = document.querySelector("#code-stats");

const wasmer = new Wasmer();
let sandboxPromise;
let dependenciesPromise;
let running = false;

editor.value = localStorage.getItem("python-browser-lab-code") ?? DEFAULT_CODE;
updateCodeStats();

function getSandbox() {
  if (!sandboxPromise) {
    setRuntimeStatus("loading", "Downloading Python runtime…");
    sandboxPromise = wasmer.sandboxes
      .create({
        packages: ["python/python"],
        network: {
          mode: "wisp",
          url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`,
        },
        env: {
          PIP_EXTRA_INDEX_URL: "https://python-registry.wasmer.app/simple/",
          PIP_PLATFORM: "wasix_wasm32",
          PIP_ONLY_BINARY: ":all:",
          PIP_TARGET: "/workspace/site-packages",
          PYTHONPATH: "/workspace/site-packages",
        },
      })
      .then((sandbox) => {
        setRuntimeStatus("ready", "Python runtime ready");
        return sandbox;
      })
      .catch((error) => {
        sandboxPromise = undefined;
        setRuntimeStatus("error", "Runtime failed to load");
        throw error;
      });
  }

  return sandboxPromise;
}

function installDependencies(sandbox) {
  dependenciesPromise ??= sandbox
    .command("python", ["-m", "pip", "install", "numpy"])
    .run()
    .catch((error) => {
      dependenciesPromise = undefined;
      throw error;
    });

  return dependenciesPromise;
}

function setRuntimeStatus(state, message) {
  statusDot.dataset.state = state;
  statusText.textContent = message;
}

function updateCodeStats() {
  const lines = editor.value.split("\n").length;
  const characters = editor.value.length;
  codeStats.textContent = `${lines} ${lines === 1 ? "line" : "lines"} · ${characters} chars`;
}

function formatError(error) {
  if (error && typeof error === "object" && "output" in error) {
    const stdout = error.output?.stdout?.text?.() ?? "";
    const stderr = error.output?.stderr?.text?.() ?? "";
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  }

  return error instanceof Error ? error.message : String(error);
}

async function runCode() {
  if (running) return;

  running = true;
  runButton.disabled = true;
  executionState.textContent = "Running";
  executionState.dataset.state = "running";
  executionTime.textContent = "—";
  output.textContent = "Starting Python…";

  const startedAt = performance.now();

  try {
    const sandbox = await getSandbox();
    // sandbox.fs is rooted at the guest's /workspace directory.
    output.textContent = "Installing NumPy…";
    await installDependencies(sandbox);
    await sandbox.fs.writeText("/main.py", editor.value);

    const result = await sandbox
      .command("python", ["/workspace/main.py"])
      .run();

    output.textContent = result.text() || "Process completed without output.";
    executionState.textContent = `Exited ${result.exitCode}`;
    executionState.dataset.state = result.ok ? "success" : "error";
  } catch (error) {
    output.textContent = formatError(error) || "Python execution failed.";
    executionState.textContent = "Failed";
    executionState.dataset.state = "error";
  } finally {
    const duration = performance.now() - startedAt;
    executionTime.textContent = duration < 1000
      ? `${Math.round(duration)} ms`
      : `${(duration / 1000).toFixed(2)} s`;
    running = false;
    runButton.disabled = false;
  }
}

editor.addEventListener("input", () => {
  localStorage.setItem("python-browser-lab-code", editor.value);
  updateCodeStats();
});

editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.setRangeText("    ", start, end, "end");
    editor.dispatchEvent(new Event("input"));
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    void runCode();
  }
});

runButton.addEventListener("click", () => void runCode());

clearButton.addEventListener("click", () => {
  output.textContent = "";
  executionState.textContent = "Idle";
  executionState.dataset.state = "";
  executionTime.textContent = "—";
});
