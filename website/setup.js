const PACKAGE_VERSION = "0.3.8";
const STORAGE_KEY = "hayasend-operator-workspace-v1";
const STEP_IDS = Object.freeze([
  "identity",
  "deploy",
  "access",
  "verify",
  "operate",
  "update",
  "remove",
]);

const elements = Object.freeze({
  account: document.getElementById("aws-account"),
  profile: document.getElementById("aws-profile"),
  region: document.getElementById("aws-region"),
  stack: document.getElementById("stack-name"),
  environment: document.getElementById("environment"),
  restoreTesting: document.getElementById("restore-testing"),
  sendingDomain: document.getElementById("sending-domain"),
  applicationKeyName: document.getElementById("application-key-name"),
  accountValidation: document.getElementById("account-validation"),
  contextStatus: document.getElementById("context-status"),
  progressCount: document.getElementById("progress-count"),
  progressTrack: document.querySelector(".progress-track"),
  progressValue: document.getElementById("progress-value"),
  reset: document.getElementById("reset-workspace"),
});

const defaults = Object.freeze({
  account: "",
  profile: "",
  region: "ap-northeast-1",
  stack: "hayasend",
  environment: "production",
  restoreTesting: true,
  sendingDomain: "mail.example.com",
  applicationKeyName: "production-transactional",
  completed: {},
});

function safeStorageRead() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function safeStorageWrite(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // The workspace remains fully usable when browser storage is unavailable.
  }
}

function safeStorageRemove() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // There may be no persisted state to remove.
  }
}

function inputValue(element, fallback) {
  return element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement
    ? element.value.trim()
    : fallback;
}

function checkedValue(element, fallback) {
  return element instanceof HTMLInputElement ? element.checked : fallback;
}

function currentState() {
  const completed = {};
  for (const control of document.querySelectorAll("[data-step-complete]")) {
    if (control instanceof HTMLInputElement && control.dataset.stepComplete) {
      completed[control.dataset.stepComplete] = control.checked;
    }
  }
  return {
    account: inputValue(elements.account, ""),
    profile: inputValue(elements.profile, ""),
    region: inputValue(elements.region, defaults.region),
    stack: inputValue(elements.stack, defaults.stack),
    environment: inputValue(elements.environment, defaults.environment),
    restoreTesting: checkedValue(
      elements.restoreTesting,
      defaults.restoreTesting,
    ),
    sendingDomain: inputValue(
      elements.sendingDomain,
      defaults.sendingDomain,
    ),
    applicationKeyName: inputValue(
      elements.applicationKeyName,
      defaults.applicationKeyName,
    ),
    completed,
  };
}

function setValue(element, value) {
  if (
    (element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement) &&
    typeof value === "string"
  ) {
    element.value = value;
  }
}

function applyState(state) {
  setValue(elements.account, state.account ?? defaults.account);
  setValue(elements.profile, state.profile ?? defaults.profile);
  setValue(elements.region, state.region ?? defaults.region);
  setValue(elements.stack, state.stack ?? defaults.stack);
  setValue(
    elements.environment,
    state.environment ?? defaults.environment,
  );
  setValue(
    elements.sendingDomain,
    state.sendingDomain ?? defaults.sendingDomain,
  );
  setValue(
    elements.applicationKeyName,
    state.applicationKeyName ?? defaults.applicationKeyName,
  );
  if (elements.restoreTesting instanceof HTMLInputElement) {
    elements.restoreTesting.checked =
      typeof state.restoreTesting === "boolean"
        ? state.restoreTesting
        : defaults.restoreTesting;
  }
  for (const control of document.querySelectorAll("[data-step-complete]")) {
    if (control instanceof HTMLInputElement && control.dataset.stepComplete) {
      control.checked = state.completed?.[control.dataset.stepComplete] === true;
    }
  }
}

function validateState(state) {
  const errors = [];
  if (!/^\d{12}$/.test(state.account)) {
    errors.push("Enter the exact 12-digit AWS account.");
  }
  if (state.profile && !/^[A-Za-z0-9_+=,.@-]{1,128}$/.test(state.profile)) {
    errors.push("AWS profile contains unsupported characters.");
  }
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(state.stack)) {
    errors.push("Stack name must start with a letter and use letters, digits, or hyphens.");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(state.sendingDomain)) {
    errors.push("Sending domain must be a complete DNS name.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(state.applicationKeyName)) {
    errors.push("Application key name contains unsupported characters.");
  }
  return errors;
}

function targetTokens(state, operation) {
  return [
    "npx",
    "--yes",
    `@haya-inc/hayasend@${PACKAGE_VERSION}`,
    operation,
    "aws",
    "--account",
    state.account,
    "--region",
    state.region,
    "--stack",
    state.stack,
    ...(state.profile ? ["--profile", state.profile] : []),
  ];
}

function bootstrapTokens(state) {
  return [
    "npx",
    "--yes",
    `@haya-inc/hayasend@${PACKAGE_VERSION}`,
    "bootstrap",
    "aws",
    "--account",
    state.account,
    "--region",
    state.region,
    ...(state.profile ? ["--profile", state.profile] : []),
  ];
}

function quoteToken(token) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(token)
    ? token
    : `'${token.replaceAll("'", `'"'"'`)}'`;
}

function formatCommand(tokens) {
  const head = tokens.slice(0, 5).map(quoteToken).join(" ");
  const tail = tokens.slice(5);
  const lines = [head];
  for (let index = 0; index < tail.length; index += 2) {
    lines.push(`  ${tail.slice(index, index + 2).map(quoteToken).join(" ")}`);
  }
  return lines.join(" \\\n");
}

function setCommand(id, value, runnable) {
  const output = document.getElementById(id);
  if (output) output.textContent = value;
  const button = document.querySelector(`[data-copy-target="${id}"]`);
  if (button instanceof HTMLButtonElement) button.disabled = !runnable;
}

function renderCommands(state, valid) {
  const placeholderState = {
    ...state,
    account: valid ? state.account : "AWS_ACCOUNT_ID_REQUIRED",
    stack: /^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(state.stack)
      ? state.stack
      : defaults.stack,
    profile: /^[A-Za-z0-9_+=,.@-]{1,128}$/.test(state.profile)
      ? state.profile
      : "",
  };
  const bootstrapPlan = bootstrapTokens(placeholderState);
  const deployPlan = [
    ...targetTokens(placeholderState, "deploy"),
    "--tag",
    `Environment=${state.environment}`,
    ...(state.restoreTesting ? ["--enable-restore-testing"] : []),
  ];
  const status = [
    ...targetTokens(placeholderState, "status"),
    "--detect-drift",
  ];
  const upgradePlan = targetTokens(placeholderState, "upgrade");
  const cleanupPlan = targetTokens(placeholderState, "cleanup");

  setCommand(
    "bootstrap-plan-command",
    formatCommand(bootstrapPlan),
    valid,
  );
  setCommand(
    "bootstrap-apply-command",
    formatCommand([
      ...bootstrapPlan,
      "--apply",
      "--confirm-account",
      placeholderState.account,
    ]),
    valid,
  );
  setCommand("deploy-plan-command", formatCommand(deployPlan), valid);
  setCommand(
    "deploy-apply-command",
    formatCommand([...deployPlan, "--apply"]),
    valid,
  );
  setCommand("status-command", formatCommand(status), valid);
  setCommand(
    "upgrade-plan-command",
    formatCommand(upgradePlan),
    valid,
  );
  setCommand(
    "upgrade-apply-command",
    formatCommand([...upgradePlan, "--apply"]),
    valid,
  );
  setCommand("cleanup-plan-command", formatCommand(cleanupPlan), valid);
  setCommand(
    "cleanup-apply-command",
    formatCommand([
      ...cleanupPlan,
      "--apply",
      "--confirm-stack",
      placeholderState.stack,
      "--disable-termination-protection",
    ]),
    valid,
  );

  const apiGuard = [
    ': "${HAYASEND_BASE_URL:?set from the deploy output}"',
    ': "${HAYASEND_API_KEY:?read an approved scoped key from your secret manager}"',
  ];
  setCommand(
    "domain-command",
    [
      ...apiGuard,
      `npx --yes @haya-inc/hayasend@${PACKAGE_VERSION} domains create --name ${quoteToken(state.sendingDomain)}`,
    ].join("\n"),
    valid,
  );
  setCommand(
    "key-command",
    [
      ': "${HAYASEND_BASE_URL:?set from the deploy output}"',
      ': "${HAYASEND_API_KEY:?read the bootstrap administrator key from your secret manager}"',
      formatCommand([
        "npx",
        "--yes",
        `@haya-inc/hayasend@${PACKAGE_VERSION}`,
        "keys",
        "create",
        "--name",
        state.applicationKeyName,
        "--scope",
        "emails:send",
        "--scope",
        "emails:read",
        "--token-out",
        `./${state.applicationKeyName}.token`,
      ]),
    ].join("\n"),
    valid,
  );
  setCommand(
    "doctor-command",
    [
      ...apiGuard,
      `npx --yes @haya-inc/hayasend@${PACKAGE_VERSION} doctor`,
    ].join("\n"),
    true,
  );
}

function renderProgress(state) {
  let completed = 0;
  for (const stepId of STEP_IDS) {
    const step = document.querySelector(`[data-step="${stepId}"]`);
    const isComplete = state.completed?.[stepId] === true;
    if (isComplete) completed += 1;
    step?.classList.toggle("is-complete", isComplete);
  }
  if (elements.progressCount) {
    elements.progressCount.textContent = `${completed} / ${STEP_IDS.length}`;
  }
  if (elements.progressValue) {
    elements.progressValue.style.width = `${(completed / STEP_IDS.length) * 100}%`;
  }
  if (elements.progressTrack) {
    elements.progressTrack.setAttribute("aria-valuenow", String(completed));
  }
}

function render() {
  const state = currentState();
  const errors = validateState(state);
  const accountValid = /^\d{12}$/.test(state.account);
  const valid = errors.length === 0;

  if (elements.account instanceof HTMLInputElement) {
    elements.account.setAttribute("aria-invalid", String(!accountValid));
  }
  if (elements.accountValidation) {
    elements.accountValidation.textContent =
      state.account && !accountValid ? "Use exactly 12 digits." : "";
  }
  if (elements.contextStatus) {
    elements.contextStatus.textContent = valid
      ? "Context ready · commands are safe to copy for review."
      : errors[0] ?? "Review the deployment context.";
    elements.contextStatus.classList.toggle("is-ready", valid);
  }

  renderCommands(state, valid);
  renderProgress(state);
  safeStorageWrite(state);
}

for (const element of [
  elements.account,
  elements.profile,
  elements.region,
  elements.stack,
  elements.environment,
  elements.restoreTesting,
  elements.sendingDomain,
  elements.applicationKeyName,
]) {
  element?.addEventListener("input", render);
  element?.addEventListener("change", render);
}

for (const control of document.querySelectorAll("[data-step-complete]")) {
  control.addEventListener("change", render);
}

for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", async () => {
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const targetId = button.dataset.copyTarget;
    const target = targetId ? document.getElementById(targetId) : null;
    const container = button.closest(".command-block");
    const status = container?.querySelector(".command-status");
    if (!target || !navigator.clipboard) {
      if (status) status.textContent = "Copy unavailable — select the command.";
      return;
    }
    try {
      await navigator.clipboard.writeText(target.textContent ?? "");
      button.textContent = "Copied";
      if (status) status.textContent = "Copied for terminal review.";
      window.setTimeout(() => {
        button.textContent = "Copy";
        if (status) status.textContent = "";
      }, 1800);
    } catch {
      if (status) status.textContent = "Copy unavailable — select the command.";
    }
  });
}

elements.reset?.addEventListener("click", () => {
  safeStorageRemove();
  applyState(defaults);
  render();
  elements.account?.focus();
});

applyState({ ...defaults, ...safeStorageRead() });
render();
