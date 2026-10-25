import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

export const ownerA = process.env.TASKMASTER_NATIVE_SUPABASE
  ? randomUUID()
  : '10000000-0000-4000-8000-000000000001';
export const ownerB = process.env.TASKMASTER_NATIVE_SUPABASE
  ? randomUUID()
  : '10000000-0000-4000-8000-000000000002';
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected object');
  return Object.fromEntries(Object.entries(value));
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value;
}
export function quote(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
export function sql(url: string, source: string) {
  const result = spawnSync(
    'psql',
    ['--no-psqlrc', url, '-v', 'ON_ERROR_STOP=1', '-qAt'],
    {
      input: source,
      encoding: 'utf8',
      env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || 'psql unavailable');
  return result.stdout.trim();
}
export function sqlAsync(url: string, source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'psql',
      ['--no-psqlrc', url, '-v', 'ON_ERROR_STOP=1', '-qAt'],
      { env: { ...process.env, PGCONNECT_TIMEOUT: '5' } },
    );
    let output = '';
    let errors = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      errors += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error(errors)),
    );
    child.stdin.end(source);
  });
}
export class DatabaseHarness {
  private process: ChildProcess | undefined;
  private directory = '';
  private database = '';
  private secret = randomBytes(48).toString('base64url');
  private admin = '';
  url = '';
  api = '';
  headers: Record<string, string> = {};
  emptyToken() {
    return this.token(randomUUID());
  }
  async start() {
    const raw = process.env.TASKMASTER_TEST_ADMIN_URL;
    const binary = process.env.TASKMASTER_POSTGREST_BIN;
    if (!raw || !binary)
      throw new Error(
        'Real DB tests require TASKMASTER_TEST_ADMIN_URL (loopback PostgreSQL admin) and TASKMASTER_POSTGREST_BIN. See docs/SUPABASE.md; no mock fallback.',
      );
    const admin = new URL(raw);
    if (!['postgresql:', 'postgres:'].includes(admin.protocol))
      throw new Error('PostgreSQL URL required');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(admin.hostname))
      throw new Error('Refusing non-loopback database tests');
    this.admin = admin.toString();
    this.database = `taskmaster_test_${randomUUID().replaceAll('-', '')}`;
    sql(this.admin, `create database ${this.database};`);
    admin.pathname = `/${this.database}`;
    this.url = admin.toString();
    const bootstrap = await readFile('tests/database/bootstrap.sql', 'utf8');
    sql(this.url, bootstrap);
    for (const file of (await readdir('supabase/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort())
      sql(
        this.url,
        `begin;${await readFile(`supabase/migrations/${file}`, 'utf8')};commit;`,
      );
    sql(
      this.url,
      `insert into auth.users(id) values (${quote(ownerA)}),(${quote(ownerB)});`,
    );
    this.directory = await mkdtemp(join(tmpdir(), 'taskmaster-db-'));
    const config = join(this.directory, 'postgrest.conf');
    const port = process.env.TASKMASTER_TEST_API_PORT
      ? Number(process.env.TASKMASTER_TEST_API_PORT)
      : await new Promise<number>((resolve, reject) => {
          const server = createServer();
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
              server.close();
              reject(new Error('No test port'));
              return;
            }
            const free = address.port;
            server.close((error) => (error ? reject(error) : resolve(free)));
          });
        });
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error('Invalid test API port');
    const apiDatabase = new URL(this.url);
    apiDatabase.username = 'authenticator';
    apiDatabase.password = '';
    // Test-only synthetic key, never logged or committed. Real PostgREST verifies signatures.
    await writeFile(
      config,
      `db-uri = ${JSON.stringify(apiDatabase.toString())}\ndb-schemas = "public"\ndb-anon-role = "anon"\ndb-max-rows = 500\nserver-host = "127.0.0.1"\nserver-port = ${port}\njwt-secret = ${JSON.stringify(this.secret)}\n`,
      { mode: 0o600 },
    );
    this.api = `http://127.0.0.1:${port}`;
    let error = '';
    this.process = spawn(binary, [config], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.process.stderr?.on('data', (data: Buffer) => {
      error += data.toString();
    });
    let launchError: Error | undefined;
    this.process.on('error', (failure) => {
      launchError = failure;
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw launchError;
      try {
        const response = await fetch(this.api);
        if (response.ok) return;
      } catch {
        /* readiness only */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`PostgREST did not start: ${error}`);
  }
  async stop() {
    if (this.process && this.process.exitCode === null) {
      const child = this.process;
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      });
    }
    if (this.database && this.admin)
      sql(this.admin, `drop database if exists ${this.database} with (force);`);
    if (this.directory)
      await rm(this.directory, { recursive: true, force: true });
  }
  token(owner = ownerA, aal = 'aal2', secret = this.secret) {
    // Fixture tokens only. Product authentication remains Supabase Auth's responsibility.
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        role: 'authenticated',
        sub: owner,
        aal,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    const signature = createHmac('sha256', secret)
      .update(`${header}.${body}`)
      .digest('base64url');
    return `${header}.${body}.${signature}`;
  }
  async request(
    path: string,
    body?: unknown,
    token: string | null = this.token(),
  ) {
    const headers: Record<string, string> = { ...this.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${this.api}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json();
    return { http: response.status, value };
  }
  async apply(command: Record<string, unknown>, owner = ownerA) {
    return object(
      (await this.request('rpc/apply_command', { command }, this.token(owner)))
        .value,
    );
  }
  async rows(table: string, owner = ownerA) {
    return array(
      (await this.request(`${table}?order=id`, undefined, this.token(owner)))
        .value,
    ).map(object);
  }
  async refs(owner = ownerA) {
    const refs: {
      kind: string;
      id: unknown;
      revision: unknown;
      lastOperationId: unknown;
    }[] = [];
    for (const [table, kind] of [
      ['tasks', 'task'],
      ['categories', 'category'],
      ['groups', 'group'],
      ['recurrence_series', 'series'],
    ]) {
      for (const row of await this.rows(table ?? '', owner))
        refs.push({
          kind: kind ?? '',
          id: row.id,
          revision: row.revision,
          lastOperationId: row.last_operation_id,
        });
    }
    return refs;
  }
  async command(
    payload: Record<string, unknown>,
    taskId: string | null,
    result: Record<string, unknown> = {},
    owner = ownerA,
  ) {
    const reads = await this.refs(owner);
    return {
      id: randomUUID(),
      protocolVersion: 2,
      ownerId: owner,
      deviceId: randomUUID(),
      taskId,
      createdAt: new Date().toISOString(),
      sequence: 1,
      dependsOn: null,
      expectedRevision: null,
      base: null,
      result,
      payload,
      status: 'pending',
      reads,
      changes: [],
      dependencies: [...new Set(reads.map((read) => read.lastOperationId))],
    };
  }
  asOwner(owner: string, statement: string, role = 'authenticated') {
    return `begin; set local role ${role}; select set_config('request.jwt.claims',${quote(JSON.stringify({ sub: owner, role, aal: 'aal2' }))},true); ${statement}; commit;`;
  }
}
