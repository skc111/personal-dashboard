/* ================= 工具 ================= */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
function toast(msg) {
  let t = $("#appToast");
  if (!t) { t = document.createElement("div"); t.id = "appToast"; t.className = "app-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3200);
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeURL = s => { try { const u=new URL(s);return ["http:","https:"].includes(u.protocol)?u.href:"#"; } catch { return "#"; } };
const money = (n) => "¥" + (Number(n) || 0).toFixed(2);
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const sortBy = (arr, keys, dir = 1) => [...arr].sort((a, b) => {
  for (const k of keys) { if ((a[k] || "") > (b[k] || "")) return dir; if ((a[k] || "") < (b[k] || "")) return -dir; }
  return 0;
});
function isoOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
const todayISO = () => isoOf(new Date());
function addDays(iso, n) { const d = new Date(iso + "T00:00"); d.setDate(d.getDate() + n); return isoOf(d); }
function mondayOf(iso) { const d = new Date(iso + "T00:00"); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoOf(d); }
function weekDates(mon) { return Array.from({ length: 7 }, (_, i) => addDays(mon, i)); }
function fmtCN(iso) { const d = new Date(iso + "T00:00"); return `${d.getMonth() + 1}月${d.getDate()}日 周${"日一二三四五六"[d.getDay()]}`; }
function greet() { const h = new Date().getHours(); return h < 6 ? "夜深了" : h < 11 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好"; }
const parseTags = (s) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const parseLines = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);

/* ============ 时间直接输入 + 校验 ============ */
const pad2 = (n) => String(n).padStart(2, "0");

function setTimeVal(id, val) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(val || "");
  $("#" + id + "H").value = m ? pad2(Number(m[1])) : "";
  $("#" + id + "M").value = m ? pad2(Number(m[2])) : "";
  $("#" + id).value = val || "";
}
function validateTime(id) {
  const h = $("#" + id + "H").value.trim();
  const m = $("#" + id + "M").value.trim();
  $("#" + id).classList.remove("invalid");
  if (h === "" && m === "") { $("#" + id).value = ""; return true; }   // 都空 = 不限
  if (h === "" || m === "") return false;                              // 只填一半
  const H = Number(h), M = Number(m);
  if (!Number.isInteger(H) || H < 0 || H > 23) return false;
  if (!Number.isInteger(M) || M < 0 || M > 59) return false;
  $("#" + id).value = `${pad2(H)}:${pad2(M)}`;
  return true;
}
function normalizeTimeInput(input) {
  const v = input.value.trim();
  if (v === "") return;
  input.value = pad2(Math.max(0, Math.floor(Number(v) || 0)));
}

const PALETTE = ["#4a6cf7", "#2fa96e", "#df9a2b", "#e5484d", "#9b59b6", "#00b8d4", "#8d6e63", "#607d8b", "#c2185b", "#558b2f"];

/* ================= 状态 ================= */
const state = {
  db: null, view: "dashboard",
  courseSearch: "",
  financeMonth: todayISO().slice(0, 7),
  weekOffset: 0, reviewTab: "daily", subjectTab: "points",
};

/* ================= 数据 ================= */
function setStatus(t) { $("#saveStatus").textContent = t; }
function saveBanner(show, text, reason = "") {
  let b = $("#saveBanner");
  if (!b) { b=document.createElement("div"); b.id="saveBanner";b.className="save-banner";document.body.appendChild(b); }
  b.hidden=!show;if(text)b.textContent=text;b.dataset.reason=reason;
  if(show&&text&&syncClient?.ready) {
    const exportButton=document.createElement("button");
    exportButton.type="button";exportButton.className="btn small";exportButton.textContent="立即导出备份";exportButton.style.marginLeft="8px";
    exportButton.addEventListener("click",()=>exportFullBackup().catch(e=>toast("导出未完成："+e.message)));
    b.append(" ",exportButton);
  }
}
async function load() {
  syncClient=new DashboardSync.Client(applyRemoteUpdates,renderSyncStatus);
  state.db=await syncClient.init();
  applyTheme(state.db.settings.theme || "light");
}
function save() {
  if(!syncClient?.ready)return;
  try { return syncClient.commit(state.db).catch(e=>{saveBanner(true,"保存未完成："+e.message+"。请保留页面并导出备份。");}); }
  catch(e){saveBanner(true,"保存未完成："+e.message+"。请保留页面并导出备份。");}
}

/* ================= 主题 ================= */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  if(DashboardSync.native && DashboardNative.setTheme)DashboardNative.setTheme(t);
  $("#themeBtn").textContent = t === "dark" ? "☀️" : "🌙";
}
function toggleTheme() {
  state.db.settings.theme = state.db.settings.theme === "dark" ? "light" : "dark";
  applyTheme(state.db.settings.theme); save();
  if ($("#themeSeg")) setSeg("themeSeg", state.db.settings.theme);
}

/* ================= 弹窗 ================= */
const MODALS = {
  course: {
    title: () => "新建课程", editTitle: () => "编辑课程",
    html: () => `
      <form id="subjectForm">
        <input type="hidden" id="subjectId">
        <label class="field">课程名称<input id="subjectName" required placeholder="如：高等数学"></label>
        <label class="field">教师 / 学分（可选）<input id="subjectTeacher" placeholder="如：张老师 · 4学分"></label>
        <div class="modal-actions"><button class="btn ghost" type="button" data-close>取消</button><button class="btn primary" type="submit">保存</button></div>
      </form>`,
  },
  trans: {
    title: () => "记一笔", editTitle: () => "编辑记录",
    html: () => `
      <form id="transForm">
        <input type="hidden" id="transId"><input type="hidden" id="transTypeVal" value="expense">
        <div class="field"><span>类型</span>
          <div class="segmented" id="transTypeSeg">
            <button type="button" data-v="expense" class="active">支出</button><button type="button" data-v="income">收入</button>
          </div>
        </div>
        <label class="field">金额（元）<input type="number" id="transAmount" class="amount-input" min="0" step="0.01" inputmode="decimal" required placeholder="0.00"></label>
        <div class="row2">
          <label class="field">分类<select id="transCategory"></select></label>
          <label class="field">日期<input type="date" id="transDate" required value="${todayISO()}"></label>
        </div>
        <label class="field">归属旅行<select id="transTrip"></select></label>
        <label class="field">备注（可换行）<textarea id="transNote" rows="2" placeholder="可选"></textarea></label>
        <div class="modal-actions"><button class="btn ghost" type="button" data-close>取消</button><button class="btn primary" type="submit">保存</button></div>
      </form>`,
  },
  deadline: {
    title: () => "添加重要事项 DDL", editTitle: () => "编辑 DDL",
    html: () => `
      <form id="deadlineForm">
        <input type="hidden" id="deadlineId">
        <label class="field">事项<input id="ddlTitle" required placeholder="如：高数作业第三章 / 论文初稿"></label>
        <div class="row2">
          <label class="field">截止日期<input type="date" id="ddlDate" required value="${todayISO()}"></label>
          <div class="field"><span>截止时间（留空=不限）</span>
            <div class="time-inputs">
              <input type="number" id="ddlTimeH" min="0" max="23" step="1" placeholder="时" inputmode="numeric">
              <span class="ti-colon">:</span>
              <input type="number" id="ddlTimeM" min="0" max="59" step="1" placeholder="分" inputmode="numeric">
              <input type="hidden" id="ddlTime">
            </div>
          </div>
        </div>
        <label class="field">备注（可换行）<textarea id="ddlNote" rows="2" placeholder="可选"></textarea></label>
        <div class="modal-actions"><button class="btn ghost" type="button" data-close>取消</button><button class="btn primary" type="submit">保存</button></div>
      </form>`,
  },
  trip: {
    title: () => "新建旅行账本", editTitle: () => "编辑旅行账本",
    html: () => `
      <form id="tripForm">
        <input type="hidden" id="tripId">
        <label class="field">城市 / 旅行名<input id="tripCity" required placeholder="如：北京 / 云南七日游"></label>
        <div class="row2">
          <label class="field">开始日期<input type="date" id="tripStart" required value="${todayISO()}"></label>
          <label class="field">结束日期（可选）<input type="date" id="tripEnd"></label>
        </div>
        <label class="field">备注<textarea id="tripNote" rows="2" placeholder="可选"></textarea></label>
        <div class="modal-actions"><button class="btn ghost" type="button" data-close>取消</button><button class="btn primary" type="submit">保存</button></div>
      </form>`,
  },
  settings: {
    title: () => "设置", editTitle: () => "设置",
    html: () => `
      <div class="field"><span>主题</span>
        <div class="segmented" id="themeSeg">
          <button type="button" data-v="light">☀️ 浅色</button><button type="button" data-v="dark">🌙 深色</button>
        </div>
      </div>
      <div class="field"><span>数据备份</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="exportBtn">⬇️ 导出 JSON</button>
          <button class="btn" id="importBtn">⬆️ 导入 JSON</button>
          <input type="file" id="importFile" accept=".json" hidden>
        </div>
        <p class="muted small-text" style="margin:6px 0 0">先保存到本地。电脑保留最近 200 次修改备份；手机可导出到文件。导入采用合并，不清空现有记录。</p>
      </div>
      <div class="field"><button class="btn" id="openSyncSettings">多设备同步 →</button></div>
      <label class="field">支出分类（逗号分隔）<input id="expenseCats"></label>
      <label class="field">收入分类（逗号分隔）<input id="incomeCats"></label>
      <div class="modal-actions" style="justify-content:space-between">
        <button class="btn" id="sampleBtn">🧪 示例数据</button>
        <button class="btn primary" id="catsSaveBtn">保存设置</button>
      </div>`,
  },
};

let modalType = null;
let modalOrigin = null, modalScrollY = 0;
const isPhoneLayout = () => window.matchMedia("(max-width: 860px)").matches;

// Use the visible viewport on keyboard resize, with an innerHeight fallback
// for older Android WebViews. Pinch zoom must remain available to the user.
function updateViewportLayout() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const unzoomed = vv && Math.abs(vv.scale - 1) < .01;
  root.style.setProperty("--visual-height", `${unzoomed ? vv.height : innerHeight}px`);
  root.style.setProperty("--visual-offset-top", `${unzoomed ? vv.offsetTop : 0}px`);
  for (const [selector, name] of [["#bottomNav", "--bottom-nav-height"], [".topbar", "--topbar-height"]]) {
    const height = Math.ceil($(selector).getBoundingClientRect().height);
    const value = `${height}px`;
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  }
}
function keepModalFieldVisible() {
  if ($("#modalOverlay").hidden) return;
  const body = $("#modalBody"), field = document.activeElement;
  if (!body.contains(field) || !field.matches("input:not([type=hidden]),select,textarea")) return;
  const rect = field.getBoundingClientRect(), area = body.getBoundingClientRect();
  const footer = field.closest("form")?.querySelector(".modal-actions");
  const bottom = area.bottom - (footer?.getBoundingClientRect().height || 0) - 12;
  if (rect.top < area.top + 8) body.scrollTop += rect.top - area.top - 8;
  else if (rect.bottom > bottom) body.scrollTop += Math.min(rect.bottom - bottom, rect.top - area.top - 8);
}
function initViewportLayout() {
  let raf = 0;
  const update = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { updateViewportLayout(); keepModalFieldVisible(); });
  };
  window.addEventListener("resize", update);
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(update);
    observer.observe($("#bottomNav")); observer.observe($(".topbar"));
  }
  updateViewportLayout();
}
function showModal(wide = false) {
  const overlay = $("#modalOverlay"), modal = $(".modal");
  if (overlay.hidden) {
    modalOrigin = document.activeElement;
    modalScrollY = window.scrollY;
    document.body.style.top = `-${modalScrollY}px`;
    document.body.classList.add("modal-open");
    document.documentElement.classList.add("modal-open");
  }
  modal.classList.toggle("wide", wide);
  modal.classList.remove("compact");
  overlay.hidden = false;
  $("#modalBody").scrollTop = 0;
  updateViewportLayout();
  // Do not open the software keyboard or jump down a long form on entry.
  const first = isPhoneLayout() ? $("#modalClose") : ($("#modalBody input:not([type=hidden]):not([type=file]), #modalBody textarea") || $("#modalBody button"));
  (first || $("#modalClose")).focus({ preventScroll: true });
}
function setSeg(segId, val) {
  const seg = $("#" + segId); if (!seg) return;
  seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === val));
  const hidden = $("#" + segId.replace("Seg", "Val"));
  if (hidden) hidden.value = val;
}
const segVal = (segId) => $("#" + segId)?.querySelector(".active")?.dataset.v || "";

function openModal(type, editing = false) {
  const m = MODALS[type];
  if (!m) return;
  modalType = type;
  $("#modalTitle").textContent = editing ? m.editTitle() : m.title();
  $("#modalBody").innerHTML = m.html();
  if (type === "trans") { refreshCatOptions(); refreshTripOptions(); autoPickTrip($("#transDate").value || todayISO()); }
  if (type === "settings") fillSettings();
  if (type === "deadline") setTimeVal("ddlTime", "");
  showModal();
}
function closeModal() {
  if ($("#modalOverlay").hidden) return;
  if ($("#modalOverlay").contains(document.activeElement)) document.activeElement.blur();
  $("#modalOverlay").hidden = true; modalType = null; $(".modal").classList.remove("wide", "compact");
  document.body.classList.remove("modal-open");
  document.documentElement.classList.remove("modal-open");
  document.body.style.top = "";
  window.scrollTo(0, modalScrollY);
  if (modalOrigin?.isConnected) modalOrigin.focus({ preventScroll: true });
  modalOrigin = null;
  setTimeout(applyRemoteUpdates,0);
}
function openWideModal(title, html) {
  modalType = "subjectDetail";
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  showModal(true);
}
function refreshTripOptions(selected) {
  const sel = $("#transTrip"); if (!sel) return;
  const trips = state.db.trips || [];
  sel.innerHTML = `<option value="">不计入旅行（主账本）</option>` + trips.map((t) => `<option value="${t.id}" ${t.id === selected ? "selected" : ""}>✈️ ${esc(t.city)}</option>`).join("");
}
function autoPickTrip(dateStr) {
  if (!dateStr) return;
  const trips = (state.db.trips || []).filter((t) => dateStr >= t.startDate && (!t.endDate || dateStr <= t.endDate));
  if (trips.length === 1) $("#transTrip").value = trips[0].id;
}
function tripTotal(tripId) {
  return sum((state.db.transactions || []).filter((t) => t.tripId === tripId && t.type === "expense"), (t) => t.amount);
}

function refreshCatOptions() {
  const type = segVal("transTypeSeg") || "expense";
  const cats = type === "income" ? state.db.settings.incomeCategories : state.db.settings.categories;
  $("#transCategory").innerHTML = cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
}
function fillSettings() {
  setSeg("themeSeg", state.db.settings.theme);
  $("#expenseCats").value = state.db.settings.categories.join("，");
  $("#incomeCats").value = state.db.settings.incomeCategories.join("，");
  $("#sampleBtn").disabled = !!(state.db.subjects.length || state.db.transactions.length || state.db.deadlines.length || state.db.trips.length);
}

/* ================= 视图 ================= */
const TITLES = { dashboard: "今日", course: "课程总结", finance: "记账", deadline: "重要事项 DDL", review: "回顾" };
function switchView(view) {
  if (!Object.hasOwn(TITLES, view)) view = "dashboard";
  state.view = view;
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  $$("#nav button, #bottomNav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#viewTitle").textContent = TITLES[view];
  render();
  window.scrollTo(0, 0);
}
function render() {
  ({ dashboard: renderDashboard, course: renderCourse, finance: renderFinance, deadline: renderDeadlines, review: renderReview }[state.view] || renderDashboard)();
}

/* ================= 今日 ================= */
function emptyHTML(ico, text, modalType) {
  return `<div class="empty"><span class="empty-ico">${ico}</span>${text}<br><button class="btn small" data-modal="${modalType}" style="margin-top:8px">＋ 立即添加</button></div>`;
}
let clockTimer = null;
function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const el = $("#clockTime");
  if (el) el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;

}

function renderDashboard() {
  tickClock();
  if (!clockTimer) clockTimer = setInterval(tickClock, 1000);
  const today = todayISO(), db = state.db;
  $("#dashGreeting").textContent = `${greet()}，今天是 ${fmtCN(today)}`;
  const trans = db.transactions.filter((t) => t.date === today);
  const courses = [];
  (db.subjects || []).forEach((sub) => (sub.points || []).forEach((p) => { if (p.date === today) courses.push({ course: sub.name, topic: p.title }); }));
  const todayMain = trans.filter((t) => t.type === "expense" && !t.tripId);
  const todayMainExp = sum(todayMain, (t) => t.amount);
  const todayTripExp = sum(trans.filter((t) => t.tripId && t.type === "expense"), (t) => t.amount);
  $("#dashSub").textContent = `今日支出 ${money(todayMainExp)}${todayTripExp ? `（旅行 ${money(todayTripExp)} 另计）` : ""}`;

  const ddls = sortBy((db.deadlines || []).filter((t) => !t.done), ["date", "time"]).slice(0, 5);
  $("#dashDdl").innerHTML = ddls.length ? `<div class="panel ddl-banner">
    <div class="panel-head"><h3>🎯 近期 DDL</h3><button class="btn small ghost" data-goto="deadline">全部 →</button></div>
    ${ddls.map((t) => { const [txt, cls] = ddlBadge(t); return `
      <div class="mini-row" data-id="${t.id}">
        <span class="badge ${cls}" style="flex-shrink:0">${txt}</span>
        <span class="mini-title">${esc(t.title)}</span>
        <span class="mini-time" style="width:auto">${t.date}${t.time ? " " + esc(t.time) : ""}</span>
        <button class="mini-check" data-action="dashDoneDdl" title="完成">✓</button>
      </div>`; }).join("")}
  </div>` : "";
  $("#dashStats").innerHTML = `
    <div class="stat-card"><div class="stat-ico">💰</div><div><div class="label">今日支出</div><div class="value">${money(todayMainExp)}</div><div class="sub">${todayMain.length} 笔${todayTripExp ? ` · 旅行 ${money(todayTripExp)} 另计` : ""}</div></div></div>
    <div class="stat-card"><div class="stat-ico">📚</div><div><div class="label">课程总结</div><div class="value">${courses.length} 篇</div><div class="sub">${[...new Set(courses.map((c) => esc(c.course)))].join("、") || "暂无"}</div></div></div>`;
  $("#dashFinance").innerHTML = trans.length
    ? trans.map((t) => `<div class="mini-row"><span class="mini-title">${esc(t.category)}${t.note ? " · " + esc(t.note) : ""}</span><span class="mini-amount" style="color:${t.type === "income" ? "var(--ok)" : "var(--danger)"}">${t.type === "income" ? "+" : "-"}${money(t.amount)}</span></div>`).join("")
    : emptyHTML("💰", "今天还没有记账", "trans");
  $("#dashCourses").innerHTML = courses.length
    ? courses.map((c) => `<div class="mini-row"><span class="mini-title">${esc(c.course)}｜${esc(c.topic)}</span></div>`).join("")
    : `<div class="empty" style="padding:16px 0">今天暂无课程总结</div>`;
}

/* ================= 课程 ================= */
/* ================= 课程（按课程沉淀） ================= */
function migrateSubjects(db) {
  if (db.subjects) return;
  db.subjects = [];
  const map = {};
  (db.courses || []).forEach((c) => {
    if (!map[c.course]) {
      map[c.course] = { id: uid(), name: c.course, teacher: "", exam: "", notes: "", materials: [], points: [], questions: [] };
      db.subjects.push(map[c.course]);
    }
    const sub = map[c.course];
    if (c.topic) {
      const detail = [ (c.concepts || []).join("\n"), c.keyPoints, c.connections ].filter(Boolean).join("\n\n");
      sub.points.push({ id: uid(), date: c.date, title: c.topic, detail });
    }
    if (c.questions) String(c.questions).split("\n").forEach((q) => q.trim() && sub.questions.push({ id: uid(), date: c.date, text: q.trim(), answer: "", done: false }));
    if (c.nextSteps) sub.notes = (sub.notes ? sub.notes + "\n" : "") + `${c.date}: ${c.nextSteps}`;
  });
}
function subjById(id) { return (state.db.subjects || []).find((x) => x.id === id); }

function renderCourse() {
  migrateSubjects(state.db);
  const kw = (state.courseSearch || "").trim().toLowerCase();
  let subs = state.db.subjects;
  if (kw) subs = subs.filter((s) => [s.name, s.teacher, s.exam, s.notes,
    ...(s.points || []).flatMap((p) => [p.title, p.detail]),
    ...(s.questions || []).map((q) => q.text),
    ...(s.materials || []).map((m) => m.title + " " + (m.url || "")),
  ].join(" ").toLowerCase().includes(kw));
  $("#subjectGrid").innerHTML = subs.length ? subs.map((s) => {
    const openQ = (s.questions || []).filter((q) => !q.done).length;
    return `<div class="panel subject-card" data-sid="${s.id}">
      <div class="subject-head">
        <div class="subject-name">📚 ${esc(s.name)}</div>
        <div class="ops">
          <button class="btn small" data-action="editSubject" title="编辑">✏️</button>
          <button class="btn small danger" data-action="delSubject" title="删除">🗑</button>
        </div>
      </div>
      ${s.teacher ? `<div class="subject-meta">${esc(s.teacher)}</div>` : ""}
      <div class="subject-meta">知识点 ${(s.points || []).length} · 未解决问题 ${openQ} · 资料 ${(s.materials || []).length}</div>
      ${s.exam ? `<div class="note">🎯 ${esc(s.exam.length > 52 ? s.exam.slice(0, 52) + "…" : s.exam)}</div>` : ""}
      <div class="btn-row"><button class="btn small primary" data-action="openSubject">进入课程 →</button></div>
    </div>`;
  }).join("") : `<div class="empty"><span class="empty-ico">📚</span>还没有课程<br><button class="btn small" data-modal="course" style="margin-top:8px">＋ 新建课程</button></div>`;
}

function subjectDetailHTML(s) {
  const tab = state.subjectTab || "points";
  const pts = sortBy(s.points || [], ["date"], -1);
  const qs = sortBy(s.questions || [], ["done", "date"], -1);
  const ms = s.materials || [];
  const tabs = [
    ["points", `知识点 ${pts.length}`], ["questions", `问题 ${qs.filter((q) => !q.done).length}`],
    ["materials", `资料 ${ms.length}`], ["exam", "考试要求"],
  ];
  let body = "";
  if (tab === "points") {
    body = `<form id="subjectPointForm">
        <input type="hidden" id="spSid" value="${s.id}">
        <div class="row2">
          <label class="field">日期<input type="date" id="spDate" required value="${todayISO()}"></label>
          <label class="field">知识点标题<input id="spTitle" required placeholder="如：微分中值定理"></label>
        </div>
        <label class="field">内容（概念 / 方法 / 联系）<textarea id="spDetail" rows="3"></textarea></label>
        <div class="modal-actions"><button class="btn primary" type="submit">保存知识点</button></div>
      </form>
      ${pts.map((p) => `<div class="item" data-sid="${s.id}" data-pid="${p.id}">
        <div class="body">
          <div class="title">${esc(p.title)}</div>
          <div class="meta"><span>${p.date}</span></div>
          ${p.detail ? `<div class="note">${esc(p.detail)}</div>` : ""}
        </div>
        <div class="ops"><button class="btn small danger" data-action="delPoint">删除</button></div>
      </div>`).join("") || '<div class="empty">暂无知识点</div>'}`;
  } else if (tab === "questions") {
    body = `<form id="subjectQuestionForm">
        <input type="hidden" id="sqSid" value="${s.id}">
        <label class="field">问题<input id="sqText" required placeholder="不懂的地方…"></label>
        <label class="field">答案 / 思路（可选，解决后填）<textarea id="sqAnswer" rows="2"></textarea></label>
        <div class="modal-actions"><button class="btn primary" type="submit">保存问题</button></div>
      </form>
      ${qs.map((q) => `<div class="item ${q.done ? "done" : ""}" data-sid="${s.id}" data-qid="${q.id}">
        <input type="checkbox" data-action="toggleQuestion" ${q.done ? "checked" : ""} style="width:17px;height:17px;margin-top:3px">
        <div class="body">
          <div class="title">${esc(q.text)}</div>
          <div class="meta"><span>${q.date || ""}</span>${q.done ? '<span class="badge ok">已解决</span>' : ""}</div>
          ${q.answer ? `<div class="note">💡 ${esc(q.answer)}</div>` : ""}
        </div>
        <div class="ops"><button class="btn small" data-action="editQuestion">答案</button><button class="btn small danger" data-action="delQuestion">删除</button></div>
      </div>`).join("") || '<div class="empty">暂无问题</div>'}`;
  } else if (tab === "materials") {
    body = `<form id="subjectMaterialForm">
        <input type="hidden" id="smSid" value="${s.id}">
        <div class="row2">
          <label class="field">资料名称<input id="smName" required placeholder="如：往年题 / 课件 PPT"></label>
          <label class="field">链接（可选）<input id="smUrl" placeholder="https://…"></label>
        </div>
        <div class="modal-actions"><button class="btn primary" type="submit">保存资料</button></div>
      </form>
      ${ms.map((m) => `<div class="item" data-sid="${s.id}" data-mid="${m.id}">
        <div class="body">
          <div class="title">📎 ${esc(m.title || "未命名资料")}</div>
          ${m.url ? `<div class="note"><a class="link-chip" href="${esc(safeURL(m.url))}" target="_blank" rel="noopener">🔗 打开链接</a></div>` : ""}
        </div>
        <div class="ops"><button class="btn small danger" data-action="delMaterial">删除</button></div>
      </div>`).join("") || '<div class="empty">暂无资料</div>'}`;
  } else {
    body = `<form id="subjectExamForm">
        <input type="hidden" id="seSid" value="${s.id}">
        <label class="field">考试要求（时间 / 形式 / 范围 / 占比）<textarea id="seExam" rows="5" placeholder="如：期末闭卷 40%，重点 1-4 章，允许计算器">${esc(s.exam || "")}</textarea></label>
        <label class="field">备注（复习计划等）<textarea id="seNotes" rows="3">${esc(s.notes || "")}</textarea></label>
        <div class="modal-actions"><button class="btn primary" type="submit">保存</button></div>
      </form>`;
  }
  return `<div class="subject-detail">
    <div class="subject-detail-head">
      <div><div class="subject-name">📚 ${esc(s.name)}</div>${s.teacher ? `<div class="muted small-text">${esc(s.teacher)}</div>` : ""}</div>
    </div>
    <div class="tabs" style="margin:12px 0 14px">
      ${tabs.map(([k, label]) => `<button type="button" data-action="subjectTab" data-tab="${k}" class="${tab === k ? "active" : ""}">${label}</button>`).join("")}
    </div>
    ${body}
  </div>`;
}

/* ================= 重要事项 DDL ================= */
function daysLeft(iso) {
  const a = new Date(todayISO() + "T00:00"), b = new Date(iso + "T00:00");
  return Math.round((b - a) / 86400000);
}
function ddlBadge(t) {
  const d = daysLeft(t.date);
  if (t.done) return ["已完成", "ok"];
  if (d < 0) return [`已过期 ${-d} 天`, "overdue"];
  if (d === 0) return ["今天截止", "overdue"];
  if (d === 1) return ["明天截止", "high"];
  if (d <= 3) return [`${d} 天后`, "high"];
  if (d <= 7) return [`${d} 天后`, ""];
  return [`${d} 天后`, "low"];
}
function ddlItemHTML(t) {
  const [txt, cls] = ddlBadge(t);
  return `<div class="item ${t.done ? "done" : ""}" data-id="${t.id}">
    <input type="checkbox" data-action="toggleDdl" ${t.done ? "checked" : ""} style="width:17px;height:17px;margin-top:3px">
    <div class="body">
      <div class="title">${esc(t.title)}</div>
      <div class="meta"><span class="badge ${cls}">${txt}</span><span>截止 ${t.date}${t.time ? " " + esc(t.time) : ""}</span></div>
      ${t.note ? `<div class="note">${esc(t.note)}</div>` : ""}
    </div>
    <div class="ops"><button class="btn small" data-action="editDdl">编辑</button><button class="btn small danger" data-action="delDdl">删除</button></div>
  </div>`;
}
function renderDeadlines() {
  const all = state.db.deadlines || [];
  const unfinished = sortBy(all.filter((t) => !t.done), ["date", "time"]);
  const finished = sortBy(all.filter((t) => t.done), ["date"], -1);
  const overdue = unfinished.filter((t) => daysLeft(t.date) < 0).length;
  const soon = unfinished.filter((t) => { const d = daysLeft(t.date); return d >= 0 && d <= 7; }).length;
  $("#ddlStats").textContent = unfinished.length ? `未完成 ${unfinished.length} 项 · 7 天内 ${soon} 项${overdue ? ` · 已过期 ${overdue} 项 ⚠️` : ""}` : "全部清空，太棒了 🎉";
  $("#ddlList").innerHTML = (unfinished.length
    ? `<div class="date-group-title">未完成（按截止日期）</div>${unfinished.map(ddlItemHTML).join("")}`
    : `<div class="empty"><span class="empty-ico">🎯</span>没有待办的 DDL</div>`)
    + (finished.length ? `<div class="date-group-title" style="margin-top:18px">已完成</div>${finished.map(ddlItemHTML).join("")}` : "");
}

/* ================= 记账 ================= */
function renderFinance() {
  const month = state.financeMonth;
  const all = state.db.transactions.filter((t) => t.date.startsWith(month));
  const exp = all.filter((t) => t.type === "expense"), inc = all.filter((t) => t.type === "income");
  const mainExp = exp.filter((t) => !t.tripId); // 主账本：不含旅行支出
  const expSum = sum(mainExp, (t) => t.amount), incSum = sum(inc, (t) => t.amount);
  const [fy, fm] = month.split("-").map(Number);
  const isCurMonth = month === todayISO().slice(0, 7);
  const dim = new Date(fy, fm, 0).getDate();
  const dayAvg = { v: isCurMonth ? expSum / new Date().getDate() : expSum / dim, label: isCurMonth ? `按已过 ${new Date().getDate()} 天` : `按整月 ${dim} 天` };
  if (!$("#financeStats").classList.contains("stats-3")) $("#financeStats").classList.add("stats-3");
  const tripExpMonth = sum(all.filter((t) => t.tripId && t.type === "expense"), (t) => t.amount);
  $("#financeStats").innerHTML = `
    <div class="stat-card"><div class="stat-ico">📉</div><div><div class="label">本月支出</div><div class="value red">${money(tripExpMonth ? expSum + tripExpMonth : expSum)}</div><div class="sub">${tripExpMonth ? `主账本 ${money(expSum)} + 旅行 ${money(tripExpMonth)}` : `${mainExp.length} 笔`}</div></div></div>
    <div class="stat-card"><div class="stat-ico">📈</div><div><div class="label">本月收入</div><div class="value green">${money(incSum)}</div><div class="sub">${inc.length} 笔</div></div></div>
    
    <div class="stat-card"><div class="stat-ico">📅</div><div><div class="label">日均支出</div><div class="value">${money(dayAvg.v)}</div><div class="sub">&nbsp;</div></div></div>`;

  const byCat = {};
  mainExp.forEach((t) => (byCat[t.category] = (byCat[t.category] || 0) + Number(t.amount)));
  if (tripExpMonth > 0) byCat["旅行"] = tripExpMonth;
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const total = sum(entries, (e) => e[1]);
  let pie = "";
  if (total > 0) {
    let acc = 0;
    const stops = entries.map((e, i) => { const from = (acc / total) * 100; acc += e[1]; return `${PALETTE[i % PALETTE.length]} ${from}% ${(acc / total) * 100}%`; });
    pie = `<div class="pie" style="background:conic-gradient(${stops.join(",")})"></div>
      <div class="pie-legend">${entries.map((e, i) => `<div class="legend-row"><span><span class="legend-dot" style="background:${PALETTE[i % PALETTE.length]}"></span>${esc(e[0])}</span><b>${money(e[1])} · ${Math.round((e[1] / total) * 100)}%</b></div>`).join("")}
      <div class="legend-row"><span>合计</span><b>${money(total)}</b></div></div>`;
  } else pie = `<div class="empty" style="flex:1">本月暂无支出</div>`;
  $("#financePie").innerHTML = pie;

  const [y, m] = month.split("-").map(Number);
  const dayCnt = new Date(y, m, 0).getDate();
  const byDayMain = Array(dayCnt + 1).fill(0);
  const byDayTrip = Array(dayCnt + 1).fill(0);
  mainExp.forEach((t) => { const d = Number(t.date.slice(8)); if (d <= dayCnt) byDayMain[d] += Number(t.amount); });
  all.filter((t) => t.tripId && t.type === "expense").forEach((t) => { const d = Number(t.date.slice(8)); if (d <= dayCnt) byDayTrip[d] += Number(t.amount); });
  const maxDay = Math.max(...byDayMain.map((v, i) => v + byDayTrip[i]), 1);
  const today = todayISO();
  $("#financeBars").innerHTML = byDayMain.slice(1).map((v, i) => {
    const d = i + 1, dd = `${month}-${String(d).padStart(2, "0")}`;
    const tv = byDayTrip[d];
    const tot = v + tv;
    const h = Math.max((tot / maxDay) * 100, tot > 0 ? 2.5 : 0);
    const mainPct = tot > 0 ? (v / tot) * 100 : 100;
    const bg = tv > 0 ? `linear-gradient(to top, var(--primary) ${mainPct.toFixed(1)}%, var(--warn) ${mainPct.toFixed(1)}%)` : "var(--primary)";
    return `<div class="bar-col" data-tip="${dd} 主账本 ${money(v)}${tv ? ` + 旅行 ${money(tv)} = ${money(tot)}` : ""}"><div class="bar" style="height:${h}%; background:${bg}"></div><div class="bar-label ${dd === today ? "today" : ""}">${d % 5 === 0 || d === 1 ? d : ""}</div></div>`;
  }).join("");

  // 旅行账本面板
  const trips = sortBy(state.db.trips || [], ["startDate"], -1);
  const tripPanelEl = $("#tripPanel");
  if (tripPanelEl) { tripPanelEl.innerHTML = `<div class="panel">
    <div class="panel-head"><h3>✈️ 旅行账本</h3><button class="btn small primary" data-modal="trip">＋ 新建旅行</button></div>
    ${trips.length ? `<div class="trip-grid">${trips.map((t) => {
      const n = (state.db.transactions || []).filter((x) => x.tripId === t.id).length;
      return `<div class="trip-card">
        <div class="subject-head"><div class="subject-name">✈️ ${esc(t.city)}</div>
          <div class="ops"><button class="btn small" data-action="editTrip" data-tid="${t.id}">✏️</button><button class="btn small danger" data-action="delTrip" data-tid="${t.id}">🗑</button></div></div>
        <div class="subject-meta">${t.startDate}${t.endDate ? " ~ " + t.endDate : ""} · ${n} 笔</div>
        <div class="trip-total">${money(tripTotal(t.id))}</div>
        <div class="btn-row"><button class="btn small primary" data-action="openTrip" data-tid="${t.id}">查看账单 →</button></div>
      </div>`;
    }).join("")}</div>` : `<div class="empty" style="padding:14px 0">还没有旅行账本，点右上角「＋ 新建旅行」创建一个</div>`}
  </div>`;
  }
  $("#transList").innerHTML = all.length
    ? `<div class="date-group-title">${month} 共 ${all.length} 笔</div>${sortBy(all, ["date"], -1).map((t) => `
      <div class="item transaction-item" data-id="${t.id}">
        <div class="body">
          <div class="title">${esc(t.category)}${t.note ? " · " + esc(t.note) : ""}</div>
          <div class="meta"><span>${t.date}</span><span class="badge ${t.type}">${t.type === "income" ? "收入" : "支出"}</span>${t.tripId ? '<span class="badge">旅行</span>' : ""}</div>
        </div>
        <b style="color:${t.type === "income" ? "var(--ok)" : "var(--danger)"}">${t.type === "income" ? "+" : "-"}${money(t.amount)}</b>
        <div class="ops"><button class="btn small" data-action="editTrans">编辑</button><button class="btn small danger" data-action="delTrans">删除</button></div>
      </div>`).join("")}`
    : `<div class="empty"><span class="empty-ico">💰</span>本月暂无记录<br><button class="btn small" data-modal="trans" style="margin-top:8px">＋ 记一笔</button></div>`;
}

function tripDetailHTML(trip) {
  const list = sortBy((state.db.transactions || []).filter((t) => t.tripId === trip.id), ["date"]);
  const exp = list.filter((t) => t.type === "expense");
  const byCat = {};
  exp.forEach((t) => (byCat[t.category] = (byCat[t.category] || 0) + Number(t.amount)));
  const total = sum(exp, (t) => t.amount);
  return `<div class="subject-detail">
    <div class="subject-detail-head">
      <div><div class="subject-name">✈️ ${esc(trip.city)}</div>
      <div class="muted small-text">${trip.startDate}${trip.endDate ? " ~ " + trip.endDate : ""}${trip.note ? " · " + esc(trip.note) : ""}</div></div>
      <div class="trip-total" style="font-size:22px">${money(total)}</div>
    </div>
    ${Object.keys(byCat).length ? `<div class="panel slim" style="margin:10px 0">${Object.entries(byCat).sort((x, y) => y[1] - x[1]).map(([c, v]) => `<div class="legend-row"><span>${esc(c)}</span><b>${money(v)} · ${Math.round(v / total * 100)}%</b></div>`).join("")}</div>` : ""}
    ${list.length ? list.map((t) => `<div class="item transaction-item" data-id="${t.id}">
      <div class="body"><div class="title">${esc(t.category)}${t.note ? " · " + esc(t.note) : ""}</div>
      <div class="meta"><span>${t.date}</span><span class="badge ${t.type}">${t.type === "income" ? "收入" : "支出"}</span></div></div>
      <b style="color:${t.type === "income" ? "var(--ok)" : "var(--danger)"}">${t.type === "income" ? "+" : "-"}${money(t.amount)}</b>
      <div class="ops"><button class="btn small" data-action="editTrans">编辑</button><button class="btn small danger" data-action="delTrans">删除</button></div>
    </div>`).join("") : '<div class="empty">该旅行还没有账单（记一笔时选择归属此旅行即可）</div>'}
  </div>`;
}

/* ================= 回顾 ================= */
function buildReview(date) {
  const db = state.db;
  const subjPts = [];
  (db.subjects || []).forEach((sub) => (sub.points || []).forEach((p) => { if (p.date === date) subjPts.push({ course: sub.name, topic: p.title, detail: p.detail }); }));
  const trans = db.transactions.filter((t) => t.date === date);
  const exp = sum(trans.filter((t) => t.type === "expense"), (t) => t.amount);
  const inc = sum(trans.filter((t) => t.type === "income"), (t) => t.amount);
  const L = [`# ${date} 每日回顾`, "", "## 课程"];
  if (subjPts.length) subjPts.forEach((p) => {
    L.push(`- ${p.course}｜${p.topic}`);
    if (p.detail) L.push(`  - ${p.detail.split("\n")[0]}`);
  }); else L.push("-（无记录）");
  L.push("", "## 收支");
  trans.forEach((t) => L.push(`- ${t.type === "income" ? "收入" : "支出"} ${money(t.amount)} ${t.category}${t.note ? "（" + t.note + "）" : ""}`));
  L.push(`- 小计：支出 ${money(exp)}，收入 ${money(inc)}`);
  const nearDdls = sortBy((db.deadlines || []).filter((t) => !t.done && daysLeft(t.date) <= 7), ["date", "time"]);
  if (nearDdls.length) {
    L.push("", "## 近期 DDL（7 天内）");
    nearDdls.forEach((t) => L.push(`- ${t.date}${t.time ? " " + t.time : ""} ${t.title}（${daysLeft(t.date) < 0 ? "已过期" + (-daysLeft(t.date)) + "天" : daysLeft(t.date) === 0 ? "今天" : daysLeft(t.date) + "天后"}）`));
  }
  return L.join("\n");
}
let reviewDirty=false, reviewDraftDate=null;
function loadReview(date) {
  if(reviewDirty && reviewDraftDate===date)return;
  $("#reviewOutput").value=state.db.reviews[date] || buildReview(date);
  reviewDraftDate=date; reviewDirty=false;
}
function renderReview() {
  if (state.reviewTab === "daily") {
    if (!$("#reviewDate").value) $("#reviewDate").value = todayISO();
    loadReview($("#reviewDate").value);
    $("#reviewSavedHint").textContent = state.db.reviews[$("#reviewDate").value] ? "已保存过此日回顾" : "";
  } else renderWeekly();
}
function renderWeekly() {
  const today = todayISO();
  const mon = mondayOf(addDays(today, state.weekOffset * 7));
  const days = weekDates(mon), sun = days[6];
  const d1 = new Date(mon + "T00:00");
  const weekNo = Math.ceil(((d1 - new Date(d1.getFullYear(), 0, 1)) / 86400000 + new Date(d1.getFullYear(), 0, 1).getDay()) / 7);
  $("#weekLabel").textContent = `${d1.getFullYear()} 年第 ${weekNo} 周（${mon.slice(5)} ~ ${sun.slice(5)}）`;

  const trans = state.db.transactions.filter((t) => t.date >= mon && t.date <= sun);
  const exp = sum(trans.filter((t) => t.type === "expense"), (t) => t.amount);
  const inc = sum(trans.filter((t) => t.type === "income"), (t) => t.amount);
  const subjNames = new Set(); let pointCnt = 0;
  (state.db.subjects || []).forEach((sub) => (sub.points || []).forEach((p) => { if (p.date >= mon && p.date <= sun) { pointCnt++; subjNames.add(sub.name); } }));
  const byCat = {};
  trans.filter((t) => t.type === "expense").forEach((t) => (byCat[t.category] = (byCat[t.category] || 0) + Number(t.amount)));
  const topCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $("#weeklyContent").innerHTML = `
    <div class="stats-grid stats-2">
      <div class="stat-card"><div class="stat-ico">💰</div><div><div class="label">本周支出</div><div class="value red">${money(exp)}</div><div class="sub">收入 ${money(inc)}</div></div></div>
      <div class="stat-card"><div class="stat-ico">📚</div><div><div class="label">课程总结</div><div class="value">${pointCnt} 篇</div><div class="sub">${[...subjNames].map(esc).join("、") || "暂无"}</div></div></div>
    </div>
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><h3>支出 Top 分类</h3></div>
        ${topCats.length ? topCats.map(([c, v]) => `<div class="legend-row"><span>${esc(c)}</span><b>${money(v)}</b></div>`).join("") : '<div class="empty">本周暂无支出</div>'}
      </div>
      <div class="panel"><div class="panel-head"><h3>每日收支</h3></div>
        ${days.map((d) => {
          const daily = trans.filter((t) => t.date === d);
          return `<div class="legend-row"><span>${fmtCN(d)}</span><b>支出 ${money(sum(daily.filter((t) => t.type === "expense"), (t) => t.amount))} · 收入 ${money(sum(daily.filter((t) => t.type === "income"), (t) => t.amount))}</b></div>`;
        }).join("")}
      </div>
    </div>`;
}

/* ================= 示例数据 ================= */
function loadSample() {
  const t = todayISO();
  migrateSubjects(state.db);
  if (!state.db.subjects.some((x) => x.name === "高等数学")) {
    state.db.subjects.push({
      id: uid(), name: "高等数学", teacher: "张老师 · 4学分",
      exam: "期末闭卷占 40%，重点第 1-4 章，可带无存储计算器。",
      notes: "第 8 周前完成习题 3-2。",
      materials: [{ id: uid(), title: "往年期末题", url: "https://example.com" }],
      points: [{ id: uid(), date: t, title: "微分中值定理与洛必达法则", detail: "罗尔定理\n拉格朗日中值定理\n洛必达前必须验证 0/0 或 ∞/∞" }],
      questions: [{ id: uid(), date: t, text: "柯西中值定理什么时候用？", answer: "", done: false }],
    });
  }
  state.db.transactions.push(
    { id: uid(), date: t, type: "expense", amount: 15.5, category: "餐饮", note: "午饭" },
    { id: uid(), date: t, type: "expense", amount: 89, category: "书籍", note: "二手教材" },
    { id: uid(), date: t, type: "income", amount: 200, category: "兼职", note: "助教补贴" },
  );
  if (!(state.db.trips || []).length) {
    const tid = uid();
    state.db.trips.push({ id: tid, city: "北京", startDate: addDays(t, -3), endDate: addDays(t, -1), note: "国庆前的周末游" });
    state.db.transactions.push(
      { id: uid(), date: addDays(t, -3), type: "expense", amount: 553, category: "交通", note: "往返高铁", tripId: tid },
      { id: uid(), date: addDays(t, -2), type: "expense", amount: 128, category: "餐饮", note: "四季民福", tripId: tid },
      { id: uid(), date: addDays(t, -2), type: "expense", amount: 60, category: "娱乐", note: "故宫门票", tripId: tid },
    );
  }
  (state.db.deadlines = state.db.deadlines || []).push({ id: uid(), title: "高数作业第三章", date: addDays(t, 2), time: "23:59", note: "习题 3-1 ~ 3-5", done: false });
  save(); render();
}

/* ================= CSV ================= */
function exportCSV() {
  const rows = [["日期", "类型", "金额", "分类", "旅行", "备注"]];
  sortBy(state.db.transactions, ["date"]).forEach((t) => rows.push([t.date, t.type === "income" ? "收入" : "支出", t.amount.toFixed(2), t.category, (state.db.trips || []).find((x) => x.id === t.tripId)?.city || "", t.note || ""]));
  const csv = "\uFEFF" + rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
  DashboardSync.download(`记账明细-${todayISO()}.csv`,csv,"text/csv").catch(e=>toast(e.message));
}

/* ================= 表单提交 ================= */
function submitDeadline() {
  const id = $("#deadlineId").value;
  if (!validateTime("ddlTime")) { alert("时间填写有误：时（0-23）和分（0-59）需成对填写，或都留空。"); return false; }
  const time = $("#ddlTime").value;
  const data = { title: $("#ddlTitle").value.trim(), date: $("#ddlDate").value, time, note: $("#ddlNote").value.trim() };
  if (!data.title || !data.date) return false;
  if (id) Object.assign((state.db.deadlines || []).find((x) => x.id === id), data);
  else (state.db.deadlines = state.db.deadlines || []).push({ id: uid(), done: false, ...data });
}
function submitTrip() {
  const id = $("#tripId").value;
  const city = $("#tripCity").value.trim();
  if (!city) return false;
  const data = { city, startDate: $("#tripStart").value, endDate: $("#tripEnd").value, note: $("#tripNote").value.trim() };
  if (!data.startDate) return false;
  if (data.endDate && data.endDate < data.startDate) { alert("结束日期不能早于开始日期"); return false; }
  if (id) Object.assign((state.db.trips || []).find((x) => x.id === id), data);
  else (state.db.trips = state.db.trips || []).push({ id: uid(), ...data });
}
function submitSubject() {
  const id = $("#subjectId").value;
  const name = $("#subjectName").value.trim();
  if (!name) return;
  if (id) Object.assign(subjById(id), { name, teacher: $("#subjectTeacher").value.trim() });
  else state.db.subjects.push({ id: uid(), name, teacher: $("#subjectTeacher").value.trim(), exam: "", notes: "", materials: [], points: [], questions: [] });
}
function submitSubjectPoint() {
  const sub = subjById($("#spSid").value);
  if (!sub) return;
  const title = $("#spTitle").value.trim();
  if (!title) return;
  sub.points.push({ id: uid(), date: $("#spDate").value || todayISO(), title, detail: $("#spDetail").value.trim() });
}
function submitSubjectQuestion() {
  const sub = subjById($("#sqSid").value);
  if (!sub) return;
  const text = $("#sqText").value.trim();
  if (!text) return;
  sub.questions.push({ id: uid(), date: todayISO(), text, answer: $("#sqAnswer").value.trim(), done: false });
}
function submitSubjectMaterial() {
  const sub = subjById($("#smSid").value);
  if (!sub) return;
  const title = $("#smName").value.trim();
  if (!title) return;
  sub.materials.push({ id: uid(), title, url: $("#smUrl").value.trim() });
}
function submitSubjectExam() {
  const sub = subjById($("#seSid").value);
  if (!sub) return;
  sub.exam = $("#seExam").value;
  sub.notes = $("#seNotes").value;
}

function submitTrans() {
  const id = $("#transId").value;
  const data = { date: $("#transDate").value, type: segVal("transTypeSeg"), amount: Number($("#transAmount").value), category: $("#transCategory").value, note: $("#transNote").value.trim(), tripId: $("#transTrip").value };
  if (!data.amount || data.amount <= 0) return;
  if (id) Object.assign(state.db.transactions.find((x) => x.id === id), data);
  else state.db.transactions.push({ id: uid(), ...data });
}
/* ================= 事件 ================= */
function bindEvents() {
  // 手机端底部导航（复用侧边栏定义）
  $("#bottomNav").innerHTML = $$("#nav button").map((b) => {
    const label = b.cloneNode(true);
    label.querySelector(".nav-ico").remove();
    return `<button data-view="${b.dataset.view}" class="${b.classList.contains("active") ? "active" : ""}" ${b.classList.contains("active") ? 'aria-current="page"' : ""}><span class="nav-ico" aria-hidden="true">${b.querySelector(".nav-ico").textContent}</span><span>${esc(label.textContent.trim())}</span></button>`;
  }).join("");
  $$("#nav button, #bottomNav button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  $("#themeBtn").addEventListener("click", toggleTheme);
  $("#settingsBtn").addEventListener("click", () => openModal("settings"));
  $("#modalClose").addEventListener("click", closeModal);
  $("#modalOverlay").addEventListener("click", (e) => { if (e.target === $("#modalOverlay")) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if ($("#modalOverlay").hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
    if (e.key !== "Tab") return;
    const focusable = $$(".modal button, .modal input:not([type=hidden]), .modal select, .modal textarea, .modal a[href], .modal summary").filter(el => !el.disabled && el.getClientRects().length);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // 弹窗内：分段控件 / 关闭 / 文件导入 / 设置
  $("#modalBody").addEventListener("click", async (e) => {
    const segBtn = e.target.closest(".segmented button");
    if (segBtn) {
      const seg = segBtn.closest(".segmented");
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === segBtn));
      const hidden = $("#" + seg.id.replace("Seg", "Val"));
      if (hidden) hidden.value = segBtn.dataset.v;
      if (seg.id === "transTypeSeg") refreshCatOptions();
      return;
    }
    if (e.target.closest("[data-close]")) { closeModal(); return; }
    if (e.target.id === "catsSaveBtn") {
      state.db.settings.categories = parseTags($("#expenseCats").value);
      state.db.settings.incomeCategories = parseTags($("#incomeCats").value);
      if (!state.db.settings.categories.length) state.db.settings.categories = ["其他"];
      if (!state.db.settings.incomeCategories.length) state.db.settings.incomeCategories = ["其他"];
      save(); closeModal(); return;
    }
    if (e.target.id === "importBtn") { $("#importFile").click(); return; }
    if (e.target.id === "sampleBtn") { if (confirm("加载几条示例数据？")) { loadSample(); closeModal(); } return; }
  });

  $("#modalBody").addEventListener("focusout", (e) => {
    if (/^ddlTime[HM]$/.test(e.target.id)) normalizeTimeInput(e.target);
  });
  $("#modalBody").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = e.target.id;
    if (id === "deadlineForm") { if (submitDeadline() === false) return; }
    else if (id === "transForm") submitTrans();
    else if (id === "subjectForm") submitSubject();
    else if (id === "tripForm") submitTrip();
    else if (id === "subjectPointForm") submitSubjectPoint();
    else if (id === "subjectQuestionForm") submitSubjectQuestion();
    else if (id === "subjectMaterialForm") submitSubjectMaterial();
    else if (id === "subjectExamForm") submitSubjectExam();
    else return;
    if (id === "subjectPointForm" || id === "subjectQuestionForm" || id === "subjectMaterialForm" || id === "subjectExamForm") {
      const names = { subjectPointForm: "知识点", subjectQuestionForm: "问题", subjectMaterialForm: "资料", subjectExamForm: "考试要求" };
      toast(`✅ ${names[id]}已保存`);
    }
    closeModal(); save(); render();
  });

  // 弹窗字段与数据导入
  $("#modalBody").addEventListener("change", async (e) => {
    if (e.target.id === "transDate") autoPickTrip(e.target.value);
    if (e.target.id === "importFile") {
      const f = e.target.files[0]; if (!f) return;
      if (!confirm("将备份与现有记录合并，不会清空本地数据；同一记录的不同内容会保留待核对。继续？")) { e.target.value = ""; return; }
      try {
        const data = JSON.parse(await f.text());
        if (!Array.isArray(data.todos) || !Array.isArray(data.transactions)) throw new Error("格式不像本面板导出的文件");
        await syncClient.importData(data);
        closeModal(); state.db=syncClient.takeView();
        applyTheme(state.db.settings.theme); render();
        toast("备份已合并，原有记录已保留");
      } catch (err) { alert("导入失败：" + err.message); }
      e.target.value = "";
    }
  });

  // 全局按钮（打开弹窗 / 跳转视图）
  document.addEventListener("click", async (e) => {
    const open = e.target.closest("[data-modal]");
    if (open) {
      const type = open.dataset.modal;
      openModal(type);
      return;
    }
    const goto = e.target.closest("[data-goto]");
    if (goto) { switchView(goto.dataset.goto); return; }
    // 列表操作
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    const id = el.closest(".item, .mini-row")?.dataset.id;
    const db = state.db;
    const find = (arr) => arr.find((x) => x.id === id);

    if (action === "openSubject") {
      const sub = subjById(el.closest("[data-sid]").dataset.sid);
      if (sub) { state.subjectTab = "points"; openWideModal(sub.name, subjectDetailHTML(sub)); }
    } else if (action === "editSubject") {
      const sub = subjById(el.closest("[data-sid]").dataset.sid);
      openModal("course", true);
      $("#subjectId").value = sub.id; $("#subjectName").value = sub.name; $("#subjectTeacher").value = sub.teacher || "";
    } else if (action === "delSubject") {
      const sid = el.closest("[data-sid]").dataset.sid;
      const sub = subjById(sid);
      if (confirm(`删除课程「${sub.name}」及其全部知识点/问题/资料？`)) { state.db.subjects = state.db.subjects.filter((x) => x.id !== sid); save(); render(); }
    } else if (action === "subjectTab") {
      state.subjectTab = el.dataset.tab;
      const sub = subjById(el.closest("[data-sid]")?.dataset.sid || $("#spSid")?.value || $("#sqSid")?.value || $("#smSid")?.value || $("#seSid")?.value);
      if (sub) openWideModal(sub.name, subjectDetailHTML(sub));
    } else if (action === "delPoint") {
      const w = el.closest("[data-sid],[data-pid]"); const sub = subjById(w.dataset.sid);
      sub.points = sub.points.filter((p) => p.id !== w.dataset.pid); save();
      openWideModal(sub.name, subjectDetailHTML(sub)); render();
    } else if (action === "toggleQuestion") return; // 用 change 处理
    else if (action === "editQuestion") {
      const w = el.closest("[data-sid],[data-qid]"); const sub = subjById(w.dataset.sid);
      const q = sub.questions.find((x) => x.id === w.dataset.qid);
      const ans = prompt("答案 / 思路（留空保持不变）：", q.answer || "");
      if (ans !== null) { q.answer = ans; save(); openWideModal(sub.name, subjectDetailHTML(sub)); }
    } else if (action === "delQuestion") {
      const w = el.closest("[data-sid],[data-qid]"); const sub = subjById(w.dataset.sid);
      sub.questions = sub.questions.filter((x) => x.id !== w.dataset.qid); save();
      openWideModal(sub.name, subjectDetailHTML(sub)); render();
    } else if (action === "delMaterial") {
      const w = el.closest("[data-sid],[data-mid]"); const sub = subjById(w.dataset.sid);
      sub.materials = sub.materials.filter((m) => m.id !== w.dataset.mid); save();
      openWideModal(sub.name, subjectDetailHTML(sub)); render();
    } else if (action === "editTrans") {
      const t = find(db.transactions); openModal("trans", true);
      $("#transId").value = t.id; $("#transDate").value = t.date; setSeg("transTypeSeg", t.type);
      refreshCatOptions(); $("#transCategory").value = t.category;
      $("#transAmount").value = t.amount; $("#transNote").value = t.note || "";
      refreshTripOptions(t.tripId || "");
    } else if (action === "delTrans") {
      if (confirm("删除这笔记录？")) { db.transactions = db.transactions.filter((x) => x.id !== id); save(); render(); }
    } else if (action === "editDdl") {
      const t = (state.db.deadlines || []).find((x) => x.id === id);
      openModal("deadline", true);
      $("#deadlineId").value = t.id; $("#ddlTitle").value = t.title; $("#ddlDate").value = t.date;
      setTimeVal("ddlTime", t.time || ""); $("#ddlNote").value = t.note || "";
    } else if (action === "delDdl") {
      if (confirm("删除这条 DDL？")) { state.db.deadlines = state.db.deadlines.filter((x) => x.id !== id); save(); render(); }
    } else if (action === "dashDoneDdl") {
      const t = (state.db.deadlines || []).find((x) => x.id === el.closest(".mini-row").dataset.id);
      if (t) { t.done = true; save(); render(); }
    } else if (action === "openTrip") {
      const trip = (state.db.trips || []).find((x) => x.id === el.dataset.tid);
      if (trip) openWideModal(`${trip.city} · 旅行账单`, tripDetailHTML(trip));
    } else if (action === "editTrip") {
      const trip = (state.db.trips || []).find((x) => x.id === el.dataset.tid);
      openModal("trip", true);
      $("#tripId").value = trip.id; $("#tripCity").value = trip.city; $("#tripStart").value = trip.startDate;
      $("#tripEnd").value = trip.endDate || ""; $("#tripNote").value = trip.note || "";
    } else if (action === "delTrip") {
      const trip = (state.db.trips || []).find((x) => x.id === el.dataset.tid);
      const n = (state.db.transactions || []).filter((x) => x.tripId === trip.id).length;
      if (confirm(`删除旅行「${trip.city}」？${n ? `其中 ${n} 笔账单会保留并回到主账本。` : ""}`)) {
        state.db.trips = state.db.trips.filter((x) => x.id !== trip.id);
        (state.db.transactions || []).forEach((x) => { if (x.tripId === trip.id) x.tripId = ""; });
        save(); render();
      }
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.dataset?.action === "toggleQuestion") {
      const w = e.target.closest("[data-sid],[data-qid]");
      const sub = subjById(w.dataset.sid);
      const q = sub.questions.find((x) => x.id === w.dataset.qid);
      if (q) { q.done = e.target.checked; save(); openWideModal(sub.name, subjectDetailHTML(sub)); render(); }
      return;
    }
    if (e.target.dataset?.action === "toggleDdl") {
      const t = (state.db.deadlines || []).find((x) => x.id === e.target.closest(".item").dataset.id);
      if (t) { t.done = e.target.checked; save(); render(); }
      return;
    }
  });

  // 课程 / 记账筛选
  $("#courseSearch").addEventListener("input", (e) => { state.courseSearch = e.target.value; renderCourse(); });
  $("#financeMonth").addEventListener("change", (e) => { state.financeMonth = e.target.value; renderFinance(); });
  $("#csvBtn").addEventListener("click", exportCSV);

  // 回顾
  $$("#reviewTabs button").forEach((b) => b.addEventListener("click", () => {
    state.reviewTab = b.dataset.rtab;
    $$("#reviewTabs button").forEach((x) => x.classList.toggle("active", x === b));
    $("#reviewDaily").hidden = state.reviewTab !== "daily";
    $("#reviewWeekly").hidden = state.reviewTab !== "weekly";
    renderReview();
  }));
  $("#reviewOutput").addEventListener("input",()=>{reviewDirty=true;});
  $("#reviewDate").addEventListener("change", (e) => {
    if(reviewDirty && !confirm("当前回顾尚未保存，切换日期会丢弃编辑框中的草稿。继续？")){e.target.value=reviewDraftDate;return;}
    reviewDirty=false; loadReview(e.target.value || todayISO());
    $("#reviewSavedHint").textContent=state.db.reviews[e.target.value]?"已保存过此日回顾":"";
  });
  $("#reviewGenBtn").addEventListener("click", () => {
    const d = $("#reviewDate").value || todayISO(), ta = $("#reviewOutput");
    if (ta.value && ta.value !== (state.db.reviews[d] || "") && !confirm("重新生成会覆盖编辑框内容（不影响已保存版本）。继续？")) return;
    ta.value = buildReview(d); reviewDirty=true; reviewDraftDate=d;
  });
  $("#reviewSaveBtn").addEventListener("click", () => {
    const d = $("#reviewDate").value || todayISO();
    state.db.reviews[d] = $("#reviewOutput").value; reviewDirty=false; save();
    $("#reviewSavedHint").textContent = "✅ 已保存";
  });
  $("#reviewCopyBtn").addEventListener("click", async () => {
    const txt = $("#reviewOutput").value; if (!txt) return;
    try { await navigator.clipboard.writeText(txt); } catch { $("#reviewOutput").select(); document.execCommand("copy"); }
    $("#reviewCopyBtn").textContent = "✅ 已复制"; setTimeout(() => ($("#reviewCopyBtn").textContent = "📋 复制"), 1500);
  });
  $("#weekPrevBtn").addEventListener("click", () => { state.weekOffset--; renderWeekly(); });
  $("#weekNextBtn").addEventListener("click", () => { state.weekOffset++; renderWeekly(); });
}

/* ================= 启动 ================= */
window.addEventListener("error", (e) => {
  console.error(e.error || e.message);
  let b = $("#jsErrorBanner");
  if (!b) { b = document.createElement("div"); b.id = "jsErrorBanner"; b.className = "save-banner"; b.style.background = "#e5484d"; document.body.appendChild(b); }
  b.hidden = false;
  b.textContent = "⚠️ 页面脚本出错：" + (e.message || "未知错误") + (DashboardSync.native ? " —— 请退出重开；若持续出现请反馈，请勿卸载或清除数据。" : " —— 请按 Ctrl+F5 强制刷新；若持续出现请反馈");
});

(async function init() {
  try {
    await load();
  } catch (e) {
    document.body.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center">
      <div style="max-width:520px">
        <div style="font-size:44px">🔌</div>
        <h2>暂时无法打开面板</h2>
        <p>${esc(e.message)}</p>
        <p style="color:#69718a">${DashboardSync.native ? "请勿卸载或清除应用数据，可先退出重开；若仍失败请保留报错反馈。" : "请双击 Windows 桌面上的「启动面板.vbs」启动服务，然后回来刷新本页。"}<br>已停止写入，原有文件和离线缓存不会被清空。</p>
      </div>
    </div>`;
    return;
  }
  $("#financeMonth").value = state.financeMonth;
  $("#reviewDate").value = todayISO();
  bindEvents();
  initViewportLayout();
  render();
  syncClient.status();
  syncClient.start();
})();
