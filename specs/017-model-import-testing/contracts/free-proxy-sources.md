# Contract: Free Proxy Providers (opt-in)

**Slice**: S9 · **Requirements**: FR-047..FR-053
**Evidence**: OmniRoute `src/lib/freeProxyProviders/*` and `src/shared/validation/freeProxySchemas.ts` (MIT, reference only); KhatamRouter `src/app/api/proxy-pools/types.js`, `open-sse/utils/proxyFetch.js`, `src/lib/network/proxyTest.js`.

Free proxies are OFF by default and carry explicit privacy/security risk.

## Source inventory (first slice)

| id | Endpoint | Auth | Enabled default | Notes |
|---|---|---|---|---|
| `1proxy` | `https://1proxy-api.aitradepulse.com/api/v1/proxies/advanced` | none | false | quality filter (min ~50), max ~500 |
| `proxifly` | `https://api.proxifly.dev/proxy` | none | false | anonymity filter (default elite) |
| `iplocate` | `https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/<proto>.txt` | none | false | opt-in; cached ~30 min |

Excluded first slice: `webshare` (paid, requires API key → would be a credentialed source).

## Protocol support

- Accept/import: `http`, `https`.
- **SOCKS unsupported**: current egress uses undici `ProxyAgent` (no SOCKS); `socks4/socks5` entries are filtered out / deferred (they would be undialable dead pools).

## API

### GET `/api/settings/free-proxies`
List sources + status.
```json
{ "sources": {
  "1proxy":   { "enabled": false, "lastSync": null, "lastError": null },
  "proxifly": { "enabled": false, "lastSync": null, "lastError": null },
  "iplocate": { "enabled": false, "lastSync": null, "lastError": null }
} }
```

### PUT `/api/settings/free-proxies`
```json
{ "sources": { "1proxy": { "enabled": true } } }
```
- Per-source enable is explicit (FR-048). Disabled → no outbound request to that source (SC-016).

### POST `/api/settings/free-proxies/sync`
- Sync enabled sources into a free pool tagged by provenance (FR-049).
- Validate every imported host through the outbound-URL guard; reject private/loopback/link-local/metadata (FR-050, SC-017).
- Reject `socks*` (unsupported).
- Partial failure keeps existing entries; never empties the pool wholesale.

## Safety & disclosure

- **Privacy/security disclosure** (FR-051): free proxies are third-party, shared, potentially logging or malicious, low-reliability, and unsuitable for sensitive traffic or credentials. Must be shown and acknowledged before enabling.
- **Fail-closed preserved** (FR-052): a connection bound to a strict-proxy/Psiphon pool must NOT fall back to direct egress when a free proxy is unavailable.
- **Credentials** (FR-053): a source needing a key is disabled when unconfigured; never log the key.
- Free pools are distinct from operator-owned pools (`proxyPools.data.source = "free:<id>"`).

## License / attribution

- OmniRoute is MIT (`Copyright (c) 2026 diegosouzapw`). Re-implement against KhatamRouter contracts; retain attribution/notice. Do not copy code files verbatim without MIT notice preservation.
