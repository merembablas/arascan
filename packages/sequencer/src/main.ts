// Copyright 2021 Rantai Nusantara Foundation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { WsProvider } from '@polkadot/api';
import { Nuchain } from '@arascan/components';
//import type { Hash } from '@polkadot/types/interfaces';
import { MongoClient } from 'mongodb';
import { Context, getLastStartingBlock, processBlock } from '@arascan/components';

require('dotenv').config();

class Counter {
  proceed: number;
  skipped: number;
  constructor(proceed: number) {
    this.proceed = proceed;
    this.skipped = 0;
  }

  incProceed() {
    this.proceed++;
    return this;
  }

  incSkipped() {
    this.skipped++;
    return this;
  }
}

const MAX_SKIP_BLOCKS = 50;
const noSkipLimit = process.argv.indexOf('--no-skip-limit') > -1;
const seqAll = process.argv.indexOf('--all') > -1;
const seqContinue = process.argv.indexOf('--continue') > -1;

async function startSequencing(
  ctx: Context,
  blockHash: any,
  untilBlockNum: number,
  counter: Counter,
  done: () => void,
  onError: () => void
) {
  const { api } = ctx;

  const block = await api.rpc.chain.getBlock(blockHash);
  if (!block) {
    console.log('Cannot get block with hash ', blockHash);
    return;
  }
  const {
    block: {
      header: { parentHash, number, hash },
    },
  } = block;
  const blockNumber = number.toNumber();

  try {
    await processBlock(ctx, hash, true, (skipped) => {
        if (skipped) {
          counter.incSkipped();
        } else {
          counter.incProceed();
    
          // save latest processed block, to resume when something went wrong during sequencing.
          ctx.db
            .collection('processed')
            .updateOne({ _id: 'last_block' }, { $set: { value: block.toJSON() } }, { upsert: true });
        }
        if (
          (blockNumber > 2 && blockNumber > untilBlockNum && counter.skipped < MAX_SKIP_BLOCKS) ||
          noSkipLimit ||
          seqAll
        ) {
          setTimeout(async () => await startSequencing(ctx, parentHash, untilBlockNum, counter, done, onError), 10);
        } else {
          if (counter.skipped >= MAX_SKIP_BLOCKS) {
            console.log(`Sequencing stopped by max skip blocks ${MAX_SKIP_BLOCKS}, total ${counter.proceed} proceed.`);
          } else {
            console.log(`Sequencing finished, ${counter.proceed} proceed, ${counter.skipped} skipped.`);
          }
          done();
        }
      });
  }catch (error) {
      console.log("[ERROR]", error)
      onError()
  }
}

function ensureIndex(db: any) {
  const colBlocks = db.collection('blocks');
  colBlocks.createIndex({ block_num: -1 }, { unique: true });
  colBlocks.createIndex({ block_hash: -1 }, { unique: true });
}

async function main() {
  console.log('STARTING SEQUENCER...');

  const dbUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const dbName = process.env.MONGODB_DB_NAME;

  if (!dbName) {
    console.log('[ERROR] no MONGODB_DB_NAME env var');
    return;
  }

  const WS_SOCKET_URL = process.env.NUCHAIN_WS_SOCKET_URL || 'ws://127.0.0.1:9944';

  console.log(`Using WS address: ${WS_SOCKET_URL}`);

  const api = await Nuchain.connectApi({ provider: new WsProvider(WS_SOCKET_URL) });

  console.log(`${process.argv}`);

  let startingBlockNumber = process.argv.find((a) => a.startsWith('--starting-block='));

  let startingBlockHash = await api.rpc.chain.getBlockHash();
  let startingBlock: any = null;

  if (startingBlockNumber) {
    startingBlockNumber = startingBlockNumber.split('=')[1];
    startingBlockHash = await api.rpc.chain.getBlockHash(startingBlockNumber);
    console.log(`Using user specified starting block [${startingBlockNumber}] ${startingBlockHash}`);
  }
  if (!seqContinue) {
    console.log(`Using latest block ${startingBlockHash}`);
    startingBlock = await api.rpc.chain.getHeader(startingBlockHash);
  }

  MongoClient.connect(dbUri, async (err, client: MongoClient) => {
    if (err) {
      console.log(`Cannot connect to Mongodb. ${err}`);
      return;
    }

    if (err == null) {
      const db = client.db(dbName);
      ensureIndex(db);

      if (seqContinue) {
        // continue sequencing from latest processed block
        startingBlock = (await db.collection('processed').findOne({ _id: 'last_block' }))?.value;
      }

      if (startingBlock == null) {
        console.log('Unknown starting block', startingBlock);
        return;
      }

      console.log(`Start sequencing from block #${startingBlock.number}...`);

      let untilBlock = 0;
      if (!seqAll && !seqContinue) {
        const lastProcBlock = (await getLastStartingBlock(db))?.value;
        if (lastProcBlock != null) {
          console.log(
            `starting block [${startingBlock.number}] until block: [${lastProcBlock.number}] ${lastProcBlock.hash}`
          );
          untilBlock = lastProcBlock.number;
        }
      }

      const ctx = new Context(api, db, client);

      const counter = new Counter(0);

      await startSequencing(ctx, startingBlock.hash, untilBlock, counter, () => {
        console.log('Setting last processed block');

        const data = startingBlock.toJSON();
        data['hash'] = startingBlockHash.toHex() as any;

        db.collection('processed').updateOne(
          { _id: 'last_starting_block' },
          { $set: { value: data } },
          { upsert: true }
        );

        console.log('Done.');

        client.close();
        process.exit(0);
      }, ()=> {
          
      });

      process.on('SIGINT', (_code) => {
        console.log('quiting...');
        client.close();
        process.exit(0);
      });
    }
  });
}

main().catch(console.error);
