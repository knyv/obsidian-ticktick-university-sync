import { App, Modal, Notice } from 'obsidian';

export class AuthCodeModal extends Modal {
  private onSubmit: (input: string) => Promise<void>;

  constructor(app: App, onSubmit: (input: string) => Promise<void>) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'Paste TickTick auth code or full redirect URL' });
    const text = contentEl.createEl('textarea');
    text.style.width = '100%';
    text.style.minHeight = '100px';
    text.placeholder = 'https://localhost/?code=... or just the code';

    const btnRow = contentEl.createDiv({ cls: 'ticktick-sync-modal-btns' });
    const submit = btnRow.createEl('button', { text: 'Exchange' });
    submit.addEventListener('click', async () => {
      try {
        await this.onSubmit(text.value);
        this.close();
      } catch (e) {
        new Notice(e instanceof Error ? e.message : String(e));
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
