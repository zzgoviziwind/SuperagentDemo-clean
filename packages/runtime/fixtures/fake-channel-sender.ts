import { FakeChannel } from '../fake-channel.ts';
import type { FakeDelivery } from '../fake-channel.ts';

const root = process.argv[2]!;
const delivery = JSON.parse(process.argv[3]!) as FakeDelivery;
const exitAt = process.argv[4];
const channel = await FakeChannel.open(root);
const receipt = await channel.send(delivery, (point) => {
  if (point === exitAt) process.exit(point === 'before_receipt' ? 81 : 82);
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
