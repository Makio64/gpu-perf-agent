// Installation and usage stay readable without JavaScript.
for (const button of document.querySelectorAll("[data-copy]")) {
  const originalLabel = button.getAttribute("aria-label");
  let reset;
  button.hidden = false;
  button.addEventListener("click", async () => {
    const code = document.getElementById(button.dataset.copy);
    const status = document.getElementById("copy-status");
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
      button.textContent = "Copied";
      status.textContent = `${originalLabel.replace(/^Copy /, "")} copied to clipboard.`;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "Selected";
      status.textContent = "Clipboard unavailable. Text selected; use your keyboard to copy it.";
    }
    clearTimeout(reset);
    reset = setTimeout(() => { button.textContent = "Copy"; }, 1800);
  });
}
