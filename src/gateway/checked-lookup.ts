/**
 * DNS lookup for outbound requests that must obey the target-address policy (webhook-core.ts
 * `checkTarget`): the host is resolved once and every resolved address is checked inside the
 * connection's own lookup, so the address that is checked is the address that is connected to
 * (no second resolution an attacker could rebind). Shared by webhooks and image fetching.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { checkTarget, type TargetPolicy } from './webhook-core.js';

export function checkedLookup(policy: TargetPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, '', 0);
      try {
        for (const a of addresses) checkTarget(a.address, policy);
      } catch (denied) {
        return callback(denied as NodeJS.ErrnoException, '', 0);
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}
