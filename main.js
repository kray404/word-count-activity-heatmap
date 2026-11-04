'use strict';
const { ItemView, Plugin, PluginSettingTab, Setting, TFile, debounce, moment, normalizePath, setIcon } = require('obsidian');

const VIEW = 'word-count-heatmap';

const defaults = () => ({ include: [], exclude: [], days: {}, counts: {}, lastSeen: 0 });
const countWords = text => (text.match(/\S+/g) || []).length;
const level = n => n === 0 ? 0 : n < 250 ? 1 : n < 500 ? 2 : n < 1000 ? 3 : 4;
const dayKey = ts => moment(ts).format('YYYY-MM-DD');
const parseFolders = text => text.split('\n').map(s => normalizePath(s.trim())).filter(s => s && s !== '/');

class WritingHeatmap extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.store = Object.assign(defaults(), saved);
    this.save = debounce(() => { this.persist(); this.refreshViews(); }, 3000, true);
    this.rescan = debounce(() => this.scan(true).then(() => this.save()), 1000, true);

    this.registerView(VIEW, leaf => new HeatmapView(leaf, this));
    this.addRibbonIcon('flame', 'Word count heatmap', () => this.openView());
    this.addCommand({ id: 'open-heatmap', name: 'Open word count heatmap', callback: () => this.openView() });
    this.addSettingTab(new HeatmapSettings(this.app, this));

    // 'create' fires for every file during vault load
    this.app.workspace.onLayoutReady(async () => {
      // first run: baseline only
      await this.scan(!saved);
      await this.persist();
      const { vault } = this.app;
      this.registerEvent(vault.on('create', f => this.onCreate(f)));
      this.registerEvent(vault.on('modify', f => this.onModify(f)));
      this.registerEvent(vault.on('delete', f => this.onDelete(f)));
      this.registerEvent(vault.on('rename', (f, oldPath) => this.onRename(f, oldPath)));
    });
  }

  onunload() {
    this.save.cancel();
    this.persist();
  }

  persist() {
    this.store.lastSeen = Date.now();
    return this.saveData(this.store);
  }

  day(ts) {
    const key = dayKey(ts);
    return this.store.days[key] ??= { added: 0, removed: 0, created: [], deleted: [] };
  }

  addDelta(day, delta) {
    if (delta > 0) day.added += delta;
    else day.removed -= delta;
  }

  tracked(f) {
    if (!(f instanceof TFile) || f.extension !== 'md') return false;
    const under = dir => f.path.startsWith(dir + '/');
    const { include, exclude } = this.store;
    return (!include.length || include.some(under)) && !exclude.some(under);
  }

  words(f) {
    return this.app.vault.cachedRead(f).then(countWords);
  }

  // silent: update baselines without logging changes
  async scan(silent) {
    const { counts } = this.store;
    const live = new Set();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.tracked(f)) continue;
      live.add(f.path);
      if (f.path in counts && f.stat.mtime <= this.store.lastSeen) continue;
      const now = await this.words(f);
      const before = counts[f.path];
      counts[f.path] = now;
      if (silent) continue;
      if (before === undefined) {
        const day = this.day(f.stat.ctime);
        day.created.push(f.path);
        day.added += now;
      } else if (now !== before) this.addDelta(this.day(f.stat.mtime), now - before);
    }
    for (const path of Object.keys(counts)) {
      if (live.has(path)) continue;
      if (!silent) this.day().deleted.push(path);
      delete counts[path];
    }
  }

  async onCreate(f) {
    if (!this.tracked(f)) return;
    const now = await this.words(f);
    this.store.counts[f.path] = now;
    const day = this.day();
    day.created.push(f.path);
    day.added += now;
    this.save();
  }

  async onModify(f) {
    if (!this.tracked(f)) return;
    const now = await this.words(f);
    // read after the await so overlapping saves don't double-count
    const before = this.store.counts[f.path];
    this.store.counts[f.path] = now;
    if (before !== undefined) this.addDelta(this.day(), now - before);
    this.save();
  }

  onDelete(f) {
    if (!(f.path in this.store.counts)) return;
    delete this.store.counts[f.path];
    this.day().deleted.push(f.path);
    this.save();
  }

  onRename(f, oldPath) {
    const rename = p => p === oldPath ? f.path : p.startsWith(oldPath + '/') ? f.path + p.slice(oldPath.length) : p;
    for (const day of Object.values(this.store.days)) day.created = day.created.map(rename);
    return this.rescan();
  }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW).forEach(l => l.view.render());
  }

  async openView() {
    const { workspace } = this.app;
    const leaf = workspace.getLeavesOfType(VIEW)[0] ?? workspace.getLeaf('tab');
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

  getViewType() { return VIEW; }
  getDisplayText() { return 'Word count heatmap'; }
  getIcon() { return 'flame'; }
  async onOpen() { this.render(); }

  render() {
    const el = this.contentEl;
    el.empty();
    const today = moment();
    const first = Math.min(today.year(), ...Object.keys(this.plugin.store.days).map(k => +k.slice(0, 4)));
    const nav = el.createDiv('wh-nav');
    const prev = nav.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Previous year' } });
    nav.createSpan({ cls: 'wh-year', text: String(this.year) });
    const next = nav.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Next year' } });
    setIcon(prev, 'chevron-left');
    setIcon(next, 'chevron-right');
    prev.disabled = this.year <= first;
    next.disabled = this.year >= today.year();
    prev.onclick = () => { this.year--; this.render(); };
    next.onclick = () => { this.year++; this.render(); };

    const grid = el.createDiv('wh-grid');
    const start = moment([this.year]);
    // offset Jan 1 to its weekday row
    for (let i = 0; i < start.weekday(); i++) grid.createDiv();
    for (const d = start.clone(); d.year() === this.year; d.add(1, 'day')) {
      const key = d.format('YYYY-MM-DD');
      const words = this.plugin.store.days[key]?.added ?? 0;
      const cell = grid.createDiv({ cls: `wh-cell wh-l${level(words)}`, attr: { 'aria-label': `${key}: ${words} words` } });
      if (d.isAfter(today, 'day')) { cell.addClass('wh-future'); continue; }
      if (key === this.selected) cell.addClass('is-selected');
      cell.onclick = () => { this.selected = key; this.render(); };
    }
    this.renderDay(el.createDiv('wh-detail'), this.selected);
  }

  renderDay(el, key) {
    const day = this.plugin.store.days[key];
    el.createEl('h4', { text: moment(key).format('dddd D MMM YYYY') });
    if (!day) { el.createEl('p', { text: 'Nothing tracked this day.' }); return; }
    const line = el.createEl('p');
    line.createSpan({ cls: 'wh-added', text: `+${day.added}` });
    line.appendText(' written · ');
    line.createSpan({ cls: 'wh-removed', text: `−${day.removed}` });
    line.appendText(` removed · net ${day.added - day.removed}`);
    const list = (title, paths) => {
      if (!paths.length) return;
      el.createEl('h5', { text: `${title} (${paths.length})` });
      const ul = el.createEl('ul');
      for (const p of paths) {
        const li = ul.createEl('li', { text: p });
        const file = this.app.vault.getAbstractFileByPath(p);
        if (file instanceof TFile) {
          li.addClass('wh-link');
          li.onclick = () => this.app.workspace.getLeaf().openFile(file);
        }
      }
    };
    list('Files created', day.created);
    list('Files removed', day.deleted);
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
    const folders = (key, name, desc) => new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addTextArea(t => {
        t.inputEl.rows = 5;
        t.setPlaceholder('Journal\nProjects/Novel')
          .setValue(plugin.store[key].join('\n'))
          .onChange(v => { plugin.store[key] = parseFolders(v); plugin.rescan(); });
      });
    folders('include', 'Include folders', 'One folder per line, as shown in the file explorer. Leave empty to track the whole vault.');
    folders('exclude', 'Exclude folders', 'One folder per line. Beats include, so you can skip a subfolder of an included folder.');
  }
}

module.exports = WritingHeatmap;
