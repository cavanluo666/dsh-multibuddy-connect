# dsh-multibuddy-connect

Bring the subscription quota of **nine AI coding products** into
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with a
**cross-backend usage dashboard**.

> For the full documentation, see the [Chinese README](./README.md), which is
> the primary one. This file is a summary.

## Author

**cavanluo666**

- Website: <https://246644.xyz>
- Bilibili: <https://space.bilibili.com/3493095616284680>
- GitHub: <https://github.com/cavanluo666>

## Derivative work

This plugin derives from [dsh-workbuddy-connect](https://github.com/masknull/dsh-workbuddy-connect)
by corrinehu, adding eight third-party backend adapters and the usage dashboard.
It is distributed under **GPL-3.0-or-later**; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
for upstream attribution.

## Supported backends

| Backend | Vendor | Credential source | Multi-account | Quota |
|---|---|---|:---:|:---:|
| WorkBuddy / WorkBuddy AI | Tencent | Plugin's own web device authorization | Yes | Yes |
| Trae | ByteDance | Desktop sign-in (4 installs) | Yes (2 regions) | See gaps |
| Qoder | Alibaba | Desktop sign-in / PAT env var | Yes (2 regions) | See gaps |
| CodeBuddy | Tencent | Desktop login file (read-only) | No | No endpoint |
| MiMo | Xiaomi | Desktop cookie / plugin credential | No | Yes |
| Loomy | iFlytek | Desktop `auth-session.json` (read-only) | No | No endpoint |
| Cline | Cline | API key | Yes | Free tier |
| Command Code Go | Command Code | API key | Yes | No endpoint |
| OpenCode Zen | OpenCode | Managed local runtime | No | No endpoint |

## Multi-account, honestly stated

WorkBuddy, Trae, Qoder, Cline and Command Code support **several independent
accounts**. CodeBuddy, MiMo and Loomy cannot: they read **another desktop
application's single login slot**, so one installed client means one account.
The UI does not offer an "add account" control with nothing to write to.

## Install

```sh
dsh plugin --profile web add github:cavanluo666/dsh-multibuddy-connect
dsh --profile web
```

## Security boundaries

- **Strictly read-only** toward third-party applications. Never writes back.
- Dashboard routes are loopback-only (Host + Origin), and writes additionally
  require an in-process random key.
- No listening ports, no reverse proxy.
- Per-account isolation of probe results, quota caches and usage records.

## Known gaps

Deliberately left unimplemented, and surfaced as **absence rather than fake
success**: Qoder's OSCrypt/DPAPI decryption chain and quota lookup, Trae's pay
endpoint, and every backend whose vendor exposes no balance endpoint. A
fabricated balance would be worse than none, because the user would plan around
it.

## License

**GPL-3.0-or-later**. Derivative works must also be GPL.
