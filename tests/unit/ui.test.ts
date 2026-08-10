import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { ConnectionModal, type ConnectionDraft } from '../../src/ui/connection-modal';
import { ConfirmModal } from '../../src/ui/confirm-modal';
import { ConnectionsSection } from '../../src/ui/connections-section';
import { SpaceBrowserModal, filterSpaces } from '../../src/ui/space-browser-modal';
import { CredentialStore } from '../../src/auth/credential-store';
import { SettingsStore } from '../../src/settings/settings-store';
import type { ConfluenceClient } from '../../src/api/confluence-client';
import type { ConfluenceSpace } from '../../src/api/api-types';
import { Logger } from '../../src/util/logger';
import { App as FakeApp, Notice, Plugin as FakePlugin } from '../fakes/obsidian';

const app = new FakeApp() as unknown as App;

function inputsOf(el: HTMLElement): HTMLInputElement[] {
  return Array.from(el.querySelectorAll('input'));
}

function buttonsOf(el: HTMLElement): HTMLButtonElement[] {
  return Array.from(el.querySelectorAll('button'));
}

function type(input: HTMLInputElement | undefined, value: string): void {
  if (input === undefined) throw new Error('expected an input');
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function click(buttons: HTMLButtonElement[], label: string): void {
  const button = buttons.find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`no button labelled "${label}"`);
  button.dispatchEvent(new Event('click'));
}

beforeEach(() => {
  Notice.reset();
});

describe('ConnectionModal', () => {
  function open(initial: Record<string, unknown> = {}) {
    const onSubmit = vi.fn<(draft: ConnectionDraft) => void>();
    const modal = new ConnectionModal(app, initial, onSubmit);
    modal.open();
    return { modal, onSubmit, fields: inputsOf(modal.contentEl) };
  }

  it('renders name, base URL and token fields', () => {
    const { fields } = open();
    expect(fields).toHaveLength(3);
  });

  it('masks the token field', () => {
    const { fields } = open();
    expect(fields[2]?.type).toBe('password');
  });

  it('rejects an invalid base URL without submitting', () => {
    const { modal, onSubmit, fields } = open();
    type(fields[1], 'ftp://wiki.corp');
    type(fields[2], 'SOME-TOKEN');
    click(buttonsOf(modal.contentEl), 'Save');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(Notice.shown[0]).toContain('https://');
  });

  it('requires a token when none is stored yet', () => {
    const { modal, onSubmit, fields } = open();
    type(fields[1], 'https://wiki.corp/confluence');
    click(buttonsOf(modal.contentEl), 'Save');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(Notice.shown[0]).toContain('Personal Access Token');
  });

  it('accepts a blank token when one is already stored', () => {
    const { modal, onSubmit } = open({
      baseUrl: 'https://wiki.corp',
      hasStoredToken: true,
    });
    click(buttonsOf(modal.contentEl), 'Save');

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]?.[0].token).toBe('');
  });

  it('normalises the base URL before handing it over', () => {
    const { modal, onSubmit, fields } = open();
    type(fields[1], 'wiki.corp/confluence/rest/api/');
    type(fields[2], 'SOME-TOKEN');
    click(buttonsOf(modal.contentEl), 'Save');

    expect(onSubmit.mock.calls[0]?.[0].baseUrl).toBe('https://wiki.corp/confluence');
  });

  it('falls back to the base URL when no name is given', () => {
    const { modal, onSubmit, fields } = open();
    type(fields[1], 'https://wiki.corp');
    type(fields[2], 'SOME-TOKEN');
    click(buttonsOf(modal.contentEl), 'Save');

    expect(onSubmit.mock.calls[0]?.[0].displayName).toBe('https://wiki.corp');
  });

  it('keeps a name the user supplied', () => {
    const { modal, onSubmit, fields } = open();
    type(fields[0], '  Corporate wiki  ');
    type(fields[1], 'https://wiki.corp');
    type(fields[2], 'SOME-TOKEN');
    click(buttonsOf(modal.contentEl), 'Save');

    expect(onSubmit.mock.calls[0]?.[0].displayName).toBe('Corporate wiki');
  });

  it('does not submit when cancelled', () => {
    const { modal, onSubmit } = open();
    click(buttonsOf(modal.contentEl), 'Cancel');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clears its content when closed', () => {
    const { modal } = open();
    modal.close();
    expect(inputsOf(modal.contentEl)).toHaveLength(0);
  });
});

describe('ConfirmModal', () => {
  it('confirms on click when no phrase is required', () => {
    const onConfirm = vi.fn();
    const modal = new ConfirmModal(app, { title: 'T', body: 'B' }, onConfirm);
    modal.open();
    click(buttonsOf(modal.contentEl), 'Confirm');

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('uses a custom confirm label', () => {
    const modal = new ConfirmModal(app, { title: 'T', body: 'B', confirmText: 'Remove' }, vi.fn());
    modal.open();
    expect(buttonsOf(modal.contentEl).map((b) => b.textContent)).toContain('Remove');
  });

  it('refuses to confirm until the exact phrase is typed', () => {
    const onConfirm = vi.fn();
    const modal = new ConfirmModal(
      app,
      { title: 'T', body: 'B', requireTyped: 'Data Model' },
      onConfirm,
    );
    modal.open();

    click(buttonsOf(modal.contentEl), 'Confirm');
    expect(onConfirm).not.toHaveBeenCalled();

    type(inputsOf(modal.contentEl)[0], 'data model');
    click(buttonsOf(modal.contentEl), 'Confirm');
    expect(onConfirm).not.toHaveBeenCalled();

    type(inputsOf(modal.contentEl)[0], 'Data Model');
    click(buttonsOf(modal.contentEl), 'Confirm');
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('does not confirm when cancelled', () => {
    const onConfirm = vi.fn();
    const modal = new ConfirmModal(app, { title: 'T', body: 'B' }, onConfirm);
    modal.open();
    click(buttonsOf(modal.contentEl), 'Cancel');

    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('filterSpaces', () => {
  const spaces: ConfluenceSpace[] = [
    { key: 'ENG', name: 'Engineering', type: 'global' },
    { key: 'OPS', name: 'Operations', type: 'global' },
    { key: 'HR', name: 'People and Culture', type: 'global' },
  ];

  it('returns everything for an empty query', () => {
    expect(filterSpaces(spaces, '')).toHaveLength(3);
    expect(filterSpaces(spaces, '   ')).toHaveLength(3);
  });

  it('matches on key', () => {
    expect(filterSpaces(spaces, 'eng').map((s) => s.key)).toEqual(['ENG']);
  });

  it('matches on name, case-insensitively', () => {
    expect(filterSpaces(spaces, 'PEOPLE').map((s) => s.key)).toEqual(['HR']);
  });

  it('matches a substring anywhere in the name', () => {
    expect(filterSpaces(spaces, 'ation').map((s) => s.key)).toEqual(['OPS']);
  });

  it('returns nothing when there is no match', () => {
    expect(filterSpaces(spaces, 'zzz')).toEqual([]);
  });
});

describe('SpaceBrowserModal', () => {
  const spaces: ConfluenceSpace[] = [
    { key: 'ENG', name: 'Engineering', type: 'global' },
    { key: 'OPS', name: 'Operations', type: 'global' },
  ];

  it('lists every space with a select button', () => {
    const modal = new SpaceBrowserModal(app, spaces, vi.fn());
    modal.open();
    expect(buttonsOf(modal.contentEl).filter((b) => b.textContent === 'Select')).toHaveLength(2);
  });

  it('reports its choice and closes', () => {
    const onChoose = vi.fn();
    const modal = new SpaceBrowserModal(app, spaces, onChoose);
    modal.open();
    buttonsOf(modal.contentEl)[0]?.dispatchEvent(new Event('click'));

    expect(onChoose).toHaveBeenCalledWith(spaces[0]);
    // Closing tears the dialog down; contentEl is emptied by onClose.
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it('narrows the list as the filter changes', () => {
    const modal = new SpaceBrowserModal(app, spaces, vi.fn());
    modal.open();
    type(inputsOf(modal.contentEl)[0], 'ops');

    expect(buttonsOf(modal.contentEl).filter((b) => b.textContent === 'Select')).toHaveLength(1);
  });

  it('says so when nothing matches', () => {
    const modal = new SpaceBrowserModal(app, spaces, vi.fn());
    modal.open();
    type(inputsOf(modal.contentEl)[0], 'zzz');

    expect(modal.contentEl.textContent).toContain('No spaces match');
  });
});

describe('ConnectionsSection', () => {
  function setup(settingsData: unknown = null) {
    const plugin = new FakePlugin(new FakeApp(), {
      id: 'x',
      name: 'x',
      version: '0',
      minAppVersion: '0',
      description: '',
      author: '',
    });
    plugin.setStoredData(settingsData);
    const logger = new Logger('test', () => false);
    const store = new SettingsStore(plugin, logger);
    const credentials = new CredentialStore(null, store, logger);
    const section = new ConnectionsSection({
      app,
      store,
      credentials,
      createClient: (): ConfluenceClient => {
        throw new Error('no client should be created while rendering');
      },
      newId: () => 'generated-id',
      refresh: vi.fn(),
    });
    const containerEl = document.createElement('div');
    return { section, store, containerEl };
  }

  it('invites the user to add a connection when there are none', () => {
    const { section, containerEl } = setup();
    section.render(containerEl);

    expect(containerEl.textContent).toContain('No connections yet');
    expect(buttonsOf(containerEl).map((b) => b.textContent)).toContain('Add connection');
  });

  it('lists a configured connection with its base URL', async () => {
    const { section, store, containerEl } = setup();
    await store.update({
      connections: [{ id: 'c1', displayName: 'Corporate wiki', baseUrl: 'https://wiki.corp' }],
    });
    section.render(containerEl);

    expect(containerEl.textContent).toContain('Corporate wiki');
    expect(containerEl.textContent).toContain('https://wiki.corp');
  });

  it('flags a connection with no stored token', async () => {
    const { section, store, containerEl } = setup();
    await store.update({
      connections: [{ id: 'c1', displayName: 'Corporate wiki', baseUrl: 'https://wiki.corp' }],
    });
    section.render(containerEl);

    expect(containerEl.textContent).toContain('no token stored');
  });

  it('refuses to remove a connection that subscriptions depend on', async () => {
    // Removing it would orphan the subscriptions and their mirrored files.
    const { section, store, containerEl } = setup();
    await store.update({
      connections: [{ id: 'c1', displayName: 'Corporate wiki', baseUrl: 'https://wiki.corp' }],
      subscriptions: [
        {
          id: 's1',
          connectionId: 'c1',
          spaceKey: 'ENG',
          rootPageId: null,
          mountPath: 'Confluence/ENG',
          syncComments: true,
        },
      ],
    });
    section.render(containerEl);
    click(buttonsOf(containerEl), 'Remove');

    expect(Notice.shown[0]).toContain('subscription');
    expect(store.get().connections).toHaveLength(1);
  });
});
