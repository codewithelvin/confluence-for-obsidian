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

export class App {}

export interface PluginManifest {
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

  registerEvent(): void {}
  registerInterval(): void {}
  registerDomEvent(): void {}
  addCommand(): void {}
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

  addText(build: (text: TextComponent) => unknown): this {
    build(new TextComponent(this.controlEl));
    return this;
  }
}

export class Notice {
  constructor(readonly message: string) {}
}

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
}
