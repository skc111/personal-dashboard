/* Opaque settings records keep encrypted notes compatible with older sync clients. */
const Moments = (() => {
  const vaultPrefix = "moments-vault-";
  const entryPrefix = "moments-note-";
  const maxTags = 8;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function base64(bytes) {
    let text = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(text);
  }

  function fromBase64(text) {
    return Uint8Array.from(atob(text), ch => ch.charCodeAt(0));
  }

  async function deriveKey(password, vault) {
    const salt = Uint8Array.from(vault.match(/../g), byte => parseInt(byte, 16));
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
      material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }

  function cipherParams(name, vault, iv) {
    return { name: "AES-GCM", iv, additionalData: encoder.encode(`dashboard-moments-v1:${name}:${vault}`) };
  }

  async function seal(key, name, vault, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(cipherParams(name, vault, iv), key, encoder.encode(JSON.stringify(value)));
    return { version: 1, vault, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
  }

  async function unseal(key, name, packet) {
    if (packet?.version !== 1 || typeof packet.ciphertext !== "string") throw Error("无法读取加密记录");
    const bytes = await crypto.subtle.decrypt(cipherParams(name, packet.vault, fromBase64(packet.iv)), key, fromBase64(packet.ciphertext));
    return JSON.parse(decoder.decode(bytes));
  }

  async function createVault(password) {
    const vault = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
    const name = vaultPrefix + vault;
    const key = await deriveKey(password, vault);
    return { name, key, packet: await seal(key, name, vault, "dashboard-moments") };
  }

  async function unlockVault(password, name, packet) {
    const vault = name.slice(vaultPrefix.length);
    if (!/^[a-f0-9]{32}$/.test(vault) || packet?.vault !== vault) throw Error("无法读取密码设置");
    const key = await deriveKey(password, vault);
    if (await unseal(key, name, packet) !== "dashboard-moments") throw Error("无法读取密码设置");
    return key;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createVault, unlockVault, seal, unseal };
    return;
  }

  let keys = new Map();
  let entries = [];
  let renderRequest = 0;
  let lockGeneration = 0;
  let filter = "all";
  let calendarMonth = "";
  let calendarDays = new Map();
  let randomized = "";
  let hiddenAt = 0;
  const root = () => $("#view-moments");
  const settings = () => state.db.settings;
  const vaultNames = () => Object.keys(settings()).filter(name => /^moments-vault-[a-f0-9]{32}$/.test(name)).sort();
  const isPrivateName = name => name.startsWith(vaultPrefix) || name.startsWith(entryPrefix);

  function lock() {
    lockGeneration++;
    renderRequest++;
    keys.clear();
    entries = [];
    filter = "all";
    calendarMonth = "";
    calendarDays.clear();
    randomized = "";
    if ($("#modalBody [data-private-moment]")) closeModal();
    root().replaceChildren();
    if (state.view === "moments") renderLocked();
  }

  function renderLocked() {
    const setup = !vaultNames().length;
    const existing = $("#momentUnlock");
    if (existing?.dataset.setup === String(setup)) return;
    root().innerHTML = `
      <div class="moment-lock">
        <div class="moment-lock-icon" aria-hidden="true">♡</div>
        <h2>我们的点滴</h2>
        <p>${setup ? "设置密码，开启你的私人纪念册。" : "输入密码，翻开你的私人纪念册。"}</p>
        <form id="momentUnlock" data-setup="${setup}">
          <label class="field">密码<input name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}" required maxlength="256"></label>
          ${setup ? '<label class="field">确认密码<input name="confirmation" type="password" autocomplete="new-password" required maxlength="256"></label>' : ""}
          <p class="moment-error" role="status" hidden></p>
          <button class="btn primary moment-primary" type="submit">${setup ? "设置并进入" : "解锁"}</button>
        </form>
      </div>`;
  }

  async function unlock(form) {
    const password = form.elements.password.value;
    const setup = form.dataset.setup === "true";
    const button = form.querySelector("button[type=submit]");
    const error = form.querySelector(".moment-error");
    if (button.disabled) return;
    error.hidden = true;
    if (!password.trim() || (setup && password !== form.elements.confirmation.value)) {
      error.textContent = "请填写密码，并确认两次输入一致。";
      error.hidden = false;
      return;
    }
    form.reset();
    button.disabled = true;
    const generation = lockGeneration;
    const stillHere = () => generation === lockGeneration && state.view === "moments";
    try {
      const loaded = new Map();
      if (setup) {
        const vault = await createVault(password);
        if (!stillHere()) return;
        if (vaultNames().length) { renderLocked(); return; }
        settings()[vault.name] = vault.packet;
        await syncClient.commit(state.db);
        loaded.set(vault.packet.vault, vault.key);
      } else {
        const names = vaultNames();
        for (const name of names) {
          const packet = settings()[name];
          try { loaded.set(packet.vault, await unlockVault(password, name, packet)); } catch {}
          if (!stillHere()) return;
        }
      }
      if (!loaded.size) throw Error("密码不正确，请再试一次。");
      if (stillHere()) { keys = loaded; render(); }
    } catch (err) {
      if (!stillHere()) return;
      error.textContent = setup ? "密码设置未确认保存，请查看保存提示。" : err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  }

  function validPhoto(photo) {
    return typeof photo === "string" && photo.length <= 165000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(photo);
  }

  function knownTags() {
    return [...new Set(entries.flatMap(({ record }) => record.tags).filter(Boolean))];
  }

  function updateTagFilter() {
    const select = $("#momentTagFilter");
    const selected = select.value;
    select.replaceChildren(new Option("全部标签", ""), ...knownTags().map(tag => new Option(tag, tag)));
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
  }

  function monthLabel(month) {
    const [year, number] = month.split("-");
    return `${year} 年 ${Number(number)} 月`;
  }

  function shiftedMonth(direction) {
    const date = new Date(calendarMonth + "-01T12:00:00");
    date.setMonth(date.getMonth() + direction);
    const year = date.getFullYear();
    if (year < 1 || year > 9999) return calendarMonth;
    return `${String(year).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function renderCalendar(jumpToMatch = false) {
    const grid = $("#momentCalendarGrid");
    if (!grid) return;
    const today = todayISO();
    const currentMonth = today.slice(0, 7);
    calendarMonth ||= currentMonth;
    const query = $("#momentSearch").value.trim().toLowerCase();
    const tag = $("#momentTagFilter").value;
    const isFiltered = !!(query || tag || filter === "favorite");

    calendarDays = new Map();
    for (const entry of entries) {
      const { record } = entry;
      if (filter === "favorite" && !record.favorite) continue;
      if (tag && !record.tags.includes(tag)) continue;
      if (query && ![record.title, record.body, record.date, ...record.tags].some(text => text.toLowerCase().includes(query))) continue;
      if (!calendarDays.has(record.date)) calendarDays.set(record.date, []);
      calendarDays.get(record.date).push(entry);
    }

    const activeMonths = [...new Set([...calendarDays.keys()].map(day => day.slice(0, 7)))];
    if (jumpToMatch && isFiltered && activeMonths.length && !activeMonths.includes(calendarMonth)) {
      calendarMonth = activeMonths[0];
    }

    $("#momentRandom").disabled = !entries.length;
    root().querySelectorAll("[data-moment-filter]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.momentFilter === filter));
    });
    $("#momentMonthLabel").textContent = monthLabel(calendarMonth);
    $("#momentPrevMonth").disabled = shiftedMonth(-1) === calendarMonth;
    $("#momentNextMonth").disabled = shiftedMonth(1) === calendarMonth;
    $("#momentToday").disabled = calendarMonth === currentMonth;

    const first = new Date(calendarMonth + "-01T12:00:00");
    const leading = (first.getDay() + 6) % 7;
    const monthEnd = new Date(first);
    monthEnd.setMonth(monthEnd.getMonth() + 1, 0);
    const daysInMonth = monthEnd.getDate();
    const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
    let visibleCount = 0;
    const focusedDate = grid.contains(document.activeElement) ? document.activeElement.dataset.momentDay : "";
    grid.innerHTML = Array.from({ length: totalCells }, (_, index) => {
      const day = index - leading + 1;
      if (day < 1 || day > daysInMonth) return '<span class="moment-day-blank" aria-hidden="true"></span>';
      const date = calendarMonth + "-" + String(day).padStart(2, "0");
      const notes = calendarDays.get(date) || [];
      const favorite = notes.some(entry => entry.record.favorite);
      visibleCount += notes.length;
      const description = notes.length ? `${notes.length} 条记录${favorite ? "，有收藏" : ""}` : "添加记录";
      return `<button type="button" class="moment-day${notes.length ? " has-records" : ""}" data-moment-day="${date}" data-moment-count="${notes.length}"
        aria-label="${calendarMonth.slice(0, 4)}年${fmtCN(date)}，${description}" ${date === today ? 'aria-current="date"' : ""}>
        <span class="moment-day-number">${day}</span>
        ${favorite ? '<span class="moment-day-star" aria-hidden="true">★</span>' : ""}
        ${notes.length ? `<span class="moment-day-marker" aria-hidden="true">${notes.length > 99 ? "99+" : notes.length > 1 ? notes.length : "•"}</span>` : ""}
      </button>`;
    }).join("");
    if (focusedDate) [...grid.querySelectorAll("button")].find(button => button.dataset.momentDay === focusedDate)?.focus({ preventScroll: true });

    $("#momentCalendarSummary").textContent = isFiltered
      ? (visibleCount ? `本月匹配 ${visibleCount} 条` : "本月没有匹配的记录")
      : (visibleCount ? `本月 ${visibleCount} 条记录` : "本月还没有记录");
    $("#momentClearFilters").hidden = !isFiltered;

    const jump = $("#momentMonthJump");
    const otherMonths = activeMonths.filter(month => month !== calendarMonth);
    jump.replaceChildren(new Option("跳到有记录的月份", ""), ...otherMonths.map(month => new Option(monthLabel(month), month)));
    jump.hidden = !otherMonths.length;
  }

  async function render() {
    if (state.view !== "moments") return;
    if (!keys.size) { renderLocked(); return; }
    if (!$("#momentCalendarGrid")) {
      calendarMonth = todayISO().slice(0, 7);
      root().innerHTML = `
        <header class="moment-hero">
          <h2>我们的点滴</h2>
          <div class="moment-actions">
            <button class="btn" type="button" id="momentRandom" disabled>翻一条旧回忆</button>
            <button class="btn" type="button" data-moment-lock>上锁</button>
            <button class="btn primary moment-primary" type="button" data-moment-new>＋ 新记录</button>
          </div>
        </header>
        <div class="moment-tools">
          <input id="momentSearch" type="search" aria-label="搜索点滴" placeholder="搜索标题、正文、标签…">
          <div class="moment-filters" aria-label="筛选点滴">
            <button type="button" data-moment-filter="all" aria-pressed="true">全部</button>
            <button type="button" data-moment-filter="favorite" aria-pressed="false">★ 收藏</button>
            <select id="momentTagFilter" aria-label="按标签筛选"><option value="">全部标签</option></select>
          </div>
        </div>
        <p id="momentReadWarning" class="moment-error" role="status" hidden></p>
        <section class="moment-calendar" aria-labelledby="momentMonthLabel">
          <header class="moment-calendar-head">
            <h3 id="momentMonthLabel" aria-live="polite"></h3>
            <div class="moment-calendar-nav">
              <button class="btn small" id="momentToday" type="button">今天</button>
              <button class="btn small moment-month-arrow" id="momentPrevMonth" data-month-shift="-1" aria-label="上个月" type="button">‹</button>
              <button class="btn small moment-month-arrow" id="momentNextMonth" data-month-shift="1" aria-label="下个月" type="button">›</button>
            </div>
          </header>
          <div class="moment-weekdays" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
          <div id="momentCalendarGrid" class="moment-calendar-grid"></div>
          <footer class="moment-calendar-footer">
            <span id="momentCalendarSummary" role="status">正在读取记录…</span>
            <button class="btn small" id="momentClearFilters" type="button" hidden>清除筛选</button>
            <select id="momentMonthJump" aria-label="跳到有记录的月份" hidden></select>
          </footer>
        </section>`;
    }
    const request = ++renderRequest;
    let unavailable = false;
    const registers = syncClient.viewDoc.records;
    const candidates = Object.entries(settings()).filter(([name]) => name.startsWith(entryPrefix));
    const decoded = await Promise.all(candidates.map(async ([name, packet]) => {
      const key = keys.get(packet?.vault);
      try {
        if (!key) throw Error("尚未解锁");
        const record = await unseal(key, name, packet);
        if (!validRecord(record)) throw Error("记录格式错误");
        const context = registers[JSON.stringify(["settings", name])];
        const conflict = context?.values.some(version => !DashboardSyncCore.equal(version.value, packet)) || false;
        return { name, record, packet, context, conflict };
      } catch {
        unavailable = true;
        return null;
      }
    }));
    if (request !== renderRequest || state.view !== "moments" || !keys.size) return;
    entries = decoded.filter(Boolean).sort((a, b) =>
      b.record.date.localeCompare(a.record.date) || b.record.created.localeCompare(a.record.created));
    const warning = $("#momentReadWarning");
    warning.hidden = !unavailable;
    warning.textContent = unavailable ? "有部分记录暂时无法读取。可重新解锁，或先导出完整备份。" : "";
    updateTagFilter();
    renderCalendar();
  }

  function validRecord(record) {
    return record &&
      typeof record.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.date) &&
      typeof record.title === "string" && typeof record.body === "string" &&
      typeof record.created === "string" && Array.isArray(record.tags) && record.tags.every(tag => typeof tag === "string");
  }

  async function compressPhoto(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 15 * 1024 * 1024) {
      throw Error("请选择 15 MB 以内的 JPG、PNG 或 WebP 照片。");
    }
    const source = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(Error("照片读取失败"));
      reader.readAsDataURL(file);
    });
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(Error("无法打开这张照片"));
      image.src = source;
    });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    for (const side of [960, 720, 480, 320]) {
      const ratio = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const jpeg = canvas.toDataURL("image/jpeg", 0.78);
      if (validPhoto(jpeg)) return jpeg;
    }
    throw Error("这张照片无法压缩，请试试另一张。");
  }

  function bindTags(form, originalTags) {
    const tags = [...new Set(originalTags)];
    const history = knownTags();
    const input = form.elements.tags;
    const selected = form.querySelector("#momentSelectedTags");
    const suggestions = form.querySelector("#momentTagSuggestions");
    const choices = form.querySelector("#momentTagChoices");
    const error = form.querySelector("#momentTagError");
    const pending = () => input.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);

    function renderTags() {
      const query = input.value.trim().toLowerCase();
      const available = history.filter(tag => !tags.includes(tag) && tag.toLowerCase().includes(query));
      selected.innerHTML = tags.map(tag => `
        <button class="moment-tag-chip selected" type="button" data-remove-tag="${esc(tag)}" aria-label="移除标签 ${esc(tag)}">#${esc(tag)} <span aria-hidden="true">×</span></button>`).join("");
      choices.innerHTML = available.map(tag => `
        <button class="moment-tag-chip" type="button" data-add-tag="${esc(tag)}">#${esc(tag)}</button>`).join("");
      suggestions.hidden = !available.length;
    }

    function addTags(additions) {
      const combined = [...new Set([...tags, ...additions])];
      error.hidden = combined.length <= maxTags;
      if (!error.hidden) return false;
      tags.splice(0, tags.length, ...combined);
      input.value = "";
      renderTags();
      return true;
    }

    input.addEventListener("input", () => { error.hidden = true; renderTags(); });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      addTags(pending());
    });
    form.querySelector("#momentAddTag").onclick = () => addTags(pending());
    choices.onclick = event => {
      const option = event.target.closest("[data-add-tag]");
      if (!option) return;
      if (addTags([option.dataset.addTag]) && event.detail === 0) {
        (choices.querySelector("button") || input).focus();
      }
    };
    selected.onclick = event => {
      const option = event.target.closest("[data-remove-tag]");
      if (!option) return;
      tags.splice(tags.indexOf(option.dataset.removeTag), 1);
      error.hidden = true;
      renderTags();
      if (event.detail === 0) (selected.querySelector("button") || input).focus();
    };
    renderTags();
    return () => addTags(pending()) ? tags.slice() : null;
  }

  function openEditor(entry, date = todayISO()) {
    if (!keys.size) return;
    const editing = entry?.record;
    let photo = validPhoto(editing?.photo) ? editing.photo : "";
    const name = entry?.name || entryPrefix + crypto.randomUUID();
    const vault = entry?.packet.vault || keys.keys().next().value;
    const key = keys.get(vault);
    const created = editing?.created || new Date().toISOString();
    openWideModal(editing ? "编辑点滴" : "新的点滴", `
      <form id="momentEditor" data-private-moment>
        <div class="row2">
          <label class="field">日期<input name="date" type="date" required min="0001-01-01" max="9999-12-31" value="${esc(editing?.date || date)}"></label>
          <label class="field">标题（选填）<input name="title" maxlength="80" value="${esc(editing?.title || "")}" placeholder="给它起个好找的名字"></label>
        </div>
        <label class="field">想记下来<textarea name="body" required maxlength="6000" rows="5" placeholder="当时发生了什么？有什么小细节想留住？">${esc(editing?.body || "")}</textarea></label>
        <div class="field">
          <label for="momentTagInput">标签（选填）</label>
          <div class="moment-tag-input">
            <input id="momentTagInput" name="tags" maxlength="150" placeholder="输入新标签，或查找用过的标签" autocomplete="off">
            <button class="btn" id="momentAddTag" type="button">添加</button>
          </div>
          <p class="moment-error" id="momentTagError" role="status" hidden>每条最多 ${maxTags} 个标签。</p>
          <div id="momentSelectedTags" class="moment-tag-picker" aria-label="已添加的标签"></div>
          <div id="momentTagSuggestions" hidden>
            <div class="moment-tag-label">用过的标签</div>
            <div id="momentTagChoices" class="moment-tag-picker"></div>
          </div>
        </div>
        <div class="moment-photo-field">
          <label class="field">照片（选填）<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>
          <div class="moment-photo-preview" ${photo ? "" : "hidden"}><img alt="所选照片"><button type="button" class="btn small" data-remove-photo>移除照片</button></div>
        </div>
        <label class="moment-check"><input name="favorite" type="checkbox" ${editing?.favorite ? "checked" : ""}>收藏这条</label>
        <p class="moment-error" role="status" hidden></p>
        <div class="modal-actions"><button class="btn ghost" type="button" data-close>取消</button><button class="btn primary moment-primary" type="submit">保存</button></div>
      </form>`);
    const form = $("#momentEditor");
    const collectTags = bindTags(form, editing?.tags || []);
    const photoPreview = form.querySelector(".moment-photo-preview");
    const button = form.querySelector("button[type=submit]");
    const message = form.querySelector(".moment-error");
    const generation = lockGeneration;
    const isActive = () => form.isConnected && generation === lockGeneration;
    const showError = text => { message.textContent = text; message.hidden = !text; };
    function updatePhoto() {
      photoPreview.hidden = !photo;
      if (photo) photoPreview.querySelector("img").src = photo;
      else photoPreview.querySelector("img").removeAttribute("src");
    }
    updatePhoto();
    let photoRequest = 0;
    form.elements.photo.onchange = async () => {
      const file = form.elements.photo.files[0];
      if (!file) return;
      const request = ++photoRequest;
      button.disabled = true;
      showError("");
      try {
        const jpeg = await compressPhoto(file);
        if (request !== photoRequest || !isActive()) return;
        photo = jpeg;
        updatePhoto();
      } catch (error) {
        if (request === photoRequest && isActive()) showError(error.message);
      } finally {
        if (request === photoRequest && isActive()) {
          button.disabled = false;
          form.elements.photo.value = "";
        }
      }
    };
    form.querySelector("[data-remove-photo]").onclick = () => {
      photoRequest++;
      photo = "";
      form.elements.photo.value = "";
      button.disabled = false;
      showError("");
      updatePhoto();
    };
    form.onsubmit = async event => {
      event.preventDefault();
      if (button.disabled) return;
      const body = form.elements.body.value.trim();
      if (!body) { showError("写下一句话即可保存。"); return; }
      const tags = collectTags();
      if (!tags) return;
      const record = {
        // Older apps require this field to read the record. The current UI uses tags only.
        kind: editing?.kind === "detail" ? "detail" : "together",
        date: form.elements.date.value, title: form.elements.title.value.trim(), body, tags,
        favorite: form.elements.favorite.checked, photo, created
      };
      button.disabled = true;
      form.elements.photo.disabled = true;
      form.querySelector("[data-remove-photo]").disabled = true;
      showError("");
      try {
        const packet = await seal(key, name, vault, record);
        if (!isActive()) return;
        const vaultSize = Object.entries(settings()).reduce((size, [id, value]) =>
          id !== name && id.startsWith(entryPrefix) ? size + (value?.ciphertext?.length || 0) : size, packet.ciphertext.length);
        if (vaultSize > 2500000) throw Error("点滴的同步空间已满，可以移除一些照片后再试。");
        settings()[name] = packet;
        await syncClient.commit(state.db);
        if (isActive()) {
          calendarMonth = record.date.slice(0, 7);
          closeModal();
          toast("已保存点滴");
          render();
        }
      } catch (error) {
        if (isActive()) showError(error.message || "保存未完成，请重试。");
      } finally {
        button.disabled = false;
        form.elements.photo.disabled = false;
        form.querySelector("[data-remove-photo]").disabled = false;
      }
    };
  }

  function detailBody(record) {
    return `<p class="moment-meta"><time>${esc(fmtCN(record.date))}</time>${record.favorite ? '<span class="moment-star" aria-label="已收藏">★</span>' : ""}</p>
      <div class="moment-body">${esc(record.body)}</div>
      ${record.tags.length ? `<p class="moment-tags">${record.tags.map(tag => `<span>#${esc(tag)}</span>`).join("")}</p>` : ""}
      ${validPhoto(record.photo) ? `<img class="moment-detail-photo" src="${record.photo}" alt="记录照片">` : ""}`;
  }

  function openDetail(entry, sameDay) {
    if (!keys.size) return;
    const { name, record, conflict } = entry;
    const position = sameDay?.indexOf(entry) ?? 0;
    openWideModal(record.title || "点滴记录", `
      <div data-private-moment>
        ${sameDay?.length > 1 ? `<nav class="moment-day-pager" aria-label="当天记录">
          <button class="btn small" id="momentPrevNote" type="button" ${position === 0 ? "disabled" : ""}>上一条</button>
          <span>第 ${position + 1} / ${sameDay.length} 条</span>
          <button class="btn small" id="momentNextNote" type="button" ${position === sameDay.length - 1 ? "disabled" : ""}>下一条</button>
        </nav>` : ""}
        ${detailBody(record)}
        <div class="modal-actions">
          ${sameDay ? '<button class="btn small" id="momentAddOnDay" type="button">＋ 记这天</button>' : ""}
          ${conflict ? '<button class="btn primary moment-primary" type="button" id="momentCompare">核对版本</button>'
            : '<button class="btn small danger" type="button" id="momentDelete">删除</button><button class="btn primary moment-primary" type="button" id="momentEdit">编辑</button>'}
        </div>
      </div>`);
    if (sameDay) {
      $("#momentAddOnDay").onclick = () => openEditor(null, record.date);
      if (sameDay.length > 1) {
        $("#momentPrevNote").onclick = () => openDetail(sameDay[position - 1], sameDay);
        $("#momentNextNote").onclick = () => openDetail(sameDay[position + 1], sameDay);
      }
    }
    if (conflict) {
      $("#momentCompare").onclick = () => compareVersions(entry);
      return;
    }
    $("#momentEdit").onclick = () => openEditor(entry);
    $("#momentDelete").onclick = async event => {
      if (!confirm("删除这条点滴？")) return;
      const button = event.currentTarget;
      button.disabled = true;
      try {
        delete settings()[name];
        await syncClient.commit(state.db);
        if (button.isConnected) { closeModal(); render(); }
      } catch (error) { toast(error.message); button.disabled = false; }
    };
  }

  async function compareVersions({ name, context }) {
    const origin = $("#momentCompare");
    origin.disabled = true;
    const variants = await Promise.all(context.values.map(async version => {
      const packet = version.value;
      if (packet === null) return { version, summary: "<p>此版本删除了记录。</p>" };
      try {
        const value = await unseal(keys.get(packet.vault), name, packet);
        if (validRecord(value)) return { version, summary: `<h4>${esc(value.title || "点滴记录")}</h4>${detailBody(value)}` };
      } catch {}
      return { version, summary: "<p>此版本需要另一把密码才能查看。</p>", unreadable: true };
    }));
    if (!origin.isConnected || !keys.size) return;
    const unreadable = variants.some(version => version.unreadable);
    openWideModal("核对点滴版本", `<div data-private-moment>${variants.map(({ summary }, i) => `
      <section class="conflict-version">${summary}
        ${unreadable ? "" : `<button class="btn small" type="button" data-moment-use="${i}">采用此版本</button>`}
      </section>`).join("")}</div>`);
    $$("#modalBody [data-moment-use]").forEach(button => {
      button.onclick = async () => {
        if (!confirm("保留选中的版本并结束这次核对？")) return;
        button.disabled = true;
        try {
          await syncClient.resolve(JSON.stringify(["settings", name]), { context, value: variants[Number(button.dataset.momentUse)].version.value });
          if (button.isConnected) closeModal();
        } catch (error) { toast(error.message); button.disabled = false; }
      };
    });
  }

  function bind() {
    root().addEventListener("submit", event => {
      if (event.target.id !== "momentUnlock") return;
      event.preventDefault();
      unlock(event.target);
    });
    root().addEventListener("input", event => {
      if (event.target.id === "momentSearch") renderCalendar(true);
    });
    root().addEventListener("change", event => {
      if (event.target.id === "momentTagFilter") renderCalendar(true);
      if (event.target.id === "momentMonthJump" && event.target.value) {
        calendarMonth = event.target.value;
        renderCalendar();
      }
    });
    root().addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button || !keys.size) return;
      if (button.hasAttribute("data-moment-lock")) { lock(); return; }
      if (button.hasAttribute("data-moment-new")) { openEditor(); return; }
      if (button.id === "momentClearFilters") {
        filter = "all";
        $("#momentSearch").value = "";
        $("#momentTagFilter").value = "";
        renderCalendar();
        return;
      }
      if (button.hasAttribute("data-moment-filter")) {
        filter = button.dataset.momentFilter;
        renderCalendar(true);
        return;
      }
      if (button.id === "momentToday" || button.dataset.monthShift) {
        calendarMonth = button.id === "momentToday" ? todayISO().slice(0, 7) : shiftedMonth(Number(button.dataset.monthShift));
        renderCalendar();
        return;
      }
      if (button.dataset.momentDay) {
        const date = button.dataset.momentDay;
        const notes = calendarDays.get(date);
        if (notes?.length) openDetail(notes[0], notes);
        else openEditor(null, date);
        return;
      }
      if (button.id === "momentRandom") {
        const earlier = entries.filter(entry => entry.record.date < todayISO());
        const choices = earlier.length ? earlier : entries;
        const alternatives = choices.filter(entry => entry.name !== randomized);
        const pool = alternatives.length ? alternatives : choices;
        if (pool.length) {
          const chosen = pool[Math.floor(Math.random() * pool.length)];
          randomized = chosen.name;
          openDetail(chosen);
        }
        return;
      }
    });
    window.addEventListener("pagehide", lock);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 60000 && keys.size) lock();
    });
  }

  return { render, lock, bind, isPrivateName };
})();
