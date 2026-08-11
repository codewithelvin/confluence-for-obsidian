import { beforeEach, describe, expect, it } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import { SettingsStore } from '../../src/settings/settings-store';
import type { Subscription } from '../../src/settings/settings-types';
import { FragmentStore } from '../../src/sync/fragment-store';
import { SyncController } from '../../src/sync/sync-controller';
import { SyncStateStore } from '../../src/sync/sync-state';
import { SuspensionRegistry } from '../../src/sync/suspension';
import { Logger } from '../../src/util/logger';
import {
  describePlaceholder,
  parsePlaceholderFields,
  pageUrlFromCache,
  decorateInlinePlaceholders,
  registerPlaceholderRenderer,
  renderPlaceholder,
} from '../../src/ui/placeholder-renderer';
import { StatusBar, statusText } from '../../src/ui/status-bar';
import { SYNC_PANEL_VIEW_TYPE, SyncPanelView } from '../../src/ui/sync-panel-view';
import { RemoveSubscriptionModal } from '../../src/ui/remove-subscription-modal';
import { SubscriptionModal } from '../../src/ui/subscription-modal';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway } from '../fakes/sync';
import {
  App as FakeApp,
  Plugin as FakePlugin,
  WorkspaceLeaf as FakeLeaf,
  type PluginManifest,
} from '../fakes/obsidian';

const MANIFEST: PluginManifest = {
  id: 'confluence-dc-connector',
  name: 'Confluence 4 Obsidian',
  version: '0.0.1',
  minAppVersion: '1.5.3',
  description: 'test',
  author: 'test',
};

const SUBSCRIPTION: Subscription = {
  id: 'sub',
  connectionId: 'conn',
  spaceKey: 'ENG',
  rootPageId: null,
  mountPath: 'Confluence',
  syncComments: true,
};

let app: FakeApp;
let settings: SettingsStore;
let suspensions: SuspensionRegistry;
let controller: SyncController;
let client: FakeConfluence;

beforeEach(async () => {
  app = new FakeApp();
  const logger = new Logger('test', () => false);
  const stateGateway = new FakeStateGateway();
  client = new FakeConfluence();
  suspensions = new SuspensionRegistry();
  settings = new SettingsStore(new FakePlugin(app, MANIFEST), logger);
  await settings.load();
  await settings.update({
    connections: [
      { id: 'conn', displayName: 'Corp wiki', baseUrl: 'https://wiki.corp', strictMarkup: false },
    ],
    subscriptions: [SUBSCRIPTION],
  });

  controller = new SyncController({
    settings,
    vault: new FakeVaultGateway(),
    state: new SyncStateStore(stateGateway),
    fragments: new FragmentStore(stateGateway),
    suspensions,
    logger,
    newId: () => 'sub-2',
    createClient: () => client,
    now: () => '2026-08-10T12:00:00Z',
  });
  await controller.load();
});

describe('placeholder renderer (FR-4.5)', () => {
  const FENCE = 'id: cfb-0001\ntype: macro\nname: jira\nlabel: Open bugs in PROJ';

  it('reads the flat key/value fence body', () => {
    const fields = parsePlaceholderFields(FENCE);

    expect(fields.get('id')).toBe('cfb-0001');
    expect(fields.get('label')).toBe('Open bugs in PROJ');
  });

  it('ignores lines a user has damaged rather than guessing', () => {
    expect(parsePlaceholderFields('garbage\n\nid: cfb-0002').get('id')).toBe('cfb-0002');
  });

  it('names the construct a reader would recognise', () => {
    expect(describePlaceholder(parsePlaceholderFields(FENCE))).toBe('jira macro');
    expect(describePlaceholder(new Map([['type', 'layout']]))).toBe('Confluence layout');
    expect(describePlaceholder(new Map([['type', 'unsupported']]))).toBe('Confluence content');
    expect(describePlaceholder(new Map())).toBe('Confluence content');
  });

  it('renders a labelled widget, never the preserved markup', () => {
    // Page bodies are untrusted input; this is the plugin's XSS boundary.
    const host = document.createElement('div');
    renderPlaceholder(host, `${FENCE}\nxhtml: <script>alert(1)</script>`, null, () => {
      throw new Error('nothing to open');
    });

    expect(host.textContent).toContain('jira macro');
    expect(host.textContent).toContain('Open bugs in PROJ');
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
  });

  it('offers Open in Confluence when the note knows its page', () => {
    const host = document.createElement('div');
    const opened: string[] = [];
    renderPlaceholder(host, FENCE, 'https://wiki.corp/x', (url) => opened.push(url));

    host.querySelector('button')?.click();
    expect(opened).toEqual(['https://wiki.corp/x']);
  });

  it('registers itself against the confluence-block language', () => {
    const registered: string[] = [];
    const host = document.createElement('div');

    registerPlaceholderRenderer({
      register: (language, handler) => {
        registered.push(language);
        handler(FENCE, host, 'ENG/A.md');
      },
      registerInline: () => undefined,
      pageUrlFor: () => null,
      labelsFor: () => Promise.resolve(new Map()),
      openExternal: () => undefined,
    });

    expect(registered).toEqual(['confluence-block']);
    expect(host.textContent).toContain('jira macro');
  });

  it('replaces an inline sentinel with a pill naming the construct (FR-4.5)', async () => {
    // A reader must never be shown `{cf:cfb-0007}`. The label comes from the
    // fragment cache, since the note itself carries only the sentinel.
    const host = document.createElement('div');
    host.innerHTML = 'See <code>{cf:cfb-0007}</code> and <code>ordinary()</code>.';

    await decorateInlinePlaceholders(host, 'ENG/A.md', () =>
      Promise.resolve(new Map([['cfb-0007', 'viewdoc macro']])),
    );

    expect(host.textContent).toBe('See viewdoc macro and ordinary().');
    expect(host.querySelector('.confluence-inline-placeholder')?.textContent).toBe('viewdoc macro');
    // Ordinary inline code is left exactly as it was.
    expect(host.querySelectorAll('code')).toHaveLength(1);
  });

  it('falls back to a generic name when the fragment is no longer cached', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<code>{cf:cfb-0001}</code>';

    await decorateInlinePlaceholders(host, 'ENG/A.md', () => Promise.resolve(new Map()));

    expect(host.textContent).toBe('Confluence content');
  });

  it('does not read the fragment cache for a note with no placeholders', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>Just prose, and <code>some.code()</code>.</p>';
    let asked = 0;

    await decorateInlinePlaceholders(host, 'ENG/A.md', () => {
      asked += 1;
      return Promise.resolve(new Map());
    });

    expect(asked).toBe(0);
  });

  it('reads the page URL out of a note cache, tolerating a missing block', () => {
    expect(pageUrlFromCache({ frontmatter: { confluence: { url: 'https://x' } } })).toBe(
      'https://x',
    );
    expect(pageUrlFromCache({ frontmatter: {} })).toBeNull();
    expect(pageUrlFromCache(null)).toBeNull();
  });
});

describe('status bar (FR-10.3)', () => {
  it('says what sync is doing', () => {
    expect(statusText('Writing pages', 0, null)).toBe('Confluence: Writing pages');
    expect(statusText(null, 1, null)).toBe('Confluence: sync suspended');
    expect(statusText(null, 0, null)).toBe('Confluence: not synced');
    expect(statusText(null, 0, '2026-08-10T12:00:00Z')).toContain('Confluence: synced');
  });

  it('mounts, reacts to a suspension and unmounts cleanly', () => {
    const element = document.createElement('div');
    let clicks = 0;
    const bar = new StatusBar({
      element,
      controller,
      suspensions,
      subscriptionIds: () => ['sub'],
      onClick: () => {
        clicks += 1;
      },
    });

    bar.start();
    expect(element.textContent).toBe('Confluence: not synced');

    suspensions.suspend('conn', 'Token rejected.', '2026-08-10T12:00:00Z');
    expect(element.textContent).toBe('Confluence: sync suspended');

    element.click();
    expect(clicks).toBe(1);

    bar.stop();
    element.click();
    expect(clicks).toBe(1);
  });
});

function panel(): SyncPanelView {
  return new SyncPanelView(new FakeLeaf() as unknown as WorkspaceLeaf, {
    store: settings,
    controller,
    suspensions,
    startSync: () => undefined,
  });
}

describe('sync panel (FR-10.2)', () => {
  it('identifies itself to the workspace', () => {
    const view = panel();

    expect(view.getViewType()).toBe(SYNC_PANEL_VIEW_TYPE);
    expect(view.getDisplayText()).toBe('Confluence sync');
    expect(view.getIcon().length).toBeGreaterThan(0);
  });

  it('mounts, lists subscriptions and unmounts cleanly', async () => {
    const view = panel();
    await view.onOpen();

    expect(view.contentEl.textContent).toContain('ENG');
    expect(view.contentEl.textContent).toContain('Never synced');

    await view.onClose();
    expect(view.contentEl.childElementCount).toBe(0);
  });

  it('says so when there is nothing subscribed', async () => {
    await settings.update({ subscriptions: [] });
    const view = panel();
    await view.onOpen();

    expect(view.contentEl.textContent).toContain('No subscriptions yet');
    await view.onClose();
  });

  it('shows the persistent notice left by an authentication failure (FR-1.8)', async () => {
    const view = panel();
    await view.onOpen();
    suspensions.suspend('conn', 'Token rejected.', '2026-08-10T12:00:00Z');

    expect(view.contentEl.textContent).toContain('Corp wiki');
    expect(view.contentEl.textContent).toContain('Token rejected.');
    await view.onClose();
  });

  it('reports everything the last sync wants a decision about', async () => {
    client.pages = [
      { id: '1', title: 'A', storage: '<p>a</p><hr style="border-top: 1px solid red;"/>' },
    ];
    const view = panel();
    await view.onOpen();

    await controller.sync(SUBSCRIPTION);

    expect(view.contentEl.textContent).toContain('1 pulled');
    expect(view.contentEl.textContent).toContain('Read-only');
    await view.onClose();
  });

  it('stops listening once closed', async () => {
    const view = panel();
    await view.onOpen();
    await view.onClose();

    suspensions.suspend('conn', 'Token rejected.', '2026-08-10T12:00:00Z');
    expect(view.contentEl.childElementCount).toBe(0);
  });
});

describe('subscription modals', () => {
  it('opens and closes the subscription modal cleanly', () => {
    const modal = new SubscriptionModal(app as unknown as App, {
      connections: settings.get().connections,
      existing: settings.get().subscriptions,
      listSpaces: () => Promise.resolve({ ok: true, value: [] }),
      check: () => Promise.resolve({ ok: true, value: { pageCount: 1, warning: null } }),
      onSave: () => undefined,
    });

    modal.open();
    expect(modal.contentEl.textContent).toContain('Vault folder');

    modal.close();
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it('explains that a connection is needed first', () => {
    const modal = new SubscriptionModal(app as unknown as App, {
      connections: [],
      existing: [],
      listSpaces: () => Promise.resolve({ ok: true, value: [] }),
      check: () => Promise.resolve({ ok: true, value: { pageCount: 0, warning: null } }),
      onSave: () => {
        throw new Error('must not save without a connection');
      },
    });

    modal.open();
    expect(modal.contentEl.textContent).toContain('Add a Confluence connection first');
    modal.close();
  });

  it('offers keep and delete, and says Confluence is untouched (FR-2.6)', () => {
    const chosen: boolean[] = [];
    const modal = new RemoveSubscriptionModal(app as unknown as App, SUBSCRIPTION, (deleteFiles) =>
      chosen.push(deleteFiles),
    );

    modal.open();
    expect(modal.contentEl.textContent).toContain('Nothing is deleted in Confluence');

    const buttons = modal.contentEl.querySelectorAll('button');
    buttons[0]?.click();
    expect(chosen).toEqual([false]);
  });
});
