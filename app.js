const storageKey = "smartbudget:v1";
const shekel = new Intl.NumberFormat("he-IL", {
  style: "currency",
  currency: "ILS",
  maximumFractionDigits: 0,
});

const state = loadState();

const els = {
  activeMonth: document.querySelector("#activeMonth"),
  incomeForm: document.querySelector("#incomeForm"),
  incomeInput: document.querySelector("#incomeInput"),
  deductionForm: document.querySelector("#deductionForm"),
  expenseForm: document.querySelector("#expenseForm"),
  deductionsList: document.querySelector("#deductionsList"),
  expensesList: document.querySelector("#expensesList"),
  categoryBreakdown: document.querySelector("#categoryBreakdown"),
  plannedBalance: document.querySelector("#plannedBalance"),
  actualBalance: document.querySelector("#actualBalance"),
  incomeMetric: document.querySelector("#incomeMetric"),
  fixedMetric: document.querySelector("#fixedMetric"),
  expenseMetric: document.querySelector("#expenseMetric"),
  fixedMeter: document.querySelector("#fixedMeter"),
  balanceMessage: document.querySelector("#balanceMessage"),
  deductionCount: document.querySelector("#deductionCount"),
  expenseCount: document.querySelector("#expenseCount"),
  resetMonth: document.querySelector("#resetMonth"),
  emptyTemplate: document.querySelector("#emptyTemplate"),
};

init();

function init() {
  if (!state.activeMonth) {
    state.activeMonth = getCurrentMonth();
  }

  els.activeMonth.value = state.activeMonth;
  ensureMonth(state.activeMonth);
  bindEvents();
  render();
}

function bindEvents() {
  els.activeMonth.addEventListener("change", () => {
    state.activeMonth = els.activeMonth.value || getCurrentMonth();
    ensureMonth(state.activeMonth);
    saveState();
    render();
  });

  els.incomeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const month = getMonthData();
    month.income = readMoney(els.incomeInput.value);
    saveState();
    render();
  });

  els.deductionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(els.deductionForm);
    const amount = readMoney(form.get("amount"));

    if (!amount) return;

    state.deductions.push({
      id: createId(),
      name: cleanText(form.get("name")),
      amount,
      day: clampDay(form.get("day")),
      category: cleanText(form.get("category")),
      active: true,
    });

    els.deductionForm.reset();
    saveState();
    render();
  });

  els.expenseForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(els.expenseForm);
    const amount = readMoney(form.get("amount"));

    if (!amount) return;

    getMonthData().expenses.push({
      id: createId(),
      name: cleanText(form.get("name")),
      amount,
      category: cleanText(form.get("category")),
      createdAt: new Date().toISOString(),
    });

    els.expenseForm.reset();
    saveState();
    render();
  });

  els.resetMonth.addEventListener("click", () => {
    const month = getMonthData();
    if (!month.income && month.expenses.length === 0) return;

    month.income = 0;
    month.expenses = [];
    saveState();
    render();
  });
}

function render() {
  const month = getMonthData();
  const activeDeductions = state.deductions.filter((item) => item.active);
  const fixedTotal = sum(activeDeductions);
  const expenseTotal = sum(month.expenses);
  const plannedBalance = month.income - fixedTotal;
  const actualBalance = plannedBalance - expenseTotal;

  els.incomeInput.value = month.income || "";
  els.incomeMetric.textContent = money(month.income);
  els.fixedMetric.textContent = money(fixedTotal);
  els.expenseMetric.textContent = money(expenseTotal);
  els.plannedBalance.textContent = money(plannedBalance);
  els.actualBalance.textContent = money(actualBalance);
  els.deductionCount.textContent = String(state.deductions.length);
  els.expenseCount.textContent = String(month.expenses.length);
  els.fixedMeter.style.width = `${getSpendRatio(fixedTotal, month.income)}%`;

  els.plannedBalance.classList.toggle("negative", plannedBalance < 0);
  els.actualBalance.classList.toggle("negative", actualBalance < 0);
  els.actualBalance.classList.toggle("positive", actualBalance > 0);
  els.balanceMessage.textContent = getBalanceMessage(month.income, fixedTotal, expenseTotal, actualBalance);

  renderDeductions();
  renderExpenses();
  renderBreakdown(activeDeductions, month.expenses);
}

function renderDeductions() {
  els.deductionsList.replaceChildren();

  if (!state.deductions.length) {
    els.deductionsList.append(emptyNode("הוסף הורדות קבועות כדי לראות כמה נשאר לך מיד אחרי המשכורת."));
    return;
  }

  const sorted = [...state.deductions].sort((a, b) => a.day - b.day || a.name.localeCompare(b.name, "he"));
  sorted.forEach((item) => {
    els.deductionsList.append(
      itemNode({
        title: item.name,
        meta: [`${item.category}`, `יום ${item.day || 1}`],
        amount: item.amount,
        active: item.active,
        onToggle: () => toggleDeduction(item.id),
        onDelete: () => deleteDeduction(item.id),
      }),
    );
  });
}

function renderExpenses() {
  const expenses = getMonthData().expenses;
  els.expensesList.replaceChildren();

  if (!expenses.length) {
    els.expensesList.append(emptyNode("כאן אפשר להוסיף הוצאות חד-פעמיות של החודש כדי לעקוב אחרי היתרה בפועל."));
    return;
  }

  expenses
    .slice()
    .reverse()
    .forEach((item) => {
      els.expensesList.append(
        itemNode({
          title: item.name,
          meta: [item.category, formatDate(item.createdAt)],
          amount: item.amount,
          onDelete: () => deleteExpense(item.id),
        }),
      );
    });
}

function renderBreakdown(deductions, expenses) {
  const totals = new Map();

  [...deductions, ...expenses].forEach((item) => {
    totals.set(item.category, (totals.get(item.category) || 0) + item.amount);
  });

  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] || 0;
  els.categoryBreakdown.replaceChildren();

  if (!rows.length) {
    els.categoryBreakdown.append(emptyNode("אין עדיין נתונים לפירוט. ההורדות וההוצאות יופיעו כאן לפי קטגוריה."));
    return;
  }

  rows.forEach(([category, total]) => {
    const node = document.createElement("article");
    node.className = "breakdown-item";
    node.innerHTML = `
      <span>${escapeHtml(category)}</span>
      <strong>${money(total)}</strong>
      <div class="mini-meter" aria-hidden="true"><i style="width: ${getSpendRatio(total, max)}%"></i></div>
    `;
    els.categoryBreakdown.append(node);
  });
}

function itemNode({ title, meta, amount, active, onToggle, onDelete }) {
  const node = document.createElement("article");
  node.className = "budget-item";

  const info = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = title;
  const metaRow = document.createElement("div");
  metaRow.className = "item-meta";
  meta.forEach((value) => {
    const span = document.createElement("span");
    span.textContent = value;
    metaRow.append(span);
  });
  info.append(heading, metaRow);

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const amountEl = document.createElement("span");
  amountEl.className = "amount";
  amountEl.textContent = money(amount);
  actions.append(amountEl);

  if (onToggle) {
    const toggle = document.createElement("button");
    toggle.className = `toggle ${active ? "active" : ""}`;
    toggle.type = "button";
    toggle.setAttribute("aria-label", active ? "השבתת הורדה קבועה" : "הפעלת הורדה קבועה");
    toggle.addEventListener("click", onToggle);
    actions.append(toggle);
  }

  const remove = document.createElement("button");
  remove.className = "icon-button danger";
  remove.type = "button";
  remove.setAttribute("aria-label", "מחיקה");
  remove.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M10 11v6M14 11v6M6 6l1 14h10l1-14"/></svg>`;
  remove.addEventListener("click", onDelete);
  actions.append(remove);

  node.append(info, actions);
  return node;
}

function emptyNode(text) {
  const node = els.emptyTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector("p").textContent = text;
  return node;
}

function toggleDeduction(id) {
  const item = state.deductions.find((deduction) => deduction.id === id);
  if (!item) return;
  item.active = !item.active;
  saveState();
  render();
}

function deleteDeduction(id) {
  state.deductions = state.deductions.filter((item) => item.id !== id);
  saveState();
  render();
}

function deleteExpense(id) {
  const month = getMonthData();
  month.expenses = month.expenses.filter((item) => item.id !== id);
  saveState();
  render();
}

function getBalanceMessage(income, fixedTotal, expenseTotal, balance) {
  if (!income && !fixedTotal && !expenseTotal) {
    return "כשתוסיף משכורת והורדות, אחשב את התמונה החודשית.";
  }
  if (balance < 0) {
    return `החודש בחריגה של ${money(Math.abs(balance))}. כדאי לבדוק אילו הוצאות אפשר לדחות.`;
  }
  if (balance === 0) {
    return "התקציב מאוזן בדיוק. אין כרית ביטחון אחרי ההוצאות.";
  }
  return `נשארו לך ${money(balance)} אחרי ההורדות וההוצאות שנרשמו.`;
}

function getMonthData() {
  ensureMonth(state.activeMonth);
  return state.months[state.activeMonth];
}

function ensureMonth(monthKey) {
  if (!state.months[monthKey]) {
    state.months[monthKey] = { income: 0, expenses: [] };
  }
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return {
      activeMonth: saved?.activeMonth || getCurrentMonth(),
      deductions: Array.isArray(saved?.deductions) ? saved.deductions : [],
      months: saved?.months && typeof saved.months === "object" ? saved.months : {},
    };
  } catch {
    return { activeMonth: getCurrentMonth(), deductions: [], months: {} };
  }
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function sum(items) {
  return items.reduce((total, item) => total + Number(item.amount || 0), 0);
}

function money(value) {
  return shekel.format(Math.round(Number(value || 0)));
}

function readMoney(value) {
  return Math.max(0, Number.parseFloat(value) || 0);
}

function cleanText(value) {
  return String(value || "").trim();
}

function clampDay(value) {
  const day = Number.parseInt(value, 10);
  if (!Number.isFinite(day)) return 1;
  return Math.min(31, Math.max(1, day));
}

function getSpendRatio(value, total) {
  if (!total) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit" }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
