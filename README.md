# dsh-multibuddy-connect

把**多家订阅制 AI 编程产品**的额度一并接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH），
并提供一块**跨后端的用量汇总面板**：还剩多少、花了多少，一屏看完。

本插件复用你**已经登录**的桌面客户端或已有 API Key，不额外申请密钥、不额外装常驻程序。

> **本插件是 [dsh-workbuddy-connect](https://github.com/masknull/dsh-workbuddy-connect)（作者 corrinehu）的衍生作品。**
> 在其多后端外壳之上，新增了 8 个第三方后端的适配与用量汇总面板。
> 以 GPL-3.0-or-later 分发，第三方项目署名见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

---

## 作者

**cavanluo666**

- 个人网站：<https://246644.xyz>
- Bilibili：<https://space.bilibili.com/3493095616284680>
- GitHub：<https://github.com/cavanluo666>

欢迎反馈问题、提交 PR，或在 Bilibili 私信交流。

---

## 支持的后端

| 后端 | 厂商 | 凭据来源 | 多账号 | 额度查询 |
|---|---|---|:---:|:---:|
| **WorkBuddy** | 腾讯 | 插件自己的网页设备授权登录 | ✅ 双版本 | ✅ |
| **WorkBuddy AI** | 腾讯 | 同上（国际版 realm） | ✅ 双版本 | ✅ |
| **Trae** | 字节跳动 | 桌面端已登录状态（4 个安装位） | ✅ 双区域 | ⚠️ 见下 |
| **Qoder** | 阿里巴巴 | 桌面端已登录状态 / PAT 环境变量 | ✅ 双区域 | ⚠️ 见下 |
| **CodeBuddy** | 腾讯 | 桌面端登录文件（只读） | ❌ | ❌ 上游无接口 |
| **MiMo** | 小米 | 桌面端 cookie / 插件凭据 | ❌ | ✅ |
| **Loomy** | 讯飞 | 桌面端 `auth-session.json`（只读） | ❌ | ❌ 上游无接口 |
| **Cline** | Cline | API Key | ✅ 多 Key | ❌ 免费档无余额 |
| **Command Code Go** | Command Code | API Key | ✅ 多 Key | ❌ 上游无接口 |
| **OpenCode Zen** | OpenCode | 受管本地运行时 | ❌ | ❌ 上游无接口 |

### 「多账号」到底能做到什么

这是本插件**如实声明**、不含糊的一点：

- **真正支持多账号**：WorkBuddy（国内/国际）、Trae（国内/国际）、Qoder（国内/国际）、
  Cline 与 Command Code（多个 API Key）。这些的凭据模型本身就支持多份，一个插件里
  可以同时配多个账号，各自独立计费与统计。
- **做不到多账号**：CodeBuddy、MiMo、Loomy。它们读取的是**另一个桌面程序的单一登录槽**，
  本机装一个客户端就只能有一个账号 —— 这不是插件偷懒，是源头的模型决定的。
  卡片上不会提供「添加账号」这种没有写入目标的按钮。

---

## 用量汇总面板

侧边栏底部「**用量汇总**」进入。数据分两类，**刻意不混为一谈**：

### ① 剩余额度（来自上游）
每个账号当前还剩多少。读的是各家自己的计费接口，带**读取时间**。
后端不提供余额接口时显示「不提供额度查询」，**不会显示 0** —— 0 的意思是「用完了」，与「查不到」是两回事。

### ② token 消耗（插件本地记账）
**多数上游并不提供按天的 token 用量**，所以这部分由插件自己记账：
从 DSH 的会话计量中取数，按「天 / 后端 / 账号」落到本地账本。

- 折线柱状图：最近 7 / 30 / 90 / 365 天
- 后端占比图例
- 账号明细表：额度条 + 窗口内用量 + 今日用量 + 调用次数

> ⚠️ **本地账本从安装本插件那天开始记录**，不会追溯历史。上游不提供的历史用量无法补录。

---

## 安装

```sh
dsh plugin --profile web add github:cavanluo666/dsh-multibuddy-connect
dsh --profile web
```

或从本地目录安装（开发时推荐）：

```sh
dsh plugin --profile web add /绝对路径/dsh-multibuddy-connect
dsh --profile web
```

装好后，**已登录的后端会自动出现**在模型选择器里；用量面板在侧边栏底部。

---

## 各后端的前置条件

| 后端 | 需要准备什么 |
|---|---|
| WorkBuddy / WorkBuddy AI | 在卡片上点「登录」，走网页设备授权 |
| Trae | 安装 Trae / TRAE SOLO 桌面端并登录（国内版、国际版均可，可同时） |
| Qoder | 安装 Qoder 桌面端并登录，**或**设置环境变量 `QODERCN_PAT` / `QODER_PAT` |
| CodeBuddy | 安装 CodeBuddy（或 WorkBuddy）桌面端并登录 |
| MiMo | 安装小米 MiMo 桌面端并登录 |
| Loomy | 安装讯飞 Loomy 桌面端并登录 |
| Cline | 设置环境变量 `CLINE_API_KEY`，或在插件的凭据文件中配置 |
| Command Code Go | 设置环境变量 `COMMANDCODE_API_KEY` |
| OpenCode Zen | 准备本地 OpenCode 运行时（见下） |

没有装的后端不会报错 —— 它们只是不出现，除非你主动去配置。

---

## 安全边界

| 边界 | 机制 |
|---|---|
| 第三方应用 | **严格只读**。绝不写入、不修改、不回写刷新别家应用的登录态 |
| 本地面板路由 | 仅回环（Host + Origin 双重校验），写操作额外要求进程内随机密钥 |
| 网络暴露面 | 不监听任何端口，不做反向代理 |
| 凭据存储 | 各后端独立文件，存于插件数据目录，与可重建的缓存分离 |
| 账号隔离 | 一个账号的探测结果、额度缓存、用量记录，绝不外溢到另一个账号 |

> ⚠️ **CodeBuddy 的一处差异**：原插件会在 token 临近过期时回写刷新，本插件**取消了回写**。
> 代价是 token 过期后需要你在客户端重新登录；收益是插件对第三方应用保持纯只读。

---

## 已知缺口（诚实说明）

这些缺口是**有意保留**的，且都以「功能缺席」呈现，**不会假装成功**：

| 后端 | 缺口 | 你会看到 |
|---|---|---|
| **Qoder** | 未实现 OSCrypt/DPAPI 解密链 | 显示「已安装但未采用」，提示改用 PAT |
| **Qoder** | 未实现额度查询 | 「需通过网关查询」 |
| **Trae** | 未实现 pay 端点查询 | 「需在客户端内查询」 |
| **CodeBuddy** | 上游无余额端点 | 「不提供额度查询」 |
| **OpenCode Zen** | 不托管运行时的下载与启动 | 未就绪时给出准备指引 |
| **Cline / Command Code / Loomy** | 上游无余额接口 | 「不提供额度查询」 |

**设计原则**：宁可如实说「查不到」，也不编造一个数字。
一个假的余额会被你当作真实信息去规划用量 —— 那比没有更糟。

Qoder 的加密凭据链需要 PowerShell + `Crypt32`（DPAPI）才能解开，涉及约 58 KB 的
密钥处理代码，其失败模式是**静默的**（密钥派生错误会表现为「没登录」而非报错）。
半可用的解密器会让用户反复重新登录却永远不知道问题在哪，因此没有照搬。

---

## 从源码构建

```sh
pnpm install
pnpm run typecheck   # 服务端 + 客户端双端类型检查
pnpm test            # 631 个测试
pnpm run build       # 产出 lib/
```

> 测试**串行执行**（`fileParallelism: false`）。这不是随意的：多个测试文件会通过
> `DSH_WORKBUDDY_DATA_DIR` 指向临时目录，而 vitest 的 fork 池会**复用 worker**，
> 并发时环境变量会跨文件残留，表现为一个原本稳定的老测试偶发失败。
> 串行让每个测试的结果只取决于它自己。

---

## 许可

**GPL-3.0-or-later** —— 见 [LICENSE](./LICENSE)。

这意味着：你可以自由使用、修改、分发本插件，但**衍生作品同样必须以 GPL 开源**。

第三方项目署名与 MIT 全文见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

---

## 致谢

本插件诞生于把多位开发者的独立工作汇聚到一起：

- [corrinehu](https://github.com/masknull/dsh-workbuddy-connect) —— 本插件的外壳与 WorkBuddy 支持
- [jiesou](https://github.com/jiesou/dsh-commandcode-go-provider) —— Command Code Go / Cline
- [XDTrees](https://github.com/XDTrees/dsh-opencode-xdbridge) · [yu-wenchao](https://github.com/yu-wenchao/dsh-opencode-free-models) —— OpenCode Zen
- [dingminhua](https://github.com/dingminhua/dsh-connect-trae) —— Trae
- [hdhgsysh](https://github.com/hdhgsysh/dsh-connect-qoder) —— Qoder
- [evlon](https://github.com/evlon/dsh-codebuddy-models) —— CodeBuddy
- [anze225-max](https://github.com/anze225-max/dsh-mimo-connect) —— MiMo
- [gdrpzym](https://github.com/gdrpzym/dsh-loomy-connect) —— Loomy

每一个上游项目都解决了「如何与某家厂商的私有协议对话」这一独立难题，
没有它们，本插件无从谈起。

---

## 联系

- 个人网站：<https://246644.xyz>
- Bilibili：<https://space.bilibili.com/3493095616284680>
- 问题反馈：[GitHub Issues](https://github.com/cavanluo666/dsh-multibuddy-connect/issues)
