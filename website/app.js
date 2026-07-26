const copyButtons = document.querySelectorAll("[data-copy-target]");

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const targetId = button.getAttribute("data-copy-target");
    const target = targetId ? document.getElementById(targetId) : null;
    const container = button.closest(".code-window, .quickstart-command");
    const status = container?.querySelector(".copy-status");

    if (!target || !navigator.clipboard) {
      if (status) status.textContent = "Copy unavailable — select the text.";
      return;
    }

    try {
      await navigator.clipboard.writeText(target.textContent ?? "");
      if (status) status.textContent = "Copied to clipboard.";
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy";
        if (status) status.textContent = "";
      }, 1800);
    } catch {
      if (status) status.textContent = "Copy unavailable — select the text.";
    }
  });
}
