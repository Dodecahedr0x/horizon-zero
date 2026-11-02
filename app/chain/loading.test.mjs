import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { createSolanaChain } from './solana.ts';
import { STANDARDS, encodeBehavior, BATTLEGROUNDS, battlegroundPda } from '../src/codec.ts';

test('new behaviors and armies load from the rollup before indexing', async () => {
  const owner = new PublicKey(new Uint8Array(32).fill(7));
  const body = encodeBehavior(STANDARDS[0].elements);
  const behavior = Buffer.alloc(119);
  owner.toBuffer().copy(behavior, 8);
  behavior[40] = body.length;
  behavior.set(body, 41);
  const army = Buffer.alloc(1360);
  owner.toBuffer().copy(army, 8);
  battlegroundPda(0).toBuffer().copy(army, 40);
  army[77] = 1;
  owner.toBuffer().copy(army, 79);
  army[111] = body.length;
  army.set(body, 112);
  const er = {
    getProgramAccounts: async (_, options) => [{ pubkey: owner, account: { data: options.filters[0].dataSize === 119 ? behavior : army } }],
    getMultipleAccountsInfo: async () => BATTLEGROUNDS.map(() => null),
  };
  const chain = createSolanaChain({ owner }, { er, read: async () => [], base: {}, rent: async () => 0 });
  assert.equal((await chain.behaviors()).length, 1);
  assert.equal((await chain.armies(owner.toBase58())).length, 1);
});

test('live battles override stale index rows in lists and detail reads', async () => {
  const owner = new PublicKey(new Uint8Array(32).fill(8));
  const data = Buffer.alloc(2155);
  owner.toBuffer().copy(data, 104);
  data[2108] = 2;
  const indexed = { pubkey: owner.toBase58(), playerA: owner.toBase58(), status: 0 };
  const er = {
    getProgramAccounts: async () => [{ pubkey: owner, account: { data } }],
    getAccountInfo: async () => ({ data }),
  };
  const chain = createSolanaChain({ owner }, { er, read: async (path) => path.includes('?') ? [indexed] : indexed, base: {}, rent: async () => 0 });
  assert.equal((await chain.matches(owner.toBase58()))[0].status, 2);
  assert.equal((await chain.match(owner.toBase58())).status, 2);
});
