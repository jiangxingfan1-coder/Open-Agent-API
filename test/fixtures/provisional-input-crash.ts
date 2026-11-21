import { open, readFile, type FileHandle } from 'node:fs/promises';
import { Fault } from '../../src/core/util.js';
import { gatewaySchema } from '../../src/config/config.js';
import { WorkerRuntime } from '../../src/fabric/worker.js';
import { createGateway } from '../../src/gateway/server.js';
import { FixtureModel, token } from '../helpers.js';

const config = gatewaySchema.parse(JSON.parse(await readFile(process.argv[2]!, 'utf8')));
const explicit = process.argv[3]?.startsWith('explicit-');
const mode = process.argv[3]?.replace(/^explicit-/, '');
const driver = Object.assign(new FixtureModel(), { imageInput: 'url' as const });
const g = await createGateway(
  config,
  new WorkerRuntime(config.localWorker!, new Map(), new Map([['fixture', driver]])),
);
await g.app.ready();
if (mode === 'before-run') g.store.createRun = () => process.exit(79);
if (mode === 'before-cache') g.store.provisionalInputs.adopt = () => process.exit(79);
if (mode === 'partial') {
  const fh = await open(process.argv[2]!, 'r'),
    proto = Object.getPrototypeOf(fh) as FileHandle;
  const original = proto.writeFile;
  await fh.close();
  proto.writeFile = async function (
    this: FileHandle,
    ...args: Parameters<FileHandle['writeFile']>
  ) {
    if (Buffer.isBuffer(args[0]) && args[0][0] === 0x89) {
      await this.write(args[0], 0, 5, 0);
      process.exit(79);
    }
    return original.apply(this, args);
  };
}
if (mode === 'before-metadata') {
  g.store.db.function('fixture_exit', () => process.exit(79));
  g.store.db.exec(
    'CREATE TEMP TRIGGER stop_before_metadata BEFORE INSERT ON files BEGIN SELECT fixture_exit(); END;',
  );
}
if (mode === 'before-unlink' || mode === 'before-ack' || mode === 'file-commit') {
  g.store.createRun = () => {
    throw new Fault('invalid_request', 'fixture declined the request', 400);
  };
  const db = g.store.db;
  if (mode !== 'before-ack') {
    let arm = false;
    db.function('fixture_mark', () => {
      arm = true;
      return 1;
    });
    db.exec(
      mode === 'file-commit'
        ? 'CREATE TEMP TRIGGER stop_at_publication AFTER INSERT ON files BEGIN SELECT fixture_mark(); END;'
        : "CREATE TEMP TRIGGER stop_at_tombstone AFTER UPDATE OF phase ON oaa_inline_inputs WHEN NEW.phase='unlink' BEGIN SELECT fixture_mark(); END;",
    );
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => {
      exec(sql);
      if (arm && sql === 'COMMIT') process.exit(79);
    };
  } else {
    db.function('fixture_exit', () => process.exit(79));
    db.exec(
      "CREATE TEMP TRIGGER stop_before_ack BEFORE DELETE ON oaa_inline_inputs WHEN OLD.phase='unlink' BEGIN SELECT fixture_exit(); END;",
    );
  }
}
if (mode === 'after-run')
  g.store.events.prependListener('summary', (e: { status: string }) => {
    if (e.status === 'queued') process.exit(79);
  });
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const response = await g.app.inject({
  method: 'POST',
  url: explicit ? '/v1/files' : '/v1/chat/completions',
  headers: { authorization: 'Bearer ' + token },
  payload: explicit
    ? { filename: 'image-1.png', content: png, encoding: 'base64', allowed_nodes: ['local'] }
    : {
        model: 'agent/test',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }],
          },
        ],
      },
});
throw new Error('Did not exit at the expected checkpoint: ' + response.statusCode);
