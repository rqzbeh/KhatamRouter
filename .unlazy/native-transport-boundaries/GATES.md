# Gates: Native Transport Boundaries & Process Lifecycles

OWNS: open-sse/services/opencodeTlsClient.js, open-sse/utils/proxyFetch.js, open-sse/executors/opencode.js, src/lib/network/psiphon/psiphonManager.js, tests/integration/proxy-transport-reliability.mjs, tests/integration/tunnel-lifecycle-reliability.mjs, tests/integration/fixtures/proxy-reliability/**, tests/unit/psiphon-rotation.test.js, tests/unit/psiphon-manager.test.js, .unlazy/native-transport-boundaries/**

Scope:
Enforce genuine native TLS boundaries and clean OS process lifecycles without mock-detection hacks or insecure compromises:
1. Remove `_isMockFunction` and `forceNativeAdapter` from `proxyFetch.js`. Never dispatch production code based on test mocks.
2. Remove `insecure: true` from production OpenCode adapter and executor. Enforce certificate validation against an ephemeral trusted CA via real native `SSL_CERT_FILE` support, proving untrusted certs fail and trusted certs succeed through proxy.
3. Fix Psiphon lifecycle handlers: SIGTERM/SIGINT asynchronously await teardown and child termination before directory deletion without interfering with custom-server cluster drain; process exit hook performs synchronous final kill without premature directory rmSync.
4. Eliminate `sessionsMap` pending creation eviction race and ensure stream completion ref counting decrements in-flight counters across all body consumption paths. Ensure error logs do not leak proxy credentials.

- [x] G1: Native wreq-js TLS verification and proxy transport reliability
  CHECK: bun tests/integration/proxy-transport-reliability.mjs
  EXPECT: PROXY_TRANSPORT_RELIABILITY_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=654942554948c007b48aff60dbc10f910517ddfd901c527a662f8b43962b3faa; exit=0; EXPECT=matched; output-sha256=4607ae9613c432ca142a00437a1d6310f147573d2cf484ca510c8635dc47e923; output-bytes=1730; shell=/bin/sh; cwd=/tmp/khatam-native-boundaries; path=f2c4e9ff709f/32 entries

- [x] G2: OS parent+child process lifecycle, SIGTERM/SIGINT teardown, and directory cleanup
  CHECK: bun tests/integration/tunnel-lifecycle-reliability.mjs
  EXPECT: TUNNEL_LIFECYCLE_RELIABILITY_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=e19cfbea34a499f97a4fd9c370e4957845d7a8efb3cb60152b4b703ef3210615; exit=0; EXPECT=matched; output-sha256=2e4cd2356046ee98c6b9e587085d8fff440623f4bb655bb0eeeb562638681d2a; output-bytes=1723; shell=/bin/sh; cwd=/tmp/khatam-native-boundaries; path=f2c4e9ff709f/32 entries

- [x] G3: Elimination of _isMockFunction/forceNativeAdapter and psiphon-rotation test suite
  CHECK: cd tests && env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy bun x --bun vitest run unit/psiphon-rotation.test.js && printf 'NATIVE_ROTATION_REGRESSION_PASS\n'
  EXPECT: NATIVE_ROTATION_REGRESSION_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=79dacab525c600cca9192523390d7aac2d44e6d719dc82d8f7dd02fac4d9df3e; exit=0; EXPECT=matched; output-sha256=a93f978817f518ace4a42b621be00d3a2571e4aa99b2d3e7bfddd1afc0b86276; output-bytes=17815; shell=/bin/sh; cwd=/tmp/khatam-native-boundaries; path=f2c4e9ff709f/32 entries

- [x] G4: Psiphon manager unit test suite and lifecycle contracts
  CHECK: cd tests && env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy bun x --bun vitest run unit/psiphon-manager.test.js && printf 'NATIVE_MANAGER_REGRESSION_PASS\n'
  EXPECT: NATIVE_MANAGER_REGRESSION_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=33dd4a4da74e231e61a23b0e8abfcc3353171396c8650bd8d9975e62adb40420; exit=0; EXPECT=matched; output-sha256=0685d36fba69c069f9b60f5c692c5a01ec1ddb346f71b72b599c7694a2829245; output-bytes=216; shell=/bin/sh; cwd=/tmp/khatam-native-boundaries; path=f2c4e9ff709f/32 entries

- [x] G5: Concurrency test verifying sessionMap pending creation race & stream ref counting
  CHECK: bun tests/integration/proxy-transport-reliability.mjs
  EXPECT: PROXY_TRANSPORT_RELIABILITY_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=654942554948c007b48aff60dbc10f910517ddfd901c527a662f8b43962b3faa; exit=0; EXPECT=matched; output-sha256=4607ae9613c432ca142a00437a1d6310f147573d2cf484ca510c8635dc47e923; output-bytes=1730; shell=/bin/sh; cwd=/tmp/khatam-native-boundaries; path=f2c4e9ff709f/32 entries
