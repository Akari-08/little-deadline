# Vendored TaskPet Link v1 connector

Copied **unchanged** from `TaskPetLink/client/` and `TaskPetLink/PROTOCOL.txt`
(the supplied TaskPet Link package). Do not edit these `.mjs` files to add app
features; wrap them from `src/device/` instead. `test/config.test.ts` ("vendored connector files are identical")
fails if these copies drift from the originals.

| File | Purpose |
| --- | --- |
| `taskpet-link.mjs` | Dependency-free connector: auth, RGB565 encoding, strips, ACKs, timeouts. Does **not** reconnect. |
| `taskpet-link.d.mts` | TypeScript declarations added for this app (types only, no behavior). |
| `PROTOCOL.txt` | Full TaskPet Link v1 wire contract. |
| `taskpet-link.test.mjs` | Connector tests against a simulated WebSocket peer (`npm run test:link`). |
| `loopback-test.mjs` | Real loopback TCP WebSocket test (`npm run test:link`). |
| `smoke-test.mjs` | Physical-device colour-band test; needs real hardware and local env vars. |

Software tests here are not hardware validation.
