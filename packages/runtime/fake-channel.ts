import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface FakeDelivery {
  actionId: string;
  actionHash: string;
  target: { source: string; threadId: string; messageId?: string };
  content: string;
}

export interface FakeReceipt extends FakeDelivery {
  id: string;
  evidenceSource: 'offline-channel-fixture';
}

export type DeliveryCheckpoint = 'before_receipt' | 'after_receipt';
type OnCheckpoint = (point: DeliveryCheckpoint) => void | Promise<void>;

export class ChannelOutcomeUnknown extends Error {
  constructor() {
    super('Fake channel did not confirm receipt');
    this.name = 'ChannelOutcomeUnknown';
  }
}

/** The fixture sink belongs in a caller-owned temporary directory, separate from the host ledger. */
export class FakeChannel {
  readonly receiptsDirectory: string;

  private constructor(path: string) {
    this.receiptsDirectory = path;
  }

  static async open(root: string): Promise<FakeChannel> {
    const directory = join(await realpath(root), 'fake-channel-receipts');
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!(await lstat(directory)).isDirectory()) throw new Error('Fake receipt path is not a plain directory');
    return new FakeChannel(directory);
  }

  /** Each invocation may create a new receipt. Duplicate prevention remains the caller's responsibility. */
  async send(delivery: FakeDelivery, onCheckpoint?: OnCheckpoint): Promise<FakeReceipt> {
    const { actionId, actionHash, content, target: { source, threadId, messageId } } = delivery;
    if (![actionId, actionHash, content, source, threadId].every((value) => typeof value === 'string' && value.trim())
        || (messageId !== undefined && (typeof messageId !== 'string' || !messageId.trim()))) {
      throw new Error('Fake delivery must bind the action, recipient and content');
    }
    const id = randomUUID();
    const receipt: FakeReceipt = { id, evidenceSource: 'offline-channel-fixture', actionId, actionHash,
      target: messageId === undefined ? { source, threadId } : { source, threadId, messageId }, content };
    const data = JSON.stringify(receipt);
    if (Buffer.byteLength(data) > 64 * 1024) throw new Error('Fake receipt exceeds size limit');
    const temporary = join(this.receiptsDirectory, `${id}.pending`);
    let created = false;
    try {
      await onCheckpoint?.('before_receipt');
      const file = await open(temporary, 'wx');
      created = true;
      try {
        await file.writeFile(data, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.receiptsDirectory, `${id}.json`));
      created = false;
      await onCheckpoint?.('after_receipt');
      return receipt;
    } catch {
      if (created) await unlink(temporary).catch(() => {});
      throw new ChannelOutcomeUnknown();
    }
  }

  async receipts(): Promise<FakeReceipt[]> {
    const entries = await readdir(this.receiptsDirectory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.json$/.test(entry.name));
    return Promise.all(files.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
      return JSON.parse(await readFile(join(this.receiptsDirectory, entry.name), 'utf8')) as FakeReceipt;
    }));
  }
}
