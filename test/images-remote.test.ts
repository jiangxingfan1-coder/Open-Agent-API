/**
 * Image input on a remote execution node (docs/images.md): the image travels with the task as an
 * input file and reaches the node's model driver as bytes; a node that does not declare
 * image-input-v1 (an older version) is never chosen, so the request is refused before dispatch.
 * Listens on 127.0.0.1 with an ephemeral port only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workerSchema } from '../src/config/config.js';
import type { ModelImage, NodeAdvertisement } from '../src/core/contracts.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { connectWorker } from '../src/fabric/network.js';
import { makeBundle } from '../src/lang/bundle.js';
import { FixtureModel, setup, agent, waitFor } from './helpers.js';

const nodeToken = 'node-test-credential-not-a-model-key-images-0001';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** A worker as an older release would advertise it: no image-input-v1 declaration. */
class OlderWorker extends WorkerRuntime {
  override advertisement(): NodeAdvertisement {
    const advert = super.advertisement();
    if (advert.execution) delete advert.execution.imageInput;
    return advert;
  }
}

for (const older of [false, true]) {
  test(`images: a remote node ${older ? 'without' : 'with'} image-input-v1 ${older ? 'is not chosen' : 'receives the image bytes'}`, async () => {
    process.env.OAA_NODE_TEST = nodeToken;
    const s = await setup(new FixtureModel(), {
      nodeKeys: [{ nodeId: 'remote', owner: 'owner', tokenEnv: 'OAA_NODE_TEST' }],
    });
    const seen: ModelImage[] = [];
    const vision = Object.assign(
      new FixtureModel((_a, messages) => {
        seen.push(...messages.flatMap((m) => m.images ?? []));
        return { text: `remote saw ${seen.length}` };
      }),
      { imageInput: 'inline' as const },
    );
    const stop = new AbortController();
    let running: Promise<void> | undefined;
    try {
      const address = await s.listen();
      await writeFile(path.join(s.dir, 'node.token'), nodeToken, { mode: 0o600 });
      const cfg = workerSchema.parse({
        nodeId: 'remote',
        dataDir: path.join(s.dir, 'remote'),
        gatewayUrl: address,
        tokenFile: path.join(s.dir, 'node.token'),
      });
      const Runtime = older ? OlderWorker : WorkerRuntime;
      const runtime = new Runtime(cfg, new Map(), new Map([['vision', vision]]));
      running = connectWorker(cfg, stop.signal, runtime);
      await waitFor(() => s.hub.nodes.has('remote'));
      // The advertisement with the negotiated image declaration arrives after the welcome.
      if (!older)
        await waitFor(
          () =>
            !!s.hub
              .inventory('owner')
              .find(
                (n) =>
                  n.nodeId === 'remote' &&
                  (n.execution as { imageInput?: unknown } | undefined)?.imageInput,
              ),
        );
      s.store.publish(
        'owner',
        makeBundle(agent({ id: 'agent/remote', provider: 'vision', model: 'v' })),
      );
      const r = await s.request('POST', '/v1/chat/completions', {
        model: 'agent/remote',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` },
              },
            ],
          },
        ],
      });
      if (older) {
        assert.equal(r.statusCode, 400, r.body);
        assert.equal(r.json().error.code, 'unsupported_content');
        assert.equal(r.json().error.param, 'messages.0.content.1');
        assert.equal(seen.length, 0);
      } else {
        assert.equal(r.statusCode, 200, r.body);
        assert.match(r.json().choices[0].message.content, /remote saw 1/);
        assert.equal(seen[0]!.kind, 'file');
        assert.equal(
          Buffer.from((seen[0] as { data?: string }).data ?? '', 'base64').length,
          PNG.length,
        );
      }
    } finally {
      stop.abort();
      await running;
      await s.cleanup();
    }
  });
}
