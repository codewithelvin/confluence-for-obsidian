/**
 * Runtime fake for the `obsidian` module.
 *
 * Obsidian's API is provided by the host application and has no installable
 * implementation, so tests alias `obsidian` to this file (see vitest.config.ts).
 * Type-checking still resolves to the real `obsidian` typings in node_modules,
 * which keeps the production types honest while making the runtime testable.
 *
 * Components render real DOM nodes so tests can dispatch genuine events rather
 * than reaching into fake internals. Anything not implemented here is absent
 * rather than stubbed, so unsupported usage fails loudly.
 */

interface ObsidianDomExtensions {
  empty(): void;
  setText(text: string): void;
  addClass(...classes: string[]): void;
  createEl(tag: string, options?: { text?: string; cls?: string }): HTMLElement;
  createDiv(options?: { text?: string; cls?: string }): HTMLElement;
}

/** Installs the DOM helpers Obsidian adds to HTMLElement.prototype. */
function augmentDom(): void {
  if (typeof HTMLElement === 'undefined') return;
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;

  proto['empty'] = function (this: HTMLElement): void {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
  proto['setText'] = function (this: HTMLElement, text: string): void {
    this.textContent = text;
  };
  proto['addClass'] = function (this: HTMLElement, ...classes: string[]): void {
    this.classList.add(...classes);
  };
  proto['createEl'] = function (
    this: HTMLElement,
    tag: string,
    options?: { text?: string; cls?: string },
  ): HTMLElement {
    const el = this.ownerDocument.createElement(tag);
    if (options?.text !== undefined) el.textContent = options.text;
    if (options?.cls !== undefined) el.className = options.cls;
    this.appendChild(el);
    return el;
  };
  proto['createDiv'] = function (
    this: HTMLElement,
    options?: { text?: string; cls?: string },
  ): HTMLElement {
    return (this as unknown as ObsidianDomExtensions).createEl('div', options);
  };
}

augmentDom();

import { FileManager, MetadataCache, TFile, Vault } from './obsidian-vault';

export {
  FileManager,
  MetadataCache,
  Vault,
  FileSystemAdapter,
  TAbstractFile,
  TFile,
  TFolder,
  parseFrontmatter,
  serialiseFrontmatter,
} from './obsidian-vault';

export class Workspace {
  activeFile: TFile | null = null;
  readonly revealed: unknown[] = [];

  getActiveFile(): TFile | null {
    return this.activeFile;
  }

  getLeavesOfType(): WorkspaceLeaf[] {
    return [];
  }

  getRightLeaf(): WorkspaceLeaf | null {
    return new WorkspaceLeaf();
  }

  revealLeaf(leaf: unknown): Promise<void> {
    this.revealed.push(leaf);
    return Promise.resolve();
  }
}

export class WorkspaceLeaf {
  viewState: unknown = null;

  setViewState(state: unknown): Promise<void> {
    this.viewState = state;
    return Promise.resolve();
  }
}

export class App {
  readonly vault = new Vault();
  readonly fileManager = new FileManager(this.vault);
  readonly metadataCache = new MetadataCache(this.vault);
  readonly workspace = new Workspace();
}

/** Minimal stand-in for Obsidian's sidebar view base class. */
export class ItemView {
  readonly containerEl: HTMLElement;
  readonly contentEl: HTMLElement;

  constructor(readonly leaf: WorkspaceLeaf) {
    this.containerEl = document.createElement('div');
    this.contentEl = this.containerEl.appendChild(document.createElement('div'));
  }
}

export interface PluginManifest {
  /** Vault path of the plugin folder; where plugin state is written. */
  dir?: string;
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  isDesktopOnly?: boolean;
}

export class Plugin {
  readonly settingTabs: PluginSettingTab[] = [];
  private stored: unknown = null;

  constructor(
    readonly app: App,
    readonly manifest: PluginManifest,
  ) {}

  loadData(): Promise<unknown> {
    return Promise.resolve(this.stored);
  }

  saveData(data: unknown): Promise<void> {
    this.stored = data;
    return Promise.resolve();
  }

  /** Test helper: seed persisted data as if it were already on disk. */
  setStoredData(data: unknown): void {
    this.stored = data;
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }

  readonly commands: { id: string; name: string; callback?: () => unknown }[] = [];

  readonly views = new Map<string, unknown>();
  readonly codeBlockProcessors = new Map<string, unknown>();
  readonly postProcessors: unknown[] = [];
  readonly statusBarItems: HTMLElement[] = [];

  registerEvent(): void {}
  registerInterval(): void {}
  registerDomEvent(): void {}

  registerView(type: string, factory: unknown): void {
    this.views.set(type, factory);
  }

  registerMarkdownCodeBlockProcessor(language: string, handler: unknown): void {
    this.codeBlockProcessors.set(language, handler);
  }

  registerMarkdownPostProcessor(handler: unknown): void {
    this.postProcessors.push(handler);
  }

  addStatusBarItem(): HTMLElement {
    const element = document.createElement('div');
    this.statusBarItems.push(element);
    return element;
  }

  addCommand(command: { id: string; name: string; callback?: () => unknown }): void {
    this.commands.push(command);
  }
}

export class PluginSettingTab {
  readonly containerEl: HTMLElement;

  constructor(
    readonly app: App,
    readonly plugin: Plugin,
  ) {
    this.containerEl = document.createElement('div');
  }

  display(): void {}
  hide(): void {}
}

export class ToggleComponent {
  readonly inputEl: HTMLInputElement;

  constructor(containerEl: HTMLElement) {
    this.inputEl = containerEl.ownerDocument.createElement('input');
    this.inputEl.type = 'checkbox';
    containerEl.appendChild(this.inputEl);
  }

  setValue(value: boolean): this {
    this.inputEl.checked = value;
    return this;
  }

  getValue(): boolean {
    return this.inputEl.checked;
  }

  onChange(callback: (value: boolean) => void): this {
    this.inputEl.addEventListener('change', () => callback(this.inputEl.checked));
    return this;
  }
}

export class DropdownComponent {
  readonly selectEl: HTMLSelectElement;

  constructor(containerEl: HTMLElement) {
    this.selectEl = document.createElement('select');
    containerEl.appendChild(this.selectEl);
  }

  addOption(value: string, display: string): this {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = display;
    this.selectEl.appendChild(option);
    return this;
  }

  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }

  getValue(): string {
    return this.selectEl.value;
  }

  onChange(callback: (value: string) => void): this {
    this.selectEl.addEventListener('change', () => callback(this.selectEl.value));
    return this;
  }
}

export class TextComponent {
  readonly inputEl: HTMLInputElement;

  constructor(containerEl: HTMLElement) {
    this.inputEl = containerEl.ownerDocument.createElement('input');
    this.inputEl.type = 'text';
    containerEl.appendChild(this.inputEl);
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  setPlaceholder(value: string): this {
    this.inputEl.placeholder = value;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.inputEl.addEventListener('input', () => callback(this.inputEl.value));
    return this;
  }
}

export class Setting {
  readonly settingEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;
  isHeading = false;

  constructor(containerEl: HTMLElement) {
    const doc = containerEl.ownerDocument;
    this.settingEl = doc.createElement('div');
    this.settingEl.className = 'setting-item';
    this.nameEl = this.settingEl.appendChild(doc.createElement('div'));
    this.descEl = this.settingEl.appendChild(doc.createElement('div'));
    this.controlEl = this.settingEl.appendChild(doc.createElement('div'));
    containerEl.appendChild(this.settingEl);
  }

  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }

  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }

  setHeading(): this {
    this.isHeading = true;
    this.settingEl.classList.add('setting-item-heading');
    return this;
  }

  addToggle(build: (toggle: ToggleComponent) => unknown): this {
    build(new ToggleComponent(this.controlEl));
    return this;
  }

  addDropdown(build: (dropdown: DropdownComponent) => unknown): this {
    build(new DropdownComponent(this.controlEl));
    return this;
  }

  addText(build: (text: TextComponent) => unknown): this {
    build(new TextComponent(this.controlEl));
    return this;
  }

  addButton(build: (button: ButtonComponent) => unknown): this {
    build(new ButtonComponent(this.controlEl));
    return this;
  }
}

export class ButtonComponent {
  readonly buttonEl: HTMLButtonElement;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = containerEl.ownerDocument.createElement('button');
    containerEl.appendChild(this.buttonEl);
  }

  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }

  setCta(): this {
    this.buttonEl.classList.add('mod-cta');
    return this;
  }

  setWarning(): this {
    this.buttonEl.classList.add('mod-warning');
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return this;
  }

  onClick(callback: () => unknown): this {
    this.buttonEl.addEventListener('click', () => void callback());
    return this;
  }
}

/** Records notices so tests can assert on user-facing messages. */
export class Notice {
  static readonly shown: string[] = [];
  message: string;
  hidden = false;

  constructor(message: string, _duration?: number) {
    this.message = message;
    Notice.shown.push(message);
  }

  setMessage(message: string): this {
    this.message = message;
    Notice.shown.push(message);
    return this;
  }

  hide(): void {
    this.hidden = true;
  }

  static reset(): void {
    Notice.shown.length = 0;
  }
}

export class Modal {
  readonly containerEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  isOpen = false;

  constructor(readonly app: App) {
    this.containerEl = document.createElement('div');
    this.titleEl = this.containerEl.appendChild(document.createElement('div'));
    this.contentEl = this.containerEl.appendChild(document.createElement('div'));
  }

  open(): void {
    this.isOpen = true;
    this.onOpen();
  }

  close(): void {
    this.isOpen = false;
    this.onClose();
  }

  onOpen(): void {}
  onClose(): void {}
}

export interface FakeRequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

type RequestUrlHandler = (param: unknown) => Promise<FakeRequestUrlResponse>;

let requestUrlHandler: RequestUrlHandler = () =>
  Promise.reject(new Error('requestUrl was called without a stub'));

/** Installs the response (or failure) the next requestUrl call should produce. */
export function setRequestUrlHandler(handler: RequestUrlHandler): void {
  requestUrlHandler = handler;
}

export function resetRequestUrlHandler(): void {
  requestUrlHandler = () => Promise.reject(new Error('requestUrl was called without a stub'));
}

export function requestUrl(param: unknown): Promise<FakeRequestUrlResponse> {
  return requestUrlHandler(param);
}

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
}
