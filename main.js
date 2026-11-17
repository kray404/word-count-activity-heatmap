"use strict";
const {
  ItemView,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  debounce,
  editorInfoField,
  moment,
  normalizePath,
  setIcon,
} = require("obsidian");
const { EditorView } = require("@codemirror/view");

const VIEW = "word-count-activity-heatmap";
const TYPED = ["input", "delete", "undo", "redo", "move"];

const defaults = () => ({
  include: [],
  exclude: [],
  devices: {},
});
const countWords = (text) => (text.match(/\S+/g) || []).length;
const level = (n) =>
  n === 0 ? 0 : n < 250 ? 1 : n < 500 ? 2 : n < 1000 ? 3 : 4;
const dayKey = (ts) => moment(ts).format("YYYY-MM-DD");
const parseFolders = (text) =>
  text
    .split(/[\n,]/)
    .map((s) => normalizePath(s.trim()))
    .filter((s) => s && s !== "/");

class WritingHeatmap extends Plugin {
  async onload() {
    this.store = this.migrate(Object.assign(defaults(), await this.loadData()));
    const idKey = `${VIEW}-device`;
    this.id = this.app.loadLocalStorage(idKey);
    if (!this.id) {
      this.id = Math.random().toString(36).slice(2);
      this.app.saveLocalStorage(idKey, this.id);
    }
    this.store.devices[this.id] ??= {};
    this.localPath = `${this.manifest.dir}/baseline.json`;
    const local = await this.app.vault.adapter
      .read(this.localPath)
      .then(JSON.parse)
      .catch(() => null);
    this.local = Object.assign({ counts: {}, lastSeen: 0 }, local);
    this.pending = {};
    this.touched = new Set();
    this.save = debounce(
      () => {
        this.persist();
        this.refreshViews();
      },
      3000,
      true,
    );
    this.rescan = debounce(
      () => this.scan(true).then(() => this.save()),
      1000,
      true,
    );

    this.registerEditorExtension(
      EditorView.updateListener.of((u) => this.onEdit(u)),
    );
    this.registerView(VIEW, (leaf) => new HeatmapView(leaf, this));
    this.addRibbonIcon("flame", "Word count heatmap", () => this.openView());
    this.addCommand({
      id: "open-heatmap",
      name: "Open word count heatmap",
      callback: () => this.openView(),
    });
    this.addSettingTab(new HeatmapSettings(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      const { vault } = this.app;
      this.registerEvent(vault.on("create", (f) => this.onChange(f)));
      this.registerEvent(vault.on("modify", (f) => this.onChange(f)));
      this.registerEvent(vault.on("delete", (f) => this.onDelete(f)));
      this.registerEvent(
        vault.on("rename", (f, oldPath) => this.onRename(f, oldPath)),
      );
      await this.scan(!local);
      await this.persist();
    });
  }

  onunload() {
    this.save.cancel();
    this.persist();
  }

  persist() {
    for (const n of Object.values(this.pending))
      if (n) this.addDelta(this.day(), n);
    this.pending = {};
    this.local.lastSeen = Date.now();
    return Promise.all([
      this.saveData(this.store),
      this.app.vault.adapter.write(this.localPath, JSON.stringify(this.local)),
    ]);
  }

  migrate(store) {
    if (store.days) store.devices.legacy ??= store.days;
    delete store.days;
    delete store.counts;
    delete store.lastSeen;
    return store;
  }

  // Sync's merge may have replaced our history with an older copy
  async onExternalSettingsChange() {
    const disk = this.migrate(Object.assign(defaults(), await this.loadData()));
    const mine = this.store.devices[this.id];
    const stale =
      JSON.stringify(disk.devices[this.id]) !== JSON.stringify(mine);
    const folders = (s) => JSON.stringify([s.include, s.exclude]);
    const refilter = folders(disk) !== folders(this.store);
    disk.devices[this.id] = mine;
    this.store = disk;
    if (refilter) this.rescan();
    else if (stale) this.save();
    else this.refreshViews();
  }

  day(ts) {
    return (this.store.devices[this.id][dayKey(ts)] ??= {
      added: 0,
      removed: 0,
      created: [],
      deleted: [],
    });
  }

  total(key) {
    const sum = { added: 0, removed: 0 };
    for (const days of Object.values(this.store.devices)) {
      sum.added += days[key]?.added ?? 0;
      sum.removed += days[key]?.removed ?? 0;
    }
    return sum;
  }

  firstSeen(key, field) {
    const first = {};
    for (const days of Object.values(this.store.devices))
      for (const [k, day] of Object.entries(days))
        for (const p of day[field]) if (!first[p] || k < first[p]) first[p] = k;
    return Object.keys(first).filter((p) => first[p] === key);
  }

  addDelta(day, delta) {
    if (delta > 0) day.added += delta;
    else day.removed -= delta;
  }

  tracked(f) {
    if (!(f instanceof TFile) || f.extension !== "md") return false;
    const under = (dir) => f.path.startsWith(dir + "/");
    const { include, exclude } = this.store;
    return (!include.length || include.some(under)) && !exclude.some(under);
  }

  words(f) {
    return this.app.vault.cachedRead(f).then(countWords);
  }

  async scan(silent) {
    const { counts } = this.local;
    const live = new Set();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.tracked(f)) continue;
      live.add(f.path);
      if (f.path in counts && f.stat.mtime <= this.local.lastSeen) continue;
      const now = await this.words(f);
      if (!silent && this.touched.has(f.path)) continue;
      const before = counts[f.path];
      counts[f.path] = now;
      if (silent) continue;
      if (before === undefined) {
        const day = this.day(f.stat.mtime);
        day.created.push(f.path);
        day.added += now;
      } else if (now !== before)
        this.addDelta(this.day(f.stat.mtime), now - before);
    }
    for (const path of Object.keys(counts)) {
      if (live.has(path)) continue;
      if (!silent) this.day().deleted.push(path);
      delete counts[path];
    }
  }

  onEdit(update) {
    if (!update.docChanged) return;
    const file = update.state.field(editorInfoField, false)?.file;
    if (!this.tracked(file)) return;
    const span = (doc, pos) =>
      countWords(
        doc.sliceString(
          doc.lineAt(Math.min(...pos)).from,
          doc.lineAt(Math.max(...pos)).to,
        ),
      );
    let delta = 0;
    for (const tr of update.transactions) {
      if (!tr.docChanged || !TYPED.some((e) => tr.isUserEvent(e))) continue;
      const a = [];
      const b = [];
      tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        a.push(fromA, toA);
        b.push(fromB, toB);
      });
      delta += span(tr.state.doc, b) - span(tr.startState.doc, a);
    }
    if (!delta) return;
    this.pending[file.path] = (this.pending[file.path] ?? 0) + delta;
    this.save();
  }

  async onChange(f) {
    if (!this.tracked(f)) return;
    this.touched.add(f.path);
    const now = await this.words(f);
    const fresh = !(f.path in this.local.counts);
    this.local.counts[f.path] = now;
    if (fresh && Date.now() - f.stat.mtime < 60e3)
      this.day().created.push(f.path);
    this.save();
  }

  onDelete(f) {
    if (!(f.path in this.local.counts)) return;
    delete this.local.counts[f.path];
    this.day().deleted.push(f.path);
    this.save();
  }

  onRename(f, oldPath) {
    const rename = (p) =>
      p === oldPath
        ? f.path
        : p.startsWith(oldPath + "/")
          ? f.path + p.slice(oldPath.length)
          : p;
    for (const days of Object.values(this.store.devices))
      for (const day of Object.values(days))
        day.created = day.created.map(rename);
    return this.rescan();
  }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW).forEach((l) => l.view.render());
  }

  async openView() {
    const { workspace } = this.app;
    const leaf = workspace.getLeavesOfType(VIEW)[0] ?? workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW, active: true });
    workspace.revealLeaf(leaf);
  }
}

class HeatmapView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.selected = dayKey();
    this.year = moment().year();
  }

  getViewType() {
    return VIEW;
  }
  getDisplayText() {
    return "Word count heatmap";
  }
  getIcon() {
    return "flame";
  }
  async onOpen() {
    this.render();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    const today = moment();
    const first = Math.min(
      today.year(),
      ...Object.values(this.plugin.store.devices)
        .flatMap(Object.keys)
        .map((k) => +k.slice(0, 4)),
    );
    const nav = el.createDiv("wh-nav");
    const prev = nav.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Previous year" },
    });
    nav.createSpan({ cls: "wh-year", text: String(this.year) });
    const next = nav.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Next year" },
    });
    setIcon(prev, "chevron-left");
    setIcon(next, "chevron-right");
    prev.disabled = this.year <= first;
    next.disabled = this.year >= today.year();
    prev.onclick = () => {
      this.year--;
      this.render();
    };
    next.onclick = () => {
      this.year++;
      this.render();
    };

    const grid = el.createDiv("wh-grid");
    const start = moment([this.year]);
    for (let i = 0; i < start.weekday(); i++) grid.createDiv();
    for (const d = start.clone(); d.year() === this.year; d.add(1, "day")) {
      const key = d.format("YYYY-MM-DD");
      const words = this.plugin.total(key).added;
      const cell = grid.createDiv({
        cls: `wh-cell wh-l${level(words)}`,
        attr: { "aria-label": `${key}: ${words} words` },
      });
      if (d.isAfter(today, "day")) {
        cell.addClass("wh-future");
        continue;
      }
      if (key === this.selected) cell.addClass("is-selected");
      cell.onclick = () => {
        this.selected = key;
        this.render();
      };
    }
    this.renderDay(el.createDiv("wh-detail"), this.selected);
  }

  renderDay(el, key) {
    const { added, removed } = this.plugin.total(key);
    const created = this.plugin.firstSeen(key, "created");
    const deleted = this.plugin.firstSeen(key, "deleted");
    el.createEl("h4", { text: moment(key).format("dddd D MMM YYYY") });
    if (!added && !removed && !created.length && !deleted.length) {
      el.createEl("p", { text: "Nothing tracked this day." });
      return;
    }
    const line = el.createEl("p");
    line.createSpan({ cls: "wh-added", text: `+${added}` });
    line.appendText(" written · ");
    line.createSpan({ cls: "wh-removed", text: `−${removed}` });
    line.appendText(` removed · net ${added - removed}`);
    const list = (title, paths) => {
      if (!paths.length) return;
      el.createEl("h5", { text: `${title} (${paths.length})` });
      const ul = el.createEl("ul");
      for (const p of paths) {
        const li = ul.createEl("li", { text: p });
        const file = this.app.vault.getAbstractFileByPath(p);
        if (file instanceof TFile) {
          li.addClass("wh-link");
          li.onclick = () => this.app.workspace.getLeaf().openFile(file);
        }
      }
    };
    list("Files created", created);
    list("Files removed", deleted);
  }
}

class HeatmapSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl, plugin } = this;
    containerEl.empty();
    const folders = (key, name, desc) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addTextArea((t) => {
          t.inputEl.rows = 5;
          t.setPlaceholder("Journal\nProjects/Novel")
            .setValue(plugin.store[key].join("\n"))
            .onChange((v) => {
              plugin.store[key] = parseFolders(v);
              plugin.rescan();
            });
        });
    folders(
      "include",
      "Include folders",
      "One folder per line or separated by commas, as shown in the file explorer. Leave empty to track the whole vault.",
    );
    folders(
      "exclude",
      "Exclude folders",
      "One folder per line or separated by commas. Beats include, so you can skip a subfolder of an included folder.",
    );
  }
}

module.exports = WritingHeatmap;
