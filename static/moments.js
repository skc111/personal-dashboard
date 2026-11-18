/* Opaque settings records keep encrypted notes compatible with older sync clients. */
const Moments = (() => {
  const vaultPrefix = "moments-vault-";
  const entryPrefix = "moments-note-";
  const kinds = { together: "一起经历", detail: "想记住的细节" };
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

  function preview(record) {
    return record.body.replace(/\s+/g, " ").slice(0, record.title ? 128 : 170);
  }

  function validPhoto(photo) {
    return typeof photo === "string" && photo.length <= 165000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(photo);
  }

  function renderList() {
    const list = $("#momentList");
    if (!list) return;
    const query = $("#momentSearch").value.trim().toLowerCase();
    const results = entries.filter(({ record }) => {
      const match = filter === "all" || (filter === "favorite" ? record.favorite : record.kind === filter);
      return match && (!query || [record.title, record.body, record.date, ...record.tags].some(text => text.toLowerCase().includes(query)));
    });
    $("#momentRandom").disabled = !entries.length;
    root().querySelectorAll("[data-moment-filter]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.momentFilter === filter));
    });
    if (!results.length) {
      list.innerHTML = `<div class="moment-empty">
        <strong>${entries.length ? "这里还没有符合条件的记录" : "从一个想留住的瞬间开始"}</strong>
        ${entries.length ? '<button class="btn small" type="button" data-moment-filter="all" data-clear-search>查看全部</button>' : '<p>一起经历的小事，或想记在心里的细节。</p><button class="btn primary moment-primary" type="button" data-moment-new>写下第一条</button>'}
      </div>`;
      return;
    }
    const months = new Map();
    for (const entry of results) {
      const month = entry.record.date.slice(0, 7);
      if (!months.has(month)) months.set(month, []);
      months.get(month).push(entry);
    }
    list.innerHTML = [...months].map(([month, group]) => `
      <section class="moment-month">
        <h3>${esc(month.slice(0, 4))} 年 ${Number(month.slice(5))} 月</h3>
        <div class="moment-timeline">${group.map(({ name, record, conflict }) => `
          <button type="button" class="moment-card" data-moment-open="${esc(name)}">
            <span class="moment-card-text">
              <span class="moment-meta"><time datetime="${esc(record.date)}">${Number(record.date.slice(8))} 日</time><span class="moment-category ${record.kind}">${kinds[record.kind]}</span>${record.favorite ? '<span class="moment-star" aria-label="已收藏">★</span>' : ""}${conflict ? '<span class="moment-versions">多个版本</span>' : ""}</span>
              ${record.title ? `<strong>${esc(record.title)}</strong>` : ""}
              <span class="moment-preview">${esc(preview(record))}</span>
              ${record.tags.length ? `<span class="moment-tags">${record.tags.map(tag => `<span>#${esc(tag)}</span>`).join("")}</span>` : ""}
            </span>
            ${validPhoto(record.photo) ? `<img src="${record.photo}" alt="" loading="lazy">` : ""}
          </button>`).join("")}</div>
      </section>`).join("");
  }

  async function render() {
    if (state.view !== "moments") return;
    if (!keys.size) { renderLocked(); return; }
    if (!$("#momentList")) {
      root().innerHTML = `
        <header class="moment-hero">
          <div><h2>我们的点滴</h2><p>一起经历的，想记住的。</p></div>
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
            <button type="button" data-moment-filter="together" aria-pressed="false">一起经历</button>
            <button type="button" data-moment-filter="detail" aria-pressed="false">想记住的细节</button>
            <button type="button" data-moment-filter="favorite" aria-pressed="false">★ 收藏</button>
          </div>
        </div>
        <p id="momentReadWarning" class="moment-error" role="status" hidden></p>
        <div id="momentList" aria-live="polite"><p class="muted">正在读取记录…</p></div>`;
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
    renderList();
  }

  function validRecord(record) {
    return record && Object.hasOwn(kinds, record.kind) &&
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

  function openEditor(entry) {
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
          <label class="field">类别<select name="kind">
            <option value="together">一起经历</option><option value="detail">想记住的细节</option>
          </select></label>
          <label class="field">日期<input name="date" type="date" required value="${esc(editing?.date || todayISO())}"></label>
        </div>
        <label class="field">标题（选填）<input name="title" maxlength="80" value="${esc(editing?.title || "")}" placeholder="给它起个好找的名字"></label>
        <label class="field">想记下来<textarea name="body" required maxlength="6000" rows="5" placeholder="当时发生了什么？有什么小细节想留住？">${esc(editing?.body || "")}</textarea></label>
        <label class="field">标签（选填，用逗号隔开）<input name="tags" maxlength="150" value="${esc(editing?.tags.join("，") || "")}" placeholder="例如 美食，第一次"></label>
        <div class="moment-photo-field">
          <label class="field">照片（选填）<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>
          <div class="moment-photo-preview" ${photo ? "" : "hidden"}><img alt="所选照片"><button type="button" class="btn small" data-remove-photo>移除照片</button></div>
        </div>
        <label class="moment-check"><input name="favorite" type="checkbox" ${editing?.favorite ? "checked" : ""}>收藏这条</label>
        <p class="moment-error" role="status" hidden></p>
        <div class="modal-actions"><button class="btn ghost" type="button" data-close>取消</button><button class="btn primary moment-primary" type="submit">保存</button></div>
      </form>`);
    const form = $("#momentEditor");
    form.elements.kind.value = editing?.kind || (filter === "detail" ? "detail" : "together");
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
      const record = {
        kind: form.elements.kind.value, date: form.elements.date.value,
        title: form.elements.title.value.trim(), body,
        tags: [...new Set(form.elements.tags.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))].slice(0, 8),
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
        if (isActive()) { closeModal(); toast("已保存点滴"); render(); }
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
    return `<p class="moment-meta"><time>${esc(fmtCN(record.date))}</time><span class="moment-category ${record.kind}">${kinds[record.kind]}</span>${record.favorite ? '<span class="moment-star" aria-label="已收藏">★</span>' : ""}</p>
      <div class="moment-body">${esc(record.body)}</div>
      ${record.tags.length ? `<p class="moment-tags">${record.tags.map(tag => `<span>#${esc(tag)}</span>`).join("")}</p>` : ""}
      ${validPhoto(record.photo) ? `<img class="moment-detail-photo" src="${record.photo}" alt="记录照片">` : ""}`;
  }

  function openDetail(entry) {
    if (!keys.size) return;
    const { name, record, conflict } = entry;
    openWideModal(record.title || kinds[record.kind], `
      <div data-private-moment>
        ${detailBody(record)}
        <div class="modal-actions">
          ${conflict ? '<button class="btn primary moment-primary" type="button" id="momentCompare">核对版本</button>'
            : '<button class="btn small danger" type="button" id="momentDelete">删除</button><button class="btn primary moment-primary" type="button" id="momentEdit">编辑</button>'}
        </div>
      </div>`);
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
        if (validRecord(value)) return { version, summary: `<h4>${esc(value.title || kinds[value.kind])}</h4>${detailBody(value)}` };
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
      if (event.target.id === "momentSearch") renderList();
    });
    root().addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button || !keys.size) return;
      if (button.hasAttribute("data-moment-lock")) { lock(); return; }
      if (button.hasAttribute("data-moment-new")) { openEditor(); return; }
      if (button.hasAttribute("data-moment-filter")) {
        filter = button.dataset.momentFilter;
        if (button.hasAttribute("data-clear-search")) $("#momentSearch").value = "";
        renderList();
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
      const entry = entries.find(item => item.name === button.dataset.momentOpen);
      if (entry) openDetail(entry);
    });
    window.addEventListener("pagehide", lock);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 60000 && keys.size) lock();
    });
  }

  return { render, lock, bind, isPrivateName };
})();
