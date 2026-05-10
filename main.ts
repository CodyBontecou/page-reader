import {
  App,
  Component,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import type { ViewStateResult } from "obsidian";

const VIEW_TYPE_PAGE_READER = "page-reader-view";
const MIN_PAGE_WIDTH = 160;
const SWIPE_THRESHOLD_PX = 56;
const WHEEL_TURN_COOLDOWN_MS = 450;

type ReaderTheme = "obsidian" | "paper" | "sepia" | "night";

interface PageReaderSettings {
  fontSize: number;
  lineHeight: number;
  columnGap: number;
  pagePadding: number;
  theme: ReaderTheme;
  justifyText: boolean;
  hideFrontmatter: boolean;
  openInNewTab: boolean;
  turnPageWithVerticalScroll: boolean;
}

interface ReadingProgress {
  pageIndex: number;
  pageCount: number;
  percent: number;
  updatedAt: number;
  fileMtime: number;
  fileSize: number;
}

interface PageReaderPluginData {
  settings: PageReaderSettings;
  progress: Record<string, ReadingProgress>;
  lastFilePath: string | null;
}

interface PageReaderViewState extends Record<string, unknown> {
  filePath?: string;
  pageIndex?: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startedAt: number;
  dragging: boolean;
}

const DEFAULT_SETTINGS: PageReaderSettings = {
  fontSize: 18,
  lineHeight: 1.65,
  columnGap: 56,
  pagePadding: 34,
  theme: "paper",
  justifyText: false,
  hideFrontmatter: true,
  openInNewTab: true,
  turnPageWithVerticalScroll: false,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getPercent(pageIndex: number, pageCount: number): number {
  if (pageCount <= 1) return 0;
  return clamp(pageIndex / (pageCount - 1), 0, 1);
}

function stripYamlFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown;

  const match = markdown.match(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/);
  return match ? markdown.slice(match[0].length).trimStart() : markdown;
}

function fileIdentityMatches(progress: ReadingProgress, file: TFile, pageCount: number): boolean {
  return (
    progress.fileMtime === file.stat.mtime &&
    progress.fileSize === file.stat.size &&
    progress.pageCount === pageCount
  );
}

export default class PageReaderPlugin extends Plugin {
  settings: PageReaderSettings = { ...DEFAULT_SETTINGS };
  progress: Record<string, ReadingProgress> = {};
  lastFilePath: string | null = null;

  private saveTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.registerView(
      VIEW_TYPE_PAGE_READER,
      (leaf: WorkspaceLeaf) => new PageReaderView(leaf, this)
    );

    this.addRibbonIcon("book-open", "Open active note in Page Reader", () => {
      void this.openActiveFileInReader();
    });

    this.addCommand({
      id: "open-active-note-in-page-reader",
      name: "Open active note in Page Reader",
      checkCallback: (checking: boolean) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.openReaderForFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "resume-last-page-reader-note",
      name: "Resume last Page Reader note",
      callback: () => {
        void this.resumeLastReaderNote();
      },
    });

    this.addCommand({
      id: "reset-active-page-reader-progress",
      name: "Reset saved Page Reader progress for active note",
      checkCallback: (checking: boolean) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) {
          this.resetProgress(file);
          new Notice(`Page Reader progress reset for ${file.basename}`);
        }
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;

        menu.addItem((item) => {
          item
            .setTitle("Open in Page Reader")
            .setIcon("book-open")
            .onClick(() => {
              void this.openReaderForFile(file);
            });
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        this.handleRename(file, oldPath);
      })
    );

    this.addSettingTab(new PageReaderSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.savePluginData();
    }

    this.app.workspace.detachLeavesOfType(VIEW_TYPE_PAGE_READER);
  }

  async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as Partial<PageReaderPluginData> | null;

    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
    this.progress = data?.progress ?? {};
    this.lastFilePath = data?.lastFilePath ?? null;
  }

  async savePluginData(): Promise<void> {
    const data: PageReaderPluginData = {
      settings: this.settings,
      progress: this.progress,
      lastFilePath: this.lastFilePath,
    };

    await this.saveData(data);
  }

  queueSaveData(delayMs = 300): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }

    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.savePluginData();
    }, delayMs);
  }

  getActiveMarkdownFile(): TFile | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile instanceof TFile && activeFile.extension === "md") {
      return activeFile;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const viewFile = activeView?.file;
    if (viewFile instanceof TFile && viewFile.extension === "md") {
      return viewFile;
    }

    return null;
  }

  getFileByPath(path: string | null | undefined): TFile | null {
    if (!path) return null;

    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return file instanceof TFile ? file : null;
  }

  async openActiveFileInReader(): Promise<void> {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("Open a Markdown note first, then run Page Reader.");
      return;
    }

    await this.openReaderForFile(file);
  }

  async openReaderForFile(file: TFile): Promise<void> {
    this.lastFilePath = file.path;
    this.queueSaveData();

    const workspace = this.app.workspace as typeof this.app.workspace & {
      getLeaf(type?: string | boolean): WorkspaceLeaf;
    };
    const leaf = this.settings.openInNewTab
      ? workspace.getLeaf("tab")
      : workspace.getLeaf(false);

    await leaf.setViewState({
      type: VIEW_TYPE_PAGE_READER,
      state: { filePath: file.path },
      active: true,
    });

    this.app.workspace.revealLeaf(leaf);
  }

  async resumeLastReaderNote(): Promise<void> {
    const lastPath = this.lastFilePath ?? this.getMostRecentProgressPath();
    const file = this.getFileByPath(lastPath);

    if (!file) {
      new Notice("No saved Page Reader note yet.");
      return;
    }

    await this.openReaderForFile(file);
  }

  getMostRecentProgressPath(): string | null {
    const entries = Object.entries(this.progress);
    if (entries.length === 0) return null;

    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    return entries[0][0];
  }

  getProgress(file: TFile): ReadingProgress | undefined {
    return this.progress[file.path];
  }

  setProgress(file: TFile, pageIndex: number, pageCount: number): void {
    this.progress[file.path] = {
      pageIndex: clamp(pageIndex, 0, Math.max(0, pageCount - 1)),
      pageCount,
      percent: getPercent(pageIndex, pageCount),
      updatedAt: Date.now(),
      fileMtime: file.stat.mtime,
      fileSize: file.stat.size,
    };

    this.lastFilePath = file.path;
    this.queueSaveData();
  }

  resetProgress(file: TFile): void {
    delete this.progress[file.path];
    this.queueSaveData();
  }

  clearAllProgress(): void {
    this.progress = {};
    this.queueSaveData();
  }

  refreshOpenReaders(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_PAGE_READER).forEach((leaf) => {
      if (leaf.view instanceof PageReaderView) {
        leaf.view.applySettingsAndRepaginate();
      }
    });
  }

  rerenderOpenReaders(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_PAGE_READER).forEach((leaf) => {
      if (leaf.view instanceof PageReaderView) {
        leaf.view.rerenderPreservingPosition();
      }
    });
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile)) return;

    const progress = this.progress[oldPath];
    if (progress) {
      delete this.progress[oldPath];
      this.progress[file.path] = progress;
    }

    if (this.lastFilePath === oldPath) {
      this.lastFilePath = file.path;
    }

    if (progress || this.lastFilePath === file.path) {
      this.queueSaveData();
    }
  }
}

class PageReaderView extends ItemView {
  plugin: PageReaderPlugin;

  private file: TFile | null = null;
  private filePath: string | null = null;
  private pageIndex = 0;
  private pageCount = 1;
  private pageWidth = MIN_PAGE_WIDTH;
  private pageHeight = 1;
  private columnGap = DEFAULT_SETTINGS.columnGap;

  private rootEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private subtitleEl: HTMLElement | null = null;
  private stageEl: HTMLElement | null = null;
  private pagesEl: HTMLElement | null = null;
  private articleEl: HTMLElement | null = null;
  private pageIndicatorEl: HTMLElement | null = null;
  private percentEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private previousButtonEl: HTMLButtonElement | null = null;
  private nextButtonEl: HTMLButtonElement | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private renderComponent: Component | null = null;
  private renderToken = 0;
  private paginateTimer: number | null = null;
  private progressTimer: number | null = null;
  private reloadTimer: number | null = null;
  private lastWheelTurnAt = 0;
  private dragState: DragState | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PageReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
    this.icon = "book-open";
  }

  getViewType(): string {
    return VIEW_TYPE_PAGE_READER;
  }

  getDisplayText(): string {
    return this.file ? `Read: ${this.file.basename}` : "Page Reader";
  }

  getState(): PageReaderViewState {
    return {
      filePath: this.filePath ?? undefined,
      pageIndex: this.pageIndex,
    };
  }

  async setState(state: PageReaderViewState, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);

    if (typeof state?.filePath === "string") {
      this.filePath = state.filePath;
      if (typeof state.pageIndex === "number") {
        this.pageIndex = state.pageIndex;
      }

      if (this.rootEl) {
        await this.loadFileByPath(state.filePath, state.pageIndex);
      }
    }
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();

    this.addAction("refresh-cw", "Refresh pages", () => {
      void this.renderCurrentFile({ requestedPage: this.pageIndex });
    });
    this.addAction("file-text", "Open source note", () => {
      void this.openSourceNote();
    });
    this.addAction("rotate-ccw", "Reset reading position", () => {
      this.resetCurrentProgress();
    });

    this.buildShell();
    this.registerEvents();

    const viewState = this.leaf.getViewState().state as PageReaderViewState | undefined;
    const filePath = viewState?.filePath ?? this.filePath ?? this.plugin.lastFilePath;
    const requestedPage = typeof viewState?.pageIndex === "number" ? viewState.pageIndex : undefined;

    if (filePath) {
      await this.loadFileByPath(filePath, requestedPage);
    } else {
      this.renderEmptyState();
    }
  }

  async onClose(): Promise<void> {
    this.persistProgressNow();
    this.unloadRenderComponent();

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.clearTimers();
  }

  applySettingsAndRepaginate(): void {
    this.applyReaderSettings();
    this.queuePaginate(true);
  }

  rerenderPreservingPosition(): void {
    const percent = getPercent(this.pageIndex, this.pageCount);
    void this.renderCurrentFile({ requestedPercent: percent });
  }

  private buildShell(): void {
    const root = this.contentEl.createDiv({ cls: "page-reader-root" });
    this.rootEl = root;

    const toolbar = root.createDiv({ cls: "page-reader-toolbar" });
    const titleWrap = toolbar.createDiv({ cls: "page-reader-title-wrap" });
    this.titleEl = titleWrap.createDiv({ cls: "page-reader-title", text: "Page Reader" });
    this.subtitleEl = titleWrap.createDiv({ cls: "page-reader-subtitle", text: "Choose a note to start reading" });

    const toolbarControls = toolbar.createDiv({ cls: "page-reader-toolbar-controls" });
    const sourceButton = toolbarControls.createEl("button", {
      cls: "page-reader-plain-button",
      text: "Source",
      attr: { type: "button", "aria-label": "Open source note" },
    });
    sourceButton.addEventListener("click", () => {
      void this.openSourceNote();
    });

    const resetButton = toolbarControls.createEl("button", {
      cls: "page-reader-plain-button",
      text: "Reset",
      attr: { type: "button", "aria-label": "Reset reading position" },
    });
    resetButton.addEventListener("click", () => {
      this.resetCurrentProgress();
    });

    const stage = root.createDiv({ cls: "page-reader-stage" });
    stage.tabIndex = 0;
    stage.setAttribute("role", "region");
    stage.setAttribute("aria-label", "Paged article reader");
    this.stageEl = stage;

    const pages = stage.createDiv({ cls: "page-reader-pages" });
    this.pagesEl = pages;

    const article = pages.createDiv({ cls: "page-reader-article markdown-preview-view markdown-rendered" });
    this.articleEl = article;

    const previousHit = stage.createEl("button", {
      cls: "page-reader-edge-button page-reader-edge-button-left",
      text: "‹",
      attr: { type: "button", "aria-label": "Previous page" },
    });
    previousHit.addEventListener("click", () => this.previousPage());

    const nextHit = stage.createEl("button", {
      cls: "page-reader-edge-button page-reader-edge-button-right",
      text: "›",
      attr: { type: "button", "aria-label": "Next page" },
    });
    nextHit.addEventListener("click", () => this.nextPage());

    const footer = root.createDiv({ cls: "page-reader-footer" });
    this.previousButtonEl = footer.createEl("button", {
      cls: "page-reader-nav-button",
      text: "← Previous",
      attr: { type: "button" },
    });
    this.previousButtonEl.addEventListener("click", () => this.previousPage());

    const progressWrap = footer.createDiv({ cls: "page-reader-progress-wrap" });
    const progressMeta = progressWrap.createDiv({ cls: "page-reader-progress-meta" });
    this.pageIndicatorEl = progressMeta.createSpan({ cls: "page-reader-page-indicator", text: "Page 1 of 1" });
    this.percentEl = progressMeta.createSpan({ cls: "page-reader-percent", text: "0%" });

    const progressTrack = progressWrap.createDiv({ cls: "page-reader-progress-track" });
    this.progressFillEl = progressTrack.createDiv({ cls: "page-reader-progress-fill" });

    this.nextButtonEl = footer.createEl("button", {
      cls: "page-reader-nav-button page-reader-nav-button-primary",
      text: "Next →",
      attr: { type: "button" },
    });
    this.nextButtonEl.addEventListener("click", () => this.nextPage());

    this.applyReaderSettings();
  }

  private registerEvents(): void {
    if (!this.stageEl) return;

    this.registerDomEvent(this.stageEl, "keydown", (event: KeyboardEvent) => this.handleKeydown(event));
    this.registerDomEvent(this.stageEl, "click", () => this.stageEl?.focus());
    this.registerDomEvent(this.stageEl, "wheel", (event: WheelEvent) => this.handleWheel(event), { passive: false });
    this.registerDomEvent(this.stageEl, "pointerdown", (event: PointerEvent) => this.handlePointerDown(event));
    this.registerDomEvent(this.stageEl, "pointermove", (event: PointerEvent) => this.handlePointerMove(event));
    this.registerDomEvent(this.stageEl, "pointerup", (event: PointerEvent) => this.handlePointerUp(event));
    this.registerDomEvent(this.stageEl, "pointercancel", (event: PointerEvent) => this.handlePointerCancel(event));

    this.resizeObserver = new ResizeObserver(() => this.queuePaginate(true));
    this.resizeObserver.observe(this.stageEl);

    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (file instanceof TFile && file.path === this.filePath) {
          this.queueReload();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (file.path === this.filePath) {
          this.file = null;
          this.filePath = null;
          this.renderMissingState("This note was deleted.");
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (oldPath === this.filePath && file instanceof TFile) {
          this.file = file;
          this.filePath = file.path;
          this.updateHeader();
          this.queueReload();
        }
      })
    );
  }

  private async loadFileByPath(filePath: string, requestedPage?: number): Promise<void> {
    const file = this.plugin.getFileByPath(filePath);
    if (!file || file.extension !== "md") {
      this.file = null;
      this.filePath = filePath;
      this.renderMissingState("Page Reader could not find that Markdown note.");
      return;
    }

    this.file = file;
    this.filePath = file.path;
    this.plugin.lastFilePath = file.path;
    this.plugin.queueSaveData();

    await this.renderCurrentFile({ requestedPage });
  }

  private async renderCurrentFile(options: { requestedPage?: number; requestedPercent?: number } = {}): Promise<void> {
    if (!this.file || !this.articleEl) {
      this.renderEmptyState();
      return;
    }

    const token = ++this.renderToken;
    const file = this.file;
    const priorPercent = getPercent(this.pageIndex, this.pageCount);

    this.applyReaderSettings();
    this.unloadRenderComponent();
    this.updateHeader("Loading…");
    this.articleEl.empty();
    this.articleEl.addClass("is-loading");
    this.articleEl.createDiv({ cls: "page-reader-loading", text: "Preparing pages…" });

    try {
      const rawMarkdown = await this.app.vault.read(file);
      if (token !== this.renderToken) return;

      const markdown = this.plugin.settings.hideFrontmatter
        ? stripYamlFrontmatter(rawMarkdown)
        : rawMarkdown;

      this.articleEl.empty();
      this.articleEl.removeClass("is-loading");
      this.recalculatePages();

      const renderComponent = new Component();
      const renderContainer = this.articleEl.createDiv({ cls: "page-reader-render-host" });
      this.addChild(renderComponent);
      this.renderComponent = renderComponent;
      await MarkdownRenderer.render(this.app, markdown, renderContainer, file.path, renderComponent);
      if (token !== this.renderToken) {
        if (this.renderComponent === renderComponent) {
          this.unloadRenderComponent();
        } else {
          renderComponent.unload();
        }
        return;
      }

      while (renderContainer.firstChild) {
        this.articleEl.insertBefore(renderContainer.firstChild, renderContainer);
      }
      renderContainer.remove();

      this.prepareRenderedContent();
      await this.nextAnimationFrame();
      if (token !== this.renderToken) return;

      this.recalculatePages();

      const requestedPage = options.requestedPage;
      const requestedPercent = options.requestedPercent ?? priorPercent;
      const restoredPage = this.getInitialPage(file, requestedPage, requestedPercent);
      this.goToPage(restoredPage, { animate: false, save: false });
      this.updateHeader();
      this.persistProgressSoon();
    } catch (error) {
      console.error("Page Reader failed to render", error);
      this.renderMissingState("Page Reader could not render this note.");
      new Notice("Page Reader could not render this note. Check the developer console for details.");
    }
  }

  private prepareRenderedContent(): void {
    if (!this.articleEl) return;

    this.articleEl.querySelectorAll("img").forEach((image) => {
      image.setAttribute("draggable", "false");
      image.addEventListener("load", () => this.queuePaginate(true), { once: true });
    });

    this.articleEl.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    });
  }

  private getInitialPage(file: TFile, requestedPage: number | undefined, requestedPercent: number): number {
    if (typeof requestedPage === "number") {
      return clamp(Math.round(requestedPage), 0, Math.max(0, this.pageCount - 1));
    }

    const progress = this.plugin.getProgress(file);
    if (!progress) {
      return clamp(Math.round(requestedPercent * (this.pageCount - 1)), 0, Math.max(0, this.pageCount - 1));
    }

    if (fileIdentityMatches(progress, file, this.pageCount)) {
      return clamp(progress.pageIndex, 0, Math.max(0, this.pageCount - 1));
    }

    return clamp(Math.round(progress.percent * (this.pageCount - 1)), 0, Math.max(0, this.pageCount - 1));
  }

  private recalculatePages(): void {
    if (!this.pagesEl || !this.articleEl) return;

    const padding = this.plugin.settings.pagePadding;
    const width = Math.max(MIN_PAGE_WIDTH, Math.floor(this.pagesEl.clientWidth - padding * 2));
    const height = Math.max(1, Math.floor(this.pagesEl.clientHeight - padding * 2));
    const gap = this.plugin.settings.columnGap;

    this.pageWidth = width;
    this.pageHeight = height;
    this.columnGap = gap;

    this.articleEl.style.width = `${width}px`;
    this.articleEl.style.height = `${height}px`;
    this.articleEl.style.columnWidth = `${width}px`;
    this.articleEl.style.columnGap = `${gap}px`;

    const totalWidth = Math.max(width, this.articleEl.scrollWidth);
    this.pageCount = Math.max(1, Math.round((totalWidth + gap) / (width + gap)));
    this.pageIndex = clamp(this.pageIndex, 0, this.pageCount - 1);

    this.updateTransform(false);
    this.updateProgressUi();
  }

  private queuePaginate(preservePosition: boolean): void {
    if (this.paginateTimer !== null) {
      window.clearTimeout(this.paginateTimer);
    }

    const percent = getPercent(this.pageIndex, this.pageCount);
    this.paginateTimer = window.setTimeout(() => {
      this.paginateTimer = null;
      this.recalculatePages();
      if (preservePosition) {
        const restoredPage = Math.round(percent * (this.pageCount - 1));
        this.goToPage(restoredPage, { animate: false, save: true });
      }
    }, 80);
  }

  private goToPage(pageIndex: number, options: { animate: boolean; save: boolean }): void {
    const nextPage = clamp(Math.round(pageIndex), 0, Math.max(0, this.pageCount - 1));
    const didChange = nextPage !== this.pageIndex;
    this.pageIndex = nextPage;

    this.updateTransform(options.animate);
    this.updateProgressUi();

    if (options.save && (didChange || this.file)) {
      this.persistProgressSoon();
    }
  }

  private nextPage(): void {
    if (this.pageIndex >= this.pageCount - 1) return;
    this.goToPage(this.pageIndex + 1, { animate: true, save: true });
  }

  private previousPage(): void {
    if (this.pageIndex <= 0) return;
    this.goToPage(this.pageIndex - 1, { animate: true, save: true });
  }

  private updateTransform(animate: boolean, dragOffset = 0): void {
    if (!this.articleEl) return;

    const x = -this.pageIndex * (this.pageWidth + this.columnGap) + dragOffset;
    this.articleEl.toggleClass("is-turning", animate);
    this.articleEl.style.transform = `translate3d(${x}px, 0, 0)`;
  }

  private updateProgressUi(): void {
    const humanPage = Math.min(this.pageIndex + 1, this.pageCount);
    const percent = getPercent(this.pageIndex, this.pageCount);
    const percentLabel = `${Math.round(percent * 100)}%`;

    this.pageIndicatorEl?.setText(`Page ${humanPage} of ${this.pageCount}`);
    this.percentEl?.setText(percentLabel);

    if (this.progressFillEl) {
      this.progressFillEl.style.width = `${percent * 100}%`;
    }

    if (this.previousButtonEl) {
      this.previousButtonEl.disabled = this.pageIndex <= 0;
    }

    if (this.nextButtonEl) {
      this.nextButtonEl.disabled = this.pageIndex >= this.pageCount - 1;
    }
  }

  private updateHeader(status?: string): void {
    if (!this.file) {
      this.titleEl?.setText("Page Reader");
      this.subtitleEl?.setText(status ?? "Choose a note to start reading");
      return;
    }

    this.titleEl?.setText(this.file.basename);
    this.subtitleEl?.setText(status ?? this.file.path);
  }

  private applyReaderSettings(): void {
    if (!this.rootEl || !this.articleEl) return;

    const settings = this.plugin.settings;
    this.rootEl.dataset.theme = settings.theme;
    this.rootEl.toggleClass("is-justified", settings.justifyText);
    this.rootEl.style.setProperty("--page-reader-font-size", `${settings.fontSize}px`);
    this.rootEl.style.setProperty("--page-reader-line-height", settings.lineHeight.toString());
    this.rootEl.style.setProperty("--page-reader-padding", `${settings.pagePadding}px`);
    this.rootEl.style.setProperty("--page-reader-gap", `${settings.columnGap}px`);
  }

  private renderEmptyState(): void {
    this.unloadRenderComponent();
    this.file = null;
    this.filePath = null;
    this.pageIndex = 0;
    this.pageCount = 1;
    this.updateHeader();

    if (!this.articleEl) return;
    this.articleEl.empty();
    this.articleEl.removeClass("is-loading");
    this.articleEl.createDiv({ cls: "page-reader-empty-icon", text: "📖" });
    this.articleEl.createEl("h2", { text: "Open a note in Page Reader" });
    this.articleEl.createEl("p", {
      text: "Use the ribbon icon, command palette, or a note’s file menu to read long articles one page at a time.",
    });

    const openButton = this.articleEl.createEl("button", {
      cls: "mod-cta page-reader-empty-button",
      text: "Open active note",
      attr: { type: "button" },
    });
    openButton.addEventListener("click", () => {
      void this.plugin.openActiveFileInReader();
    });

    this.recalculatePages();
  }

  private renderMissingState(message: string): void {
    this.unloadRenderComponent();
    this.pageIndex = 0;
    this.pageCount = 1;
    this.updateHeader(message);

    if (!this.articleEl) return;
    this.articleEl.empty();
    this.articleEl.removeClass("is-loading");
    this.articleEl.createDiv({ cls: "page-reader-empty-icon", text: "⚠️" });
    this.articleEl.createEl("h2", { text: "Cannot open note" });
    this.articleEl.createEl("p", { text: message });
    this.recalculatePages();
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;

    const key = event.key;
    if (key === "ArrowRight" || key === "PageDown" || (key === " " && !event.shiftKey)) {
      event.preventDefault();
      this.nextPage();
    } else if (key === "ArrowLeft" || key === "PageUp" || (key === " " && event.shiftKey)) {
      event.preventDefault();
      this.previousPage();
    } else if (key === "Home") {
      event.preventDefault();
      this.goToPage(0, { animate: true, save: true });
    } else if (key === "End") {
      event.preventDefault();
      this.goToPage(this.pageCount - 1, { animate: true, save: true });
    }
  }

  private handleWheel(event: WheelEvent): void {
    const absX = Math.abs(event.deltaX);
    const absY = Math.abs(event.deltaY);
    const horizontalTurn = absX > absY && absX > 24;
    const verticalTurn = this.plugin.settings.turnPageWithVerticalScroll && absY > absX && absY > 36;

    if (!horizontalTurn && !verticalTurn) return;

    const now = Date.now();
    if (now - this.lastWheelTurnAt < WHEEL_TURN_COOLDOWN_MS) {
      event.preventDefault();
      return;
    }

    this.lastWheelTurnAt = now;
    event.preventDefault();

    const delta = horizontalTurn ? event.deltaX : event.deltaY;
    if (delta > 0) {
      this.nextPage();
    } else {
      this.previousPage();
    }
  }

  private handlePointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest("a, button, input, textarea, select")) return;
    if (event.button !== 0) return;

    this.dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startedAt: Date.now(),
      dragging: false,
    };

    this.stageEl?.setPointerCapture(event.pointerId);
    this.stageEl?.focus();
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;

    this.dragState.lastX = event.clientX;
    this.dragState.lastY = event.clientY;

    const dx = event.clientX - this.dragState.startX;
    const dy = event.clientY - this.dragState.startY;

    if (!this.dragState.dragging) {
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy)) return;
      this.dragState.dragging = true;
    }

    event.preventDefault();

    const atStart = this.pageIndex <= 0 && dx > 0;
    const atEnd = this.pageIndex >= this.pageCount - 1 && dx < 0;
    const dampedDx = atStart || atEnd ? dx * 0.28 : dx;
    this.updateTransform(false, dampedDx);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;

    const dragState = this.dragState;
    this.dragState = null;
    this.stageEl?.releasePointerCapture(event.pointerId);

    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    const duration = Date.now() - dragState.startedAt;
    const velocity = Math.abs(dx) / Math.max(1, duration);
    const shouldTurn = Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy);
    const quickFlick = Math.abs(dx) > 28 && velocity > 0.6 && Math.abs(dx) > Math.abs(dy);

    if (shouldTurn || quickFlick) {
      if (dx < 0) {
        this.nextPage();
      } else {
        this.previousPage();
      }
    } else {
      this.updateTransform(true);
    }
  }

  private handlePointerCancel(event: PointerEvent): void {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;

    this.dragState = null;
    this.stageEl?.releasePointerCapture(event.pointerId);
    this.updateTransform(true);
  }

  private queueReload(): void {
    if (this.reloadTimer !== null) {
      window.clearTimeout(this.reloadTimer);
    }

    const percent = getPercent(this.pageIndex, this.pageCount);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      void this.renderCurrentFile({ requestedPercent: percent });
    }, 350);
  }

  private persistProgressSoon(): void {
    if (this.progressTimer !== null) {
      window.clearTimeout(this.progressTimer);
    }

    this.progressTimer = window.setTimeout(() => {
      this.progressTimer = null;
      this.persistProgressNow();
    }, 250);
  }

  private persistProgressNow(): void {
    if (this.progressTimer !== null) {
      window.clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }

    if (!this.file) return;
    this.plugin.setProgress(this.file, this.pageIndex, this.pageCount);
  }

  private resetCurrentProgress(): void {
    if (!this.file) return;

    this.plugin.resetProgress(this.file);
    this.goToPage(0, { animate: true, save: false });
    new Notice(`Page Reader progress reset for ${this.file.basename}`);
  }

  private async openSourceNote(): Promise<void> {
    if (!this.file) return;

    const workspace = this.app.workspace as typeof this.app.workspace & {
      getLeaf(type?: string | boolean): WorkspaceLeaf;
    };
    const leaf = workspace.getLeaf("tab");
    await leaf.openFile(this.file);
    this.app.workspace.revealLeaf(leaf);
  }

  private nextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  private unloadRenderComponent(): void {
    if (!this.renderComponent) return;

    this.removeChild(this.renderComponent);
    this.renderComponent = null;
  }

  private clearTimers(): void {
    if (this.paginateTimer !== null) {
      window.clearTimeout(this.paginateTimer);
      this.paginateTimer = null;
    }
    if (this.progressTimer !== null) {
      window.clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.reloadTimer !== null) {
      window.clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }
}

class PageReaderSettingTab extends PluginSettingTab {
  plugin: PageReaderPlugin;

  constructor(app: App, plugin: PageReaderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Page Reader" });
    containerEl.createEl("p", {
      text: "Tune the paged reading experience for long notes and saved articles.",
    });

    new Setting(containerEl)
      .setName("Reader theme")
      .setDesc("Choose the page background used inside Page Reader.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("obsidian", "Match Obsidian")
          .addOption("paper", "Paper")
          .addOption("sepia", "Sepia")
          .addOption("night", "Night")
          .setValue(this.plugin.settings.theme)
          .onChange(async (value) => {
            this.plugin.settings.theme = value as ReaderTheme;
            await this.plugin.savePluginData();
            this.plugin.refreshOpenReaders();
          })
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Article text size in pixels.")
      .addSlider((slider) =>
        slider
          .setLimits(14, 28, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.fontSize)
          .onChange(async (value) => {
            this.plugin.settings.fontSize = value;
            await this.plugin.savePluginData();
            this.plugin.refreshOpenReaders();
          })
      );

    new Setting(containerEl)
      .setName("Line height")
      .setDesc("Spacing between lines.")
      .addSlider((slider) =>
        slider
          .setLimits(1.2, 2.0, 0.05)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.lineHeight)
          .onChange(async (value) => {
            this.plugin.settings.lineHeight = value;
            await this.plugin.savePluginData();
            this.plugin.refreshOpenReaders();
          })
      );

    new Setting(containerEl)
      .setName("Page padding")
      .setDesc("Whitespace around every page.")
      .addSlider((slider) =>
        slider
          .setLimits(16, 72, 2)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.pagePadding)
          .onChange(async (value) => {
            this.plugin.settings.pagePadding = value;
            await this.plugin.savePluginData();
            this.plugin.refreshOpenReaders();
          })
      );

    new Setting(containerEl)
      .setName("Page turn gap")
      .setDesc("Horizontal space between virtual pages.")
      .addSlider((slider) =>
        slider
          .setLimits(24, 120, 4)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.columnGap)
          .onChange(async (value) => {
            this.plugin.settings.columnGap = value;
            await this.plugin.savePluginData();
            this.plugin.refreshOpenReaders();
          })
      );

    new Setting(containerEl)
      .setName("Justify article text")
      .setDesc("Align both edges of paragraph text, like many ebooks.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.justifyText)
          .onChange(async (value) => {
            this.plugin.settings.justifyText = value;
            await this.plugin.savePluginData();
            this.plugin.refreshOpenReaders();
          })
      );

    new Setting(containerEl)
      .setName("Hide YAML frontmatter")
      .setDesc("Remove frontmatter from the reader view so articles start at the title/body.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hideFrontmatter)
          .onChange(async (value) => {
            this.plugin.settings.hideFrontmatter = value;
            await this.plugin.savePluginData();
            this.plugin.rerenderOpenReaders();
          })
      );

    new Setting(containerEl)
      .setName("Open reader in a new tab")
      .setDesc("Keep your source note open and launch Page Reader beside it.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openInNewTab)
          .onChange(async (value) => {
            this.plugin.settings.openInNewTab = value;
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Vertical wheel turns pages")
      .setDesc("Let a regular mouse wheel move between pages. Trackpad horizontal swipes always work.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.turnPageWithVerticalScroll)
          .onChange(async (value) => {
            this.plugin.settings.turnPageWithVerticalScroll = value;
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Clear saved reading positions")
      .setDesc("Forget every saved page position for Page Reader.")
      .addButton((button) =>
        button
          .setButtonText("Clear")
          .setWarning()
          .onClick(async () => {
            this.plugin.clearAllProgress();
            await this.plugin.savePluginData();
            new Notice("Page Reader positions cleared.");
          })
      );
  }
}
