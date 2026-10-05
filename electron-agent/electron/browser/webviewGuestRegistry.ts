export interface GuestLike {
  id: number;
  getType(): string;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): void;
}

export class WebviewGuestRegistry {
  private readonly tabByContents = new Map<number, string>();
  private readonly contentsByTab = new Map<string, number>();

  attach(tabId: string, guest: GuestLike): { ok: boolean } {
    if (guest.isDestroyed() || guest.getType() !== 'webview') return { ok: false };
    this.detach(tabId);
    const previousTab = this.tabByContents.get(guest.id);
    if (previousTab) this.contentsByTab.delete(previousTab);
    this.tabByContents.set(guest.id, tabId);
    this.contentsByTab.set(tabId, guest.id);
    guest.once('destroyed', () => {
      if (this.tabByContents.get(guest.id) === tabId) this.detach(tabId);
    });
    return { ok: true };
  }

  detach(tabId: string): void {
    const contentsId = this.contentsByTab.get(tabId);
    this.contentsByTab.delete(tabId);
    if (contentsId !== undefined && this.tabByContents.get(contentsId) === tabId) {
      this.tabByContents.delete(contentsId);
    }
  }

  tabIdFor(webContentsId: number): string | undefined {
    return this.tabByContents.get(webContentsId);
  }
}
