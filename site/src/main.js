// Progressive enhancement: the page and example report are readable without JS.
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab, focus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute("aria-controls")).hidden =
      !selected;
  }
  if (focus) tab.focus();
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft")
      next = (index + tabs.length - 1) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[next], true);
  });
}
const timers = new WeakMap();
for (const button of document.querySelectorAll("[data-copy]")) {
  const label =
    button.querySelector(".copy-label") ||
    (button.classList.contains("copy-button") ? null : button);
  const original = label?.textContent;
  const originalLabel = button.getAttribute("aria-label");
  button.addEventListener("click", async () => {
    const code = document.getElementById(button.dataset.copy);
    const status = document.getElementById("copy-status");
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
      if (label) label.textContent = "Copied";
      button.setAttribute("aria-label", "Command copied");
      status.textContent = `${originalLabel.replace(/^Copy /, "")} copied to clipboard.`;
      clearTimeout(timers.get(button));
      timers.set(
        button,
        setTimeout(() => {
          if (label) label.textContent = original;
          button.setAttribute("aria-label", originalLabel);
        }, 1800),
      );
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent =
        "Clipboard unavailable. Command selected; use your keyboard to copy it.";
      if (label) label.textContent = "Selected";
    }
  });
}
