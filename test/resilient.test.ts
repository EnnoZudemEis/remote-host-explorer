import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResilientClient } from '../src/connection/resilient';
import { expandEnv, expandServer } from '../src/config/envExpand';
import { RemoteClient, RemoteEntry, ServerConfig } from '../src/connection/types';

/** Fake client: operations listed in `failFirst` fail once with a connection error. */
function fakeClient(log: string[], failing: Set<string>): RemoteClient {
  const id = log.filter((l) => l.startsWith('build')).length;
  const run = async (name: string) => {
    log.push(`${name}#${id}`);
    if (failing.has(name)) { failing.delete(name); throw new Error('read ECONNRESET'); }
  };
  return {
    connect: async () => { log.push(`connect#${id}`); },
    list: async () => { await run('list'); return [] as RemoteEntry[]; },
    readFile: async () => { await run('read'); return Buffer.from(''); },
    writeFile: async () => run('write'),
    mkdir: async () => run('mkdir'),
    rename: async () => run('rename'),
    remove: async () => run('remove'),
    close: async () => { log.push(`close#${id}`); },
  };
}

function make(failing: string[]) {
  const log: string[] = [];
  const fail = new Set(failing);
  const client = new ResilientClient(() => { log.push('build'); return fakeClient(log, fail); }, 0);
  return { log, client };
}

test('repeatable operations are retried once on a new connection', async () => {
  const { log, client } = make(['write']);
  await client.connect();
  await client.writeFile('/x', Buffer.from('a'));
  assert.deepEqual(log.filter((l) => l.startsWith('write')), ['write#1', 'write#2']);
});

test('remove and rename are not repeated after a dropped connection, but the next call works', async () => {
  const { log, client } = make(['remove']);
  await client.connect();
  await assert.rejects(() => client.remove('/x', false), /nicht wiederholt/);
  assert.equal(log.filter((l) => l.startsWith('remove')).length, 1);
  await client.list('/'); // connection was rebuilt
  assert.ok(log.includes('list#2'));
});

test('errors that are not connection errors are not retried', async () => {
  const log: string[] = [];
  const bad: RemoteClient = { ...fakeClient(log, new Set()), list: async () => { log.push('list'); throw new Error('Permission denied'); } };
  const client = new ResilientClient(() => bad, 0);
  await assert.rejects(() => client.list('/'), /Permission denied/);
  assert.equal(log.filter((l) => l === 'list').length, 1);
});

test('operations run one at a time', async () => {
  const order: string[] = [];
  const slow: RemoteClient = {
    ...fakeClient([], new Set()),
    list: async (p) => { order.push(`start ${p}`); await new Promise((r) => setTimeout(r, 10)); order.push(`end ${p}`); return []; },
  };
  const client = new ResilientClient(() => slow, 0);
  await Promise.all([client.list('a'), client.list('b')]);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b']);
});

test('expandEnv resolves known variables and reports unknown ones', () => {
  const r = expandEnv('/var/${env:SITE}/${env:NOPE}', { SITE: 'www' });
  assert.equal(r.value, '/var/www/${env:NOPE}');
  assert.deepEqual(r.missing, ['NOPE']);
});

test('expandServer only touches host, username, paths and key path', () => {
  const s: ServerConfig = {
    name: '${env:KEEP}', protocol: 'sftp', host: '${env:H}', username: '${env:U}',
    localPath: '.', remotePath: '/srv/${env:H}', privateKeyPath: '~/.ssh/${env:K}',
  };
  const { server, missing } = expandServer(s, { H: 'example.com', U: 'deploy', K: 'id_ed25519' });
  assert.equal(server.host, 'example.com');
  assert.equal(server.username, 'deploy');
  assert.equal(server.remotePath, '/srv/example.com');
  assert.equal(server.privateKeyPath, '~/.ssh/id_ed25519');
  assert.equal(server.name, '${env:KEEP}'); // name is an identifier, never expanded
  assert.deepEqual(missing, []);
});
