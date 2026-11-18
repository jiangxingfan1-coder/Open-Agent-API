/**
 * Optional verification webhook hook for the developer portal (`platform.verificationWebhookUrl`).
 *
 * When configured:
 * - `POST /v1/portal/signup` never answers `409 email_taken`; both new and already-registered
 *   emails receive the identical `202` verification prompt while signed HTTPS POST events
 *   (`portal.signup_verification` / `portal.signup_existing_email`) are dispatched asynchronously.
 * - `POST /v1/portal/signup/verify` completes registration with the one-time code.
 * - `POST /v1/portal/password-reset/request` dispatches `portal.password_reset_code` uniformly.
 */
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Fault, id, safeEqual, sha } from '../core/util.js';
import { checkedLookup } from './checked-lookup.js';
import { prepared } from './platform-db.js';
import { checkWebhookUrl, signature, type TargetPolicy } from './webhook-core.js';

export const SIGNUP_CODE_TTL_MS = 15 * 60_000;
export const VERIFICATION_MESSAGE = 'Please check your email for a verification code to continue.';

export type VerificationEventType =
  'portal.signup_verification' | 'portal.signup_existing_email' | 'portal.password_reset_code';

export type VerificationDelivery = {
  url: string;
  event: VerificationEventType;
  deliveryId: string;
  signature: string;
  body: string;
  policy: TargetPolicy;
};

type PendingPayload = {
  passwordHash: string;
  name: string;
  inviteCode?: string;
};

function defaultDeliver(d: VerificationDelivery): Promise<void> {
  const target = new URL(d.url);
  const client = target.protocol === 'https:' ? https : http;
  const payload = Buffer.from(d.body, 'utf8');
  return new Promise<void>((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: 'POST',
        timeout: 10_000,
        lookup: checkedLookup(d.policy),
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': payload.length,
          'user-agent': 'Open-Agent-API-Verification/1.0',
          'x-oaa-event': d.event,
          'x-oaa-delivery': d.deliveryId,
          'x-oaa-signature': d.signature,
        },
      },
      (res) => {
        res.resume();
        res.once('end', () => {
          if ((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300) resolve();
          else reject(new Error(`Verification webhook HTTP ${res.statusCode ?? 0}`));
        });
      },
    );
    req.once('timeout', () => req.destroy(new Error('Verification webhook timed out')));
    req.once('error', reject);
    req.end(payload);
  });
}

/** Swappable in tests so offline tests can inspect signed payloads without binding a TCP port. */
export const platformVerificationTransport = {
  deliver: defaultDeliver,
};

export class PlatformVerification {
  readonly url: string;
  readonly signingSecret: string;
  private readonly policy: TargetPolicy;
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: string,
    webhookUrl: string,
    configuredSecret: string | undefined,
    securityProfile: 'local' | 'public' = 'local',
  ) {
    this.policy = {
      profile: securityProfile,
      allowInsecureHttp: false,
      allowPrivateNetwork: securityProfile === 'local',
    };
    this.url = checkWebhookUrl(webhookUrl, this.policy).toString();
    this.signingSecret = configuredSecret ?? this.loadOrCreateSecret();
  }

  private loadOrCreateSecret(): string {
    const row = prepared(
      this.db,
      'SELECT secret FROM platform_verification_secrets WHERE owner=?',
    ).get(this.owner);
    if (row && typeof row.secret === 'string') return row.secret;
    const generated = `whsec_${randomBytes(24).toString('base64url')}`;
    prepared(
      this.db,
      'INSERT INTO platform_verification_secrets(owner,secret,created_at) VALUES(?,?,?)',
    ).run(this.owner, generated, Date.now());
    return generated;
  }

  private dispatch(
    event: VerificationEventType,
    data: Record<string, unknown>,
    now = Date.now(),
  ): void {
    const deliveryId = id('ver');
    const unix = Math.floor(now / 1000);
    const body = JSON.stringify({
      id: deliveryId,
      type: event,
      created_at: unix,
      data,
    });
    const sig = signature(this.signingSecret, unix, body);
    const task = platformVerificationTransport
      .deliver({
        url: this.url,
        event,
        deliveryId,
        signature: sig,
        body,
        policy: this.policy,
      })
      .catch(() => {
        // Outbound failure must never leak account existence or crash the gateway.
      })
      .finally(() => {
        this.inflight.delete(task);
      });
    this.inflight.add(task);
  }

  stageSignup(
    email: string,
    payload: PendingPayload,
    now = Date.now(),
  ): { verificationRequired: true; message: string } {
    prepared(this.db, 'DELETE FROM platform_pending_signups WHERE expires_at<=?').run(now);
    const code = randomBytes(15).toString('base64url');
    const expiresAt = now + SIGNUP_CODE_TTL_MS;
    prepared(
      this.db,
      'INSERT OR REPLACE INTO platform_pending_signups(owner,email,code_hash,payload,expires_at,created_at) VALUES(?,?,?,?,?,?)',
    ).run(this.owner, email, sha(code), JSON.stringify(payload), expiresAt, now);
    this.dispatch(
      'portal.signup_verification',
      {
        owner: this.owner,
        email,
        name: payload.name,
        code,
        expires_at: expiresAt,
        existing_account: false,
      },
      now,
    );
    return { verificationRequired: true, message: VERIFICATION_MESSAGE };
  }

  notifyExistingSignup(
    email: string,
    accountId: string,
    now = Date.now(),
  ): { verificationRequired: true; message: string } {
    this.dispatch(
      'portal.signup_existing_email',
      {
        owner: this.owner,
        email,
        account_id: accountId,
        existing_account: true,
      },
      now,
    );
    return { verificationRequired: true, message: VERIFICATION_MESSAGE };
  }

  consumeSignup(email: string, code: string, now = Date.now()): PendingPayload {
    const row = prepared(
      this.db,
      'SELECT code_hash,payload,expires_at FROM platform_pending_signups WHERE owner=? AND email=?',
    ).get(this.owner, email);
    const matched = safeEqual(sha(code), row ? String(row.code_hash) : '');
    if (!row || !matched || Number(row.expires_at) <= now)
      throw new Fault('invalid_code', 'The verification code is invalid or has expired.', 400);
    prepared(this.db, 'DELETE FROM platform_pending_signups WHERE owner=? AND email=?').run(
      this.owner,
      email,
    );
    return JSON.parse(String(row.payload)) as PendingPayload;
  }

  notifyPasswordReset(
    email: string,
    accountId: string,
    code: string,
    expiresAt: number,
    now = Date.now(),
  ): { verificationRequired: true; message: string } {
    this.dispatch(
      'portal.password_reset_code',
      {
        owner: this.owner,
        account_id: accountId,
        email,
        code,
        expires_at: expiresAt,
      },
      now,
    );
    return { verificationRequired: true, message: VERIFICATION_MESSAGE };
  }

  uniformPrompt(): { verificationRequired: true; message: string } {
    return { verificationRequired: true, message: VERIFICATION_MESSAGE };
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }
}
