import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  addMonths,
  createEmptyMonth,
  createEmptySnapshot,
  createId,
  ensureMonth,
  formatMonthName,
  getActiveDeductionsForMonth,
  getCategoryName,
  getCurrentMonth,
  getRecentMonthKeys,
  getSpendRatio,
  isDeductionActiveForMonth,
  money,
  normalizeSnapshot,
  sum,
} from "./budgetMath";
import { LocalBudgetRepository, readLocalSnapshot, writeLocalSnapshot } from "./repositories/localBudgetRepository";
import { SupabaseBudgetRepository } from "./repositories/supabaseBudgetRepository";
import { isSupabaseConfigured, supabase } from "./supabaseClient";
import type { BudgetRepository, BudgetSnapshot, Category, FixedDeduction, MonthBudget, MonthKey, SavingsGoal } from "./types";

const localRepository = new LocalBudgetRepository();

type TabId = "overview" | "activity" | "reports" | "planning";

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [session, setSession] = useState<Session | null>(null);
  const [repository, setRepository] = useState<BudgetRepository>(localRepository);
  const [snapshot, setSnapshot] = useState<BudgetSnapshot>(() => readLocalSnapshot());
  const [status, setStatus] = useState("נטען מהדפדפן המקומי");
  const [error, setError] = useState("");
  const [authLoading, setAuthLoading] = useState(Boolean(supabase));

  useEffect(() => {
    const client = supabase;

    if (!client) {
      setAuthLoading(false);
      return;
    }

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      setAuthLoading(false);
      if (event === "SIGNED_IN") setStatus("מחובר ל-Google");
      if (event === "SIGNED_OUT") setStatus("מצב מקומי");
    });

    const syncSession = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const authCode = params.get("code");
        const authError = params.get("error_description") || params.get("error");

        if (authError) setError(decodeURIComponent(authError));

        const initialSession = await client.auth.getSession();
        if (initialSession.error) throw initialSession.error;
        if (initialSession.data.session) {
          setSession(initialSession.data.session);
          if (authCode || authError) {
            window.history.replaceState({}, document.title, `${window.location.origin}${window.location.pathname}`);
          }
          return;
        }

        const { data, error: sessionError } = await client.auth.getSession();
        if (sessionError) throw sessionError;
        setSession(data.session);
        if (authCode || authError) {
          window.history.replaceState({}, document.title, `${window.location.origin}${window.location.pathname}`);
        }
      } catch (sessionError) {
        setError(sessionError instanceof Error ? sessionError.message : "התחברות Google לא הושלמה");
      } finally {
        setAuthLoading(false);
      }
    };

    void syncSession();

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const nextRepository = supabase && session?.user ? new SupabaseBudgetRepository(supabase, session.user) : localRepository;
    setRepository(nextRepository);
    nextRepository
      .load()
      .then(async (loaded) => {
        const localSnapshot = readLocalSnapshot();
        const shouldRestoreLocal = nextRepository.mode === "cloud" && !hasBudgetData(loaded) && hasBudgetData(localSnapshot);
        const nextSnapshot = shouldRestoreLocal ? await nextRepository.importSnapshot(localSnapshot) : loaded;

        setSnapshot(nextSnapshot);
        writeLocalSnapshot(nextSnapshot);
        setStatus(nextRepository.mode === "cloud" ? "מסונכרן עם Supabase" : "מצב מקומי");
      })
      .catch((loadError: unknown) => {
        setError(getErrorMessage(loadError, "טעינת הנתונים נכשלה"));
        setRepository(localRepository);
      });
  }, [session]);

  const activeMonth = snapshot.activeMonth;
  const month = snapshot.months[activeMonth] || createEmptyMonth();
  const activeDeductions = getActiveDeductionsForMonth(snapshot.deductions, activeMonth);
  const fixedTotal = sum(activeDeductions);
  const expenseTotal = sum(month.expenses);
  const plannedBalance = month.income - fixedTotal - month.savingsTarget;
  const actualBalance = plannedBalance - expenseTotal;
  const activeCategories = snapshot.categories.filter((category) => category.isActive);

  const commit = async (recipe: (current: BudgetSnapshot) => BudgetSnapshot, nextStatus = "נשמר") => {
    setError("");
    const next = normalizeSnapshot(recipe(snapshot));
    setSnapshot(next);
    writeLocalSnapshot(next);

    try {
      const saved = await repository.save(next);
      setSnapshot(saved);
      writeLocalSnapshot(saved);
      setStatus(repository.mode === "cloud" ? `${nextStatus} בענן ובגיבוי מקומי` : nextStatus);
    } catch (saveError: unknown) {
      setError(getErrorMessage(saveError, "השמירה נכשלה"));
    }
  };

  const updateMonth = (monthKey: MonthKey, patch: Partial<MonthBudget>) =>
    commit((current) => {
      const ensured = ensureMonth(current, monthKey);
      return {
        ...ensured,
        activeMonth: monthKey,
        months: {
          ...ensured.months,
          [monthKey]: { ...ensured.months[monthKey], ...patch },
        },
      };
    });

  const signInWithGoogle = async () => {
    if (!supabase) {
      setError("צריך להגדיר VITE_SUPABASE_URL ו-VITE_SUPABASE_PUBLISHABLE_KEY לפני Google Login.");
      return;
    }
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (signInError) setError(signInError.message);
  };

  const signOut = async () => {
    writeLocalSnapshot(snapshot);
    const { error: signOutError } = (await supabase?.auth.signOut()) || {};
    if (signOutError) setError(signOutError.message);
  };

  const migrateLocalToCloud = async () => {
    if (repository.mode !== "cloud") {
      setError("צריך להתחבר ל-Google לפני העברת הנתונים לענן.");
      return;
    }
    const imported = await repository.importSnapshot(readLocalSnapshot());
    setSnapshot(imported);
    writeLocalSnapshot({ ...imported, migratedToCloudAt: new Date().toISOString() });
    setStatus("הנתונים המקומיים הועברו לענן");
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `smartbudget-${activeMonth}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importJson = async (file: File | null) => {
    if (!file) return;
    try {
      const imported = normalizeSnapshot(JSON.parse(await file.text()));
      const saved = await repository.importSnapshot(imported);
      setSnapshot(saved);
      writeLocalSnapshot(saved);
      setStatus("הגיבוי יובא בהצלחה");
    } catch {
      setError("קובץ הגיבוי לא תקין או שהייבוא נכשל.");
    }
  };

  return (
    <>
      <div className="liquid-bg" aria-hidden="true">
        <span className="blob blob-a" />
        <span className="blob blob-b" />
        <span className="blob blob-c" />
      </div>
      <div className="grain-overlay" aria-hidden="true" />
      <div className="app-viewport">
        <main className="app-shell">
          <Header
            activeMonth={activeMonth}
            session={session}
            status={status}
            authLoading={authLoading}
            cloudReady={isSupabaseConfigured}
            onMonthChange={(nextMonth) => commit((current) => ensureMonth({ ...current, activeMonth: nextMonth }, nextMonth), "החודש הוחלף")}
            onSignIn={signInWithGoogle}
            onSignOut={signOut}
          />

          {error && <div className="error-banner">{error}</div>}

          <TabBar active={activeTab} onChange={setActiveTab} />

          <div className="tab-panel">
            {activeTab === "overview" && (
              <>
                <section className="summary-panel" aria-labelledby="app-title">
                  <SummaryPanel
                    month={month}
                    fixedTotal={fixedTotal}
                    expenseTotal={expenseTotal}
                    plannedBalance={plannedBalance}
                    actualBalance={actualBalance}
                    onSave={(income, savingsTarget) => updateMonth(activeMonth, { income, savingsTarget })}
                  />
                </section>

                <SyncPanel
                  mode={repository.mode}
                  migratedToCloudAt={snapshot.migratedToCloudAt}
                  onMigrate={migrateLocalToCloud}
                  onExport={exportJson}
                  onImport={importJson}
                />
              </>
            )}

            {activeTab === "activity" && (
              <section className="workspace-grid">
                <DeductionsPanel
                  categories={activeCategories}
                  deductions={snapshot.deductions}
                  activeMonth={activeMonth}
                  onAdd={(deduction) =>
                    commit((current) => ({ ...current, deductions: [...current.deductions, deduction] }), "הורדה קבועה נוספה")
                  }
                  onToggle={(id) =>
                    commit((current) => ({
                      ...current,
                      deductions: current.deductions.map((deduction) =>
                        deduction.id === id ? { ...deduction, active: !deduction.active } : deduction,
                      ),
                    }))
                  }
                  onDelete={(id) => commit((current) => ({ ...current, deductions: current.deductions.filter((item) => item.id !== id) }))}
                />

                <ExpensesPanel
                  categories={activeCategories}
                  expenses={month.expenses}
                  activeMonth={activeMonth}
                  onAdd={(expense) =>
                    updateMonth(activeMonth, {
                      expenses: [...month.expenses, expense],
                    })
                  }
                  onDelete={(id) =>
                    updateMonth(activeMonth, {
                      expenses: month.expenses.filter((expense) => expense.id !== id),
                    })
                  }
                />
              </section>
            )}

            {activeTab === "reports" && <ReportsPanel snapshot={snapshot} activeMonth={activeMonth} fixedTotal={fixedTotal} />}

            {activeTab === "planning" && (
              <PlanningGrid
                snapshot={snapshot}
                activeMonth={activeMonth}
                onSnapshotChange={(next) => commit(() => next, "התכנון עודכן")}
              />
            )}
          </div>
        </main>
      </div>
    </>
  );
}

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "סקירה", icon: <IconOverview /> },
  { id: "activity", label: "תנועות", icon: <IconActivity /> },
  { id: "reports", label: "דוחות", icon: <IconReports /> },
  { id: "planning", label: "תכנון", icon: <IconPlanning /> },
];

function TabBar({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
  return (
    <nav className="tab-bar" aria-label="ניווט בין מסכי התקציב">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={tab.id === active ? "active" : ""}
          aria-current={tab.id === active ? "page" : undefined}
          aria-label={tab.label}
          onClick={() => onChange(tab.id)}
        >
          {tab.icon}
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

function IconOverview() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </svg>
  );
}

function IconActivity() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4v13M7 17l-3.5-3.5M7 17l3.5-3.5" />
      <path d="M17 20V7M17 7l3.5 3.5M17 7l-3.5 3.5" />
    </svg>
  );
}

function IconReports() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M12 20V4M20 20v-7" />
    </svg>
  );
}

function IconPlanning() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function Header({
  activeMonth,
  session,
  status,
  authLoading,
  cloudReady,
  onMonthChange,
  onSignIn,
  onSignOut,
}: {
  activeMonth: MonthKey;
  session: Session | null;
  status: string;
  authLoading: boolean;
  cloudReady: boolean;
  onMonthChange: (month: MonthKey) => void;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  return (
    <header className="topbar app-topbar">
      <div>
        <p className="eyebrow">SmartBudget</p>
        <h1 id="app-title">תכנון ומעקב תקציב חודשי</h1>
        <p className="topbar-copy">תקציב אישי עם הוצאות קבועות, יעדי חיסכון, דוחות וסנכרון Supabase.</p>
      </div>
      <div className="topbar-actions">
        <label className="month-picker">
          <span>חודש</span>
          <input id="activeMonth" type="month" value={activeMonth} onChange={(event) => onMonthChange(event.target.value as MonthKey)} />
        </label>
        <div className="auth-card">
          <span>{status}</span>
          {authLoading ? (
            <strong>בודק חיבור...</strong>
          ) : session ? (
            <>
              <strong>{session.user.email || "מחובר"}</strong>
              <button className="ghost-button" type="button" onClick={onSignOut}>יציאה</button>
            </>
          ) : (
            <button className="primary-button" type="button" onClick={onSignIn} disabled={!cloudReady}>כניסה עם Google</button>
          )}
        </div>
      </div>
    </header>
  );
}

function SummaryPanel({
  month,
  fixedTotal,
  expenseTotal,
  plannedBalance,
  actualBalance,
  onSave,
}: {
  month: MonthBudget;
  fixedTotal: number;
  expenseTotal: number;
  plannedBalance: number;
  actualBalance: number;
  onSave: (income: number, savingsTarget: number) => void;
}) {
  const [income, setIncome] = useState(month.income);
  const [savingsTarget, setSavingsTarget] = useState(month.savingsTarget);

  useEffect(() => {
    setIncome(month.income);
    setSavingsTarget(month.savingsTarget);
  }, [month.income, month.savingsTarget]);

  return (
    <div className="hero-grid">
      <form id="incomeForm" className="income-card" onSubmit={(event) => { event.preventDefault(); onSave(income, savingsTarget); }}>
        <label htmlFor="incomeInput">משכורת החודש</label>
        <MoneyInput id="incomeInput" value={income} onChange={setIncome} />
        <label htmlFor="savingsTargetInput">יעד חיסכון חודשי</label>
        <MoneyInput id="savingsTargetInput" value={savingsTarget} onChange={setSavingsTarget} />
        <p className="helper">היעד יורד מהיתרה המתוכננת כדי לראות אם נשאר כסף גם אחרי חיסכון.</p>
        <button className="primary-button" type="submit">שמירת תכנון</button>
      </form>

      <div className="balance-card">
        <p className="metric-label">נשאר אחרי קבועות וחיסכון</p>
        <strong id="plannedBalance" className={plannedBalance < 0 ? "negative" : ""}>{money(plannedBalance)}</strong>
        <div className="balance-meter" aria-hidden="true"><span id="fixedMeter" style={{ width: `${getSpendRatio(fixedTotal + month.savingsTarget, month.income)}%` }} /></div>
        <dl>
          <div><dt>משכורת</dt><dd id="incomeMetric">{money(month.income)}</dd></div>
          <div><dt>קבועות</dt><dd id="fixedMetric">{money(fixedTotal)}</dd></div>
          <div><dt>הוצאות נוספות</dt><dd id="expenseMetric">{money(expenseTotal)}</dd></div>
        </dl>
      </div>

      <div className="final-card">
        <p className="metric-label">יתרה בפועל החודש</p>
        <strong id="actualBalance" className={actualBalance < 0 ? "negative" : "positive"}>{money(actualBalance)}</strong>
        <p id="balanceMessage">{getBalanceMessage(month.income, fixedTotal, expenseTotal, month.savingsTarget, actualBalance)}</p>
      </div>
    </div>
  );
}

function SyncPanel({
  mode,
  migratedToCloudAt,
  onMigrate,
  onExport,
  onImport,
}: {
  mode: "local" | "cloud";
  migratedToCloudAt?: string;
  onMigrate: () => void;
  onExport: () => void;
  onImport: (file: File | null) => void;
}) {
  return (
    <section className="sync-panel">
      <div>
        <p className="eyebrow">{mode === "cloud" ? "ענן פעיל" : "מצב מקומי"}</p>
        <h2>{mode === "cloud" ? "הנתונים נשמרים ב-Supabase" : "אפשר לעבוד מקומית עד שמתחברים"}</h2>
        {migratedToCloudAt && <p className="helper">העברה אחרונה לענן: {new Date(migratedToCloudAt).toLocaleString("he-IL")}</p>}
      </div>
      <div className="sync-actions">
        <button className="secondary-button" type="button" onClick={onMigrate}>העבר נתונים לענן</button>
        <button className="ghost-button" type="button" onClick={onExport}>Export JSON</button>
        <label className="file-button">
          Import JSON
          <input type="file" accept="application/json" onChange={(event) => onImport(event.target.files?.[0] || null)} />
        </label>
      </div>
    </section>
  );
}

function ReportsPanel({ snapshot, activeMonth }: { snapshot: BudgetSnapshot; activeMonth: MonthKey; fixedTotal: number }) {
  const rows = getRecentMonthKeys(activeMonth, 12).map((monthKey) => {
    const budget = snapshot.months[monthKey] || createEmptyMonth();
    const fixed = sum(getActiveDeductionsForMonth(snapshot.deductions, monthKey));
    const extra = sum(budget.expenses);
    return { monthKey, fixed, extra, savingsTarget: budget.savingsTarget, total: fixed + extra };
  });
  const max = Math.max(...rows.map((row) => row.total + row.savingsTarget), 0);
  const current = snapshot.months[activeMonth] || createEmptyMonth();
  const monthlyAverage = rows.length ? rows.reduce((total, row) => total + row.total, 0) / rows.length : 0;
  const categoryGrowth = getFastestGrowingCategory(snapshot, activeMonth);

  return (
    <section className="chart-panel" aria-labelledby="monthly-chart-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">מבט חודשי</p>
          <h2 id="monthly-chart-title">מעקב הוצאות לפי חודשים</h2>
        </div>
        <div className="chart-legend" aria-label="מקרא גרף">
          <span><i className="legend-fixed" />קבועות</span>
          <span><i className="legend-extra" />נוספות</span>
          <span><i className="legend-savings" />יעד חיסכון</span>
        </div>
      </div>
      <div id="monthlyChart" className="monthly-chart" aria-live="polite">
        {!max ? (
          <EmptyState text="אחרי שתוסיף הורדות או הוצאות, יופיע כאן גרף עמודות של החודשים האחרונים." />
        ) : rows.map((row) => (
          <article className={`month-bar ${row.monthKey === activeMonth ? "current" : ""}`} key={row.monthKey}>
            <div className="bar-track" title={`${formatMonthName(row.monthKey)}: ${money(row.total)}`}>
              <div className="bar-stack" style={{ height: `${getSpendRatio(row.total + row.savingsTarget, max)}%` }}>
                <div className="bar-segment savings" style={{ height: `${getSpendRatio(row.savingsTarget, row.total + row.savingsTarget)}%` }} />
                <div className="bar-segment extra" style={{ height: `${getSpendRatio(row.extra, row.total + row.savingsTarget)}%` }} />
                <div className="bar-segment fixed" style={{ height: `${getSpendRatio(row.fixed, row.total + row.savingsTarget)}%` }} />
              </div>
            </div>
            <div className="month-label"><strong>{formatMonthName(row.monthKey)}</strong><span>{money(row.total)}</span></div>
          </article>
        ))}
      </div>
      <div className="report-strip">
        <Metric title="ממוצע חודשי" value={money(monthlyAverage)} />
        <Metric title="החודש הנבחר" value={money(sum(current.expenses))} />
        <Metric title="קטגוריה שגדלה" value={categoryGrowth || "אין מספיק נתונים"} />
      </div>
      <CategoryBreakdown snapshot={snapshot} activeMonth={activeMonth} />
    </section>
  );
}

function DeductionsPanel({
  categories,
  deductions,
  activeMonth,
  onAdd,
  onToggle,
  onDelete,
}: {
  categories: Category[];
  deductions: FixedDeduction[];
  activeMonth: MonthKey;
  onAdd: (deduction: FixedDeduction) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [recurrence, setRecurrence] = useState<"monthly" | "installments">("monthly");
  const sorted = [...deductions].sort((a, b) => a.day - b.day || a.name.localeCompare(b.name, "he"));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = Number(form.get("amount") || 0);
    if (!amount) return;
    onAdd({
      id: createId(),
      name: String(form.get("name") || "").trim(),
      amount,
      day: clampDay(form.get("day")),
      categoryId: String(form.get("categoryId") || categories[0]?.id || "cat-other"),
      active: true,
      recurrence,
      startMonth: String(form.get("startMonth") || activeMonth) as MonthKey,
      installmentCount: recurrence === "installments" ? Math.max(1, Number(form.get("installmentCount") || 1)) : undefined,
    });
    event.currentTarget.reset();
    setRecurrence("monthly");
  }

  return (
    <div className="tool-panel">
      <PanelHeading eyebrow="קבוע בכל חודש" title="הורדות קבועות" count={deductions.length} />
      <form className="entry-form" id="deductionForm" onSubmit={submit}>
        <Field id="deductionName" label="שם ההורדה" name="name" required placeholder="שכר דירה, ביטוח, הלוואה" />
        <div className="form-row">
          <Field id="deductionAmount" label="סכום" name="amount" type="number" min="0" step="0.01" required placeholder="0" />
          <Field id="deductionDay" label="יום בחודש" name="day" type="number" min="1" max="31" placeholder="1" />
        </div>
        <div className="form-row">
          <SelectField id="deductionCategory" label="קטגוריה" name="categoryId" categories={categories} />
          <Field id="deductionStartMonth" label="מתחיל בחודש" name="startMonth" type="month" defaultValue={activeMonth} />
        </div>
        <div className="segmented">
          <button type="button" className={recurrence === "monthly" ? "active" : ""} onClick={() => setRecurrence("monthly")}>חודשי</button>
          <button type="button" className={recurrence === "installments" ? "active" : ""} onClick={() => setRecurrence("installments")}>תשלומים</button>
        </div>
        {recurrence === "installments" && <Field id="deductionInstallments" label="מספר תשלומים" name="installmentCount" type="number" min="1" defaultValue="3" />}
        <button className="secondary-button" type="submit">הוספת הורדה</button>
      </form>
      <div id="deductionsList" className="item-list" aria-live="polite">
        {!sorted.length ? <EmptyState text="הוסף הורדות קבועות כדי לראות כמה נשאר לך מיד אחרי המשכורת." /> : sorted.map((item) => (
          <BudgetItem
            key={item.id}
            title={item.name}
            meta={[getCategoryName(categories, item.categoryId), `יום ${item.day}`, isDeductionActiveForMonth(item, activeMonth) ? "פעיל החודש" : "לא פעיל החודש"]}
            amount={item.amount}
            active={item.active}
            onToggle={() => onToggle(item.id)}
            onDelete={() => onDelete(item.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ExpensesPanel({
  categories,
  expenses,
  activeMonth,
  onAdd,
  onDelete,
}: {
  categories: Category[];
  expenses: MonthBudget["expenses"];
  activeMonth: MonthKey;
  onAdd: (expense: MonthBudget["expenses"][number]) => void;
  onDelete: (id: string) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = Number(form.get("amount") || 0);
    if (!amount) return;
    const date = String(form.get("date") || new Date().toISOString().slice(0, 10));
    onAdd({
      id: createId(),
      name: String(form.get("name") || "").trim(),
      amount,
      categoryId: String(form.get("categoryId") || categories[0]?.id || "cat-other"),
      date,
      month: activeMonth,
    });
      event.currentTarget.reset();
  }

  return (
    <div className="tool-panel">
      <PanelHeading eyebrow="מעקב חודשי" title="הוצאות נוספות" count={expenses.length} />
      <form className="entry-form" id="expenseForm" onSubmit={submit}>
        <Field id="expenseName" label="שם ההוצאה" name="name" required placeholder="סופר, מתנה, תיקון רכב" />
        <div className="form-row">
          <Field id="expenseAmount" label="סכום" name="amount" type="number" min="0" step="0.01" required placeholder="0" />
          <SelectField id="expenseCategory" label="קטגוריה" name="categoryId" categories={categories} />
        </div>
        <Field id="expenseDate" label="תאריך" name="date" type="date" defaultValue={`${activeMonth}-${String(new Date().getDate()).padStart(2, "0")}`} />
        <button className="secondary-button" type="submit">הוספת הוצאה</button>
      </form>
      <div id="expensesList" className="item-list" aria-live="polite">
        {!expenses.length ? <EmptyState text="כאן אפשר להוסיף הוצאות חד-פעמיות של החודש כדי לעקוב אחרי היתרה בפועל." /> : [...expenses].reverse().map((item) => (
          <BudgetItem
            key={item.id}
            title={item.name}
            meta={[getCategoryName(categories, item.categoryId), new Date(item.date).toLocaleDateString("he-IL")]}
            amount={item.amount}
            onDelete={() => onDelete(item.id)}
          />
        ))}
      </div>
    </div>
  );
}

function PlanningGrid({
  snapshot,
  activeMonth,
  onSnapshotChange,
}: {
  snapshot: BudgetSnapshot;
  activeMonth: MonthKey;
  onSnapshotChange: (snapshot: BudgetSnapshot) => void;
}) {
  const month = snapshot.months[activeMonth] || createEmptyMonth();

  const addCategory = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    if (!name) return;
    onSnapshotChange({
      ...snapshot,
      categories: [
        ...snapshot.categories,
        {
          id: createId(),
          name,
          color: String(form.get("color") || "#34c98f"),
          isActive: true,
          sortOrder: snapshot.categories.length * 10 + 10,
        },
      ],
    });
    event.currentTarget.reset();
  };

  const updateCategoryBudget = (categoryId: string, amount: number) => {
    onSnapshotChange({
      ...snapshot,
      months: {
        ...snapshot.months,
        [activeMonth]: {
          ...month,
          categoryBudgets: { ...month.categoryBudgets, [categoryId]: amount },
        },
      },
    });
  };

  const addGoal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    if (!name) return;
    onSnapshotChange({
      ...snapshot,
      savingsGoals: [
        ...snapshot.savingsGoals,
        {
          id: createId(),
          name,
          targetAmount: Number(form.get("targetAmount") || 0),
          currentAmount: Number(form.get("currentAmount") || 0),
          monthlyTarget: Number(form.get("monthlyTarget") || 0),
          deadlineMonth: String(form.get("deadlineMonth") || "") as MonthKey,
          isActive: true,
        },
      ],
    });
    event.currentTarget.reset();
  };

  return (
    <section className="planning-grid">
      <div className="tool-panel">
        <PanelHeading eyebrow="תכנון מול בפועל" title="תקציב לפי קטגוריה" count={snapshot.categories.filter((item) => item.isActive).length} />
        <div className="category-budget-list">
          {snapshot.categories.filter((category) => category.isActive).map((category) => {
            const planned = month.categoryBudgets[category.id] || 0;
            const actual = month.expenses.filter((expense) => expense.categoryId === category.id).reduce((total, expense) => total + expense.amount, 0);
            const diff = planned - actual;
            return (
              <article className="budget-row" key={category.id}>
                <span className="swatch" style={{ background: category.color }} />
                <strong>{category.name}</strong>
                <MoneyInput id={`budget-${category.id}`} value={planned} onChange={(value) => updateCategoryBudget(category.id, value)} />
                <span className={diff < 0 ? "negative" : "positive"}>{diff < 0 ? "חריגה " : "נשאר "}{money(Math.abs(diff))}</span>
              </article>
            );
          })}
        </div>
        <form className="entry-form compact-form" onSubmit={addCategory}>
          <div className="form-row">
            <Field id="categoryName" label="קטגוריה חדשה" name="name" placeholder="לימודים, מתנות, עסק" />
            <div className="field">
              <label htmlFor="categoryColor">צבע</label>
              <input id="categoryColor" name="color" type="color" defaultValue="#34c98f" />
            </div>
          </div>
          <button className="secondary-button" type="submit">הוספת קטגוריה</button>
        </form>
      </div>

      <div className="tool-panel">
        <PanelHeading eyebrow="חיסכון" title="יעדים כלליים" count={snapshot.savingsGoals.filter((goal) => goal.isActive).length} />
        <form className="entry-form" onSubmit={addGoal}>
          <Field id="goalName" label="שם היעד" name="name" placeholder="כרית ביטחון, חופשה, לימודים" required />
          <div className="form-row">
            <Field id="goalTarget" label="יעד כולל" name="targetAmount" type="number" min="0" step="0.01" required />
            <Field id="goalCurrent" label="נצבר עד עכשיו" name="currentAmount" type="number" min="0" step="0.01" />
          </div>
          <div className="form-row">
            <Field id="goalMonthly" label="יעד חודשי" name="monthlyTarget" type="number" min="0" step="0.01" />
            <Field id="goalDeadline" label="חודש יעד" name="deadlineMonth" type="month" />
          </div>
          <button className="secondary-button" type="submit">הוספת יעד</button>
        </form>
        <div className="item-list">
          {!snapshot.savingsGoals.length ? <EmptyState text="יעדי חיסכון יעזרו לבדוק אם נשאר מספיק כסף אחרי ההוצאות." /> : snapshot.savingsGoals.map((goal) => (
            <GoalItem
              key={goal.id}
              goal={goal}
              onUpdate={(patch) => onSnapshotChange({ ...snapshot, savingsGoals: snapshot.savingsGoals.map((item) => item.id === goal.id ? { ...item, ...patch } : item) })}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function CategoryBreakdown({ snapshot, activeMonth }: { snapshot: BudgetSnapshot; activeMonth: MonthKey }) {
  const budget = snapshot.months[activeMonth] || createEmptyMonth();
  const activeDeductions = getActiveDeductionsForMonth(snapshot.deductions, activeMonth);
  const totals = new Map<string, number>();
  [...activeDeductions, ...budget.expenses].forEach((item) => totals.set(item.categoryId, (totals.get(item.categoryId) || 0) + item.amount));
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] || 0;

  return (
    <section className="insights-panel" aria-labelledby="insights-title">
      <div className="panel-heading">
        <div><p className="eyebrow">תמונה מהירה</p><h2 id="insights-title">פירוט לפי קטגוריות</h2></div>
      </div>
      <div id="categoryBreakdown" className="breakdown-grid">
        {!rows.length ? <EmptyState text="אין עדיין נתונים לפירוט. ההורדות וההוצאות יופיעו כאן לפי קטגוריה." /> : rows.map(([categoryId, total]) => (
          <article className="breakdown-item" key={categoryId}>
            <span>{getCategoryName(snapshot.categories, categoryId)}</span>
            <strong>{money(total)}</strong>
            <div className="mini-meter" aria-hidden="true"><i style={{ width: `${getSpendRatio(total, max)}%` }} /></div>
          </article>
        ))}
      </div>
    </section>
  );
}

function GoalItem({ goal, onUpdate }: { goal: SavingsGoal; onUpdate: (patch: Partial<SavingsGoal>) => void }) {
  const ratio = getSpendRatio(goal.currentAmount, goal.targetAmount);
  return (
    <article className="budget-item">
      <div>
        <h3>{goal.name}</h3>
        <div className="item-meta">
          <span>{money(goal.currentAmount)} מתוך {money(goal.targetAmount)}</span>
          {goal.deadlineMonth && <span>עד {formatMonthName(goal.deadlineMonth)}</span>}
        </div>
        <div className="mini-meter" aria-hidden="true"><i style={{ width: `${ratio}%` }} /></div>
      </div>
      <div className="item-actions">
        <MoneyInput id={`goal-${goal.id}`} value={goal.currentAmount} onChange={(value) => onUpdate({ currentAmount: value })} />
        <button className={`toggle ${goal.isActive ? "active" : ""}`} type="button" aria-label="כיבוי יעד" onClick={() => onUpdate({ isActive: !goal.isActive })} />
      </div>
    </article>
  );
}

function BudgetItem({
  title,
  meta,
  amount,
  active,
  onToggle,
  onDelete,
}: {
  title: string;
  meta: string[];
  amount: number;
  active?: boolean;
  onToggle?: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="budget-item">
      <div>
        <h3>{title}</h3>
        <div className="item-meta">{meta.map((value) => <span key={value}>{value}</span>)}</div>
      </div>
      <div className="item-actions">
        <span className="amount">{money(amount)}</span>
        {onToggle && <button className={`toggle ${active ? "active" : ""}`} type="button" aria-label="הפעלה או כיבוי" onClick={onToggle} />}
        <button className="icon-button danger" type="button" aria-label="מחיקה" onClick={onDelete}>×</button>
      </div>
    </article>
  );
}

function MoneyInput({ id, value, onChange }: { id: string; value: number; onChange: (value: number) => void }) {
  return (
    <div className="money-input">
      <span aria-hidden="true">₪</span>
      <input id={id} type="number" min="0" step="0.01" value={value || ""} placeholder="0" inputMode="decimal" onChange={(event) => onChange(Number(event.target.value || 0))} />
    </div>
  );
}

function Field({ id, label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { id: string; label: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...props} />
    </div>
  );
}

function SelectField({ id, label, name, categories }: { id: string; label: string; name: string; categories: Category[] }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name}>
        {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
    </div>
  );
}

function PanelHeading({ eyebrow, title, count }: { eyebrow: string; title: string; count: number }) {
  return (
    <div className="panel-heading">
      <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>
      <span className="count-pill">{count}</span>
    </div>
  );
}

function Metric({ title, value }: { title: string; value: string }) {
  return <article className="metric-card"><span>{title}</span><strong>{value}</strong></article>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state"><div className="empty-mark" aria-hidden="true" /><p>{text}</p></div>;
}

function getBalanceMessage(income: number, fixedTotal: number, expenseTotal: number, savingsTarget: number, balance: number): string {
  if (!income && !fixedTotal && !expenseTotal && !savingsTarget) return "כשתוסיף משכורת והורדות, אחשב את התמונה החודשית.";
  if (balance < 0) return `החודש בחריגה של ${money(Math.abs(balance))}. כדאי לבדוק אילו הוצאות אפשר לדחות.`;
  if (balance === 0) return "התקציב מאוזן בדיוק. אין כרית ביטחון אחרי ההוצאות והחיסכון.";
  return `נשארו לך ${money(balance)} אחרי ההורדות, ההוצאות ויעד החיסכון.`;
}

function getFastestGrowingCategory(snapshot: BudgetSnapshot, activeMonth: MonthKey): string {
  const prevMonth = addMonths(activeMonth, -1);
  const current = snapshot.months[activeMonth]?.expenses || [];
  const previous = snapshot.months[prevMonth]?.expenses || [];
  let best = { categoryId: "", growth: 0 };

  snapshot.categories.forEach((category) => {
    const now = sum(current.filter((expense) => expense.categoryId === category.id));
    const before = sum(previous.filter((expense) => expense.categoryId === category.id));
    if (now - before > best.growth) best = { categoryId: category.id, growth: now - before };
  });

  return best.categoryId ? getCategoryName(snapshot.categories, best.categoryId) : "";
}

function clampDay(value: FormDataEntryValue | null): number {
  const day = Number(value || 1);
  return Math.min(31, Math.max(1, Number.isFinite(day) ? day : 1));
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error) {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint, record.code]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    if (parts.length) return parts.join(" ");
  }
  return fallback;
}

function hasBudgetData(snapshot: BudgetSnapshot): boolean {
  const hasMonthData = Object.values(snapshot.months).some(
    (month) =>
      month.income > 0 ||
      month.savingsTarget > 0 ||
      month.expenses.length > 0 ||
      Object.values(month.categoryBudgets).some((amount) => amount > 0),
  );

  return hasMonthData || snapshot.deductions.length > 0 || snapshot.savingsGoals.length > 0;
}
