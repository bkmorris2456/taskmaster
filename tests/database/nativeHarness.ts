// Certification only: native GoTrue credentials, Kong gateway and managed SQL.
// Never loads bootstrap.sql, fabricates successful JWTs, resets or drops a database.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import { DatabaseHarness, object, ownerA, ownerB, sql, quote } from './harness';

function textField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) throw new Error(`Missing ${key}`);
  return field;
}
function assurance(token: string) {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Missing native JWT payload');
  const decoded: unknown = JSON.parse(
    Buffer.from(payload, 'base64url').toString(),
  );
  return object(decoded).aal;
}
export class NativeDatabaseHarness extends DatabaseHarness {
  private gateway = '';
  private adminKey = '';
  private sessions = new Map<string, string>();
  private users: string[] = [];
  private emptyOwner = randomUUID();
  readonly authEvidence: {
    passwordAAL: 'aal1';
    totpAAL: 'aal2';
    verifiedFactor: boolean;
    invalidCodeRejected: boolean;
  }[] = [];
  override async start() {
    if (process.env.TASKMASTER_NATIVE_CONFIRM_DISPOSABLE !== 'taskmaster')
      throw new Error(
        'Native certification requires TASKMASTER_NATIVE_CONFIRM_DISPOSABLE=taskmaster; verify the local stack first.',
      );
    const status = spawnSync(
      'node_modules/.bin/supabase',
      ['status', '--output', 'json'],
      { encoding: 'utf8' },
    );
    if (status.status !== 0)
      throw new Error('Local Supabase status failed; credentials withheld.');
    const parsed: unknown = JSON.parse(status.stdout);
    const config = object(parsed);
    this.gateway = textField(config, 'API_URL');
    this.url = textField(config, 'DB_URL');
    const apiUrl = new URL(this.gateway);
    const databaseUrl = new URL(this.url);
    if (
      !['127.0.0.1', 'localhost'].includes(apiUrl.hostname) ||
      !['127.0.0.1', 'localhost'].includes(databaseUrl.hostname) ||
      apiUrl.port !== '54321' ||
      databaseUrl.port !== '54322'
    )
      throw new Error('Refusing non-Taskmaster loopback target');
    this.adminKey = textField(config, 'SERVICE_ROLE_KEY');
    this.headers = { apikey: textField(config, 'ANON_KEY') };
    this.api = `${this.gateway}/rest/v1`;
    if (
      sql(
        this.url,
        "select current_setting('server_version_num')::integer / 10000",
      ) !== '17'
    )
      throw new Error('Native certification expects configured PostgreSQL 17');
    for (const id of [ownerA, ownerB, this.emptyOwner])
      await this.createIdentity(id);
  }
  private async auth(path: string, body: unknown, token: string) {
    const response = await fetch(`${this.gateway}/auth/v1/${path}`, {
      method: 'POST',
      headers: {
        ...this.headers,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    // Error messages intentionally exclude response bodies containing session/seed data.
    if (!response.ok)
      throw new Error(
        `Native Auth ${path.split('?')[0]} failed (${response.status}); response withheld`,
      );
    const result: unknown = await response.json();
    return object(result);
  }
  private async createIdentity(id: string) {
    const email = `taskmaster-cert-${id}@example.invalid`;
    const password = randomBytes(32).toString('base64url');
    const user = await this.auth(
      'admin/users',
      { id, email, password, email_confirm: true },
      this.adminKey,
    );
    if (user.id !== id) throw new Error('Native synthetic identity mismatch');
    this.users.push(id);
    const login = await this.auth(
      'token?grant_type=password',
      { email, password },
      this.headers.apikey ?? '',
    );
    const aal1 = textField(login, 'access_token');
    if (assurance(aal1) !== 'aal1')
      throw new Error('Password login did not issue AAL1');
    this.sessions.set(`${id}:aal1`, aal1);
    const enrolled = await this.auth(
      'factors',
      { factor_type: 'totp', friendly_name: 'Phase 6 certification' },
      aal1,
    );
    const factor = textField(enrolled, 'id');
    const seed = textField(object(enrolled.totp), 'secret');
    const challenge = await this.auth(`factors/${factor}/challenge`, {}, aal1);
    const authenticator = new TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(seed),
    });
    const incorrect =
      authenticator.generate() === '000000' ? '111111' : '000000';
    const rejected = await fetch(
      `${this.gateway}/auth/v1/factors/${factor}/verify`,
      {
        method: 'POST',
        headers: {
          ...this.headers,
          Authorization: `Bearer ${aal1}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          challenge_id: textField(challenge, 'id'),
          code: incorrect,
        }),
      },
    );
    await rejected.arrayBuffer();
    const invalidCodeRejected = [400, 422].includes(rejected.status);
    if (!invalidCodeRejected)
      throw new Error('Native Auth did not reject an incorrect TOTP');
    const freshChallenge = await this.auth(
      `factors/${factor}/challenge`,
      {},
      aal1,
    );
    const verified = await this.auth(
      `factors/${factor}/verify`,
      {
        challenge_id: textField(freshChallenge, 'id'),
        code: authenticator.generate(),
      },
      aal1,
    );
    const aal2 = textField(verified, 'access_token');
    if (assurance(aal2) !== 'aal2')
      throw new Error('Native TOTP did not issue AAL2');
    this.sessions.set(`${id}:aal2`, aal2);
    const response = await fetch(`${this.gateway}/auth/v1/user`, {
      headers: { ...this.headers, Authorization: `Bearer ${aal2}` },
    });
    if (!response.ok) throw new Error('Native user verification failed');
    const profile: unknown = await response.json();
    if (object(profile).id !== id)
      throw new Error('Native verified profile mismatch');
    const factors = object(profile).factors;
    const verifiedFactor =
      Array.isArray(factors) &&
      factors.some(
        (value: unknown) =>
          object(value).id === factor && object(value).status === 'verified',
      );
    this.authEvidence.push({
      passwordAAL: 'aal1',
      totpAAL: 'aal2',
      verifiedFactor,
      invalidCodeRejected,
    });
  }
  override token(owner = ownerA, aal = 'aal2', invalidSecret?: string) {
    if (invalidSecret !== undefined)
      return super.token(owner, aal, invalidSecret);
    const token = this.sessions.get(`${owner}:${aal}`);
    if (!token) throw new Error('Requested native session is unavailable');
    return token;
  }
  override emptyToken() {
    return this.token(this.emptyOwner);
  }
  override async stop() {
    // Only delete identities created by this run; preserve every preexisting user.
    for (const id of this.users) {
      const response = await fetch(
        `${this.gateway}/auth/v1/admin/users/${id}`,
        {
          method: 'DELETE',
          headers: {
            ...this.headers,
            Authorization: `Bearer ${this.adminKey}`,
          },
        },
      );
      if (!response.ok)
        throw new Error(
          `Native synthetic user cleanup failed (${response.status})`,
        );
      if (
        sql(
          this.url,
          `select count(*) from auth.users where id=${quote(id)}`,
        ) !== '0'
      )
        throw new Error('Native cleanup did not remove synthetic identity');
    }
    this.sessions.clear();
    this.adminKey = '';
  }
}
