# 第三方声明 / Third-Party Notices

**本插件作者**：cavanluo666 —— <https://246644.xyz> · <https://space.bilibili.com/3493095616284680>

本插件（**dsh-multibuddy-connect**）是一个**聚合与适配层**。它把多个各自独立的
DeepSeek Harness 模型接入插件统一到一套「多后端 / 多账号 / 用量汇总」的框架下，
并提供跨后端的额度与 token 用量面板。

本插件以 **GPL-3.0-or-later** 分发（见 `LICENSE`）。下列上游项目均为 **MIT**，
依 MIT 条款其版权声明与许可文本必须随分发保留 —— 这是本文件存在的原因。

> **关于许可证的说明**：MIT 允许其代码被纳入 GPL 项目，因此本插件的整体分发
> 是合规的。代价是：本插件（含自行编写的适配层）一经以 GPL 分发，任何衍生作品
> 也必须以 GPL 开源。

---

## 一、直接衍生：WorkBuddy 插件

本插件的外壳（多后端框架、卡片、设置、探测、签到、凭据存储、构建与测试体系）
直接衍生自：

| 项目 | 作者 | 许可 | 仓库 |
|---|---|---|---|
| dsh-workbuddy-connect | corrinehu | GPL-3.0-or-later | https://github.com/masknull/dsh-workbuddy-connect |

该项目的两个 WorkBuddy 变体（`workbuddy` / `workbuddy-ai`）在本插件中**保持原样**，
其 GPL-3.0-or-later 许可与本插件一致。

---

## 二、后端适配的上游项目（均为 MIT）

以下 9 个项目的**协议实现、凭据探测路径、模型目录规则**被移植/改编为本插件的
后端适配器。每一个适配器文件的开头都注明了它改编自哪个项目。

### Command Code Go
- 项目：`dsh-commandcode-go-provider`
- 作者：jiesou
- 许可：MIT
- 仓库：https://github.com/jiesou/dsh-commandcode-go-provider
- 采用内容：`/alpha/generate` 网关协议、Go 套餐模型判定、`accounts` 多账号字典机制

### Cline
- 项目：`dsh-cline-free-provider`
- 作者：jiesou
- 许可：MIT
- 仓库：https://github.com/jiesou/dsh-cline-free-provider
- 采用内容：免费模型目录的三重取并规则（`:free` 后缀 / pricing / recommended-models 的 free 桶）

### OpenCode Zen
- 项目：`dsh-opencode-xdbridge`
- 作者：XDTrees
- 许可：MIT
- 仓库：https://github.com/XDTrees/dsh-opencode-xdbridge
- 采用内容：受管 OpenCode 运行时的目录布局、免费模型判据（cost 全维度为 0）

- 项目：`dsh-opencode-free-models`
- 作者：yu-wenchao
- 许可：MIT
- 仓库：https://github.com/yu-wenchao/dsh-opencode-free-models
- 采用内容：内置免费模型清单、运行时端点文档格式

### Trae
- 项目：`dsh-connect-trae`
- 作者：dingminhua
- 许可：MIT
- 仓库：https://github.com/dingminhua/dsh-connect-trae
- 采用内容：四个安装位（Trae CN / TRAE SOLO CN / Trae / TRAE SOLO）的探测路径、
  `userRegion` 区域判定、双区域网关常量、按区域的模型回落清单

### Qoder
- 项目：`dsh-connect-qoder`
- 作者：hdhgsysh（及 fork 维护者）
- 许可：MIT
- 仓库：https://github.com/hdhgsysh/dsh-connect-qoder
- 采用内容：双区域（`qoder-cn` / `qoder`）的产品划分、PAT 环境变量名、
  应用数据目录的平台解析
- **未采用**：COSY 签名、置换 base64、双层 SSE、DPAPI 解密链（见下文「已知缺口」）

### CodeBuddy
- 项目：`dsh-codebuddy-models`
- 作者：evlon
- 许可：MIT
- 仓库：https://github.com/evlon/dsh-codebuddy-models
- 采用内容：`*.info` 凭据文件的字段布局、官方 `product.json` 模型目录规则
- **未采用**：token 过期时的回写刷新（本插件对第三方应用严格只读）

### MiMo（小米）
- 项目：`dsh-mimo-connect`
- 作者：anze225-max
- 许可：MIT
- 仓库：https://github.com/anze225-max/dsh-mimo-connect
- 采用内容：Chromium cookie 库的读取路径、passport cookie 三元组、
  quota 百分比语义（**剩余**而非已用）、域名作用域 cookie jar

### Loomy（讯飞）
- 项目：`dsh-loomy-connect`
- 作者：gdrpzym
- 许可：MIT
- 仓库：https://github.com/gdrpzym/dsh-loomy-connect
- 采用内容：`auth-session.json` 解析、手机号脱敏规则、`opencode.json` 模型清单格式

---

## 三、未被纳入的项目

以下项目因**不是模型 provider**（技能包、工具箱、IM 接入、配置同步），
与本插件的后端框架不属同一类别，故未纳入：

- `dsh-sensenova-skills`（商汤技能包）
- `dsh-0-tools`（工具箱）
- `dsh-im-connect`（即时通讯接入）
- `dsh-agent-sync`（配置同步）

---

## 四、已知缺口（诚实说明）

本插件的部分后端**并未完整实现上游的全部能力**。这些缺口是**有意保留**的，
并且都以「功能缺席」而非「假的成功」呈现：

| 后端 | 缺口 | 呈现方式 |
|---|---|---|
| Qoder | 未实现 OSCrypt/DPAPI 解密链，无法读取桌面端已登录的凭据 | 报告为「已安装但未采用」，并提示改用 PAT |
| Trae | 未实现 pay 端点查询，无积分余额读数 | 额度显示「需在客户端内查询」 |
| Qoder | 未实现额度查询 | 额度显示「需通过网关查询」 |
| CodeBuddy | 上游无余额端点（额度只在请求报错 14012 时出现） | 额度显示「不提供额度查询」 |
| OpenCode | 未托管运行时的下载与启动 | 未就绪时给出准备指引 |
| Cline / Command Code / Loomy | 上游无余额接口 | 额度显示「不提供额度查询」 |

设计原则：**宁可如实说「查不到」，也不编造一个数字**。一个假的余额会被用户
当作真实信息去规划用量。

---

## 五、MIT 许可全文

以下文本适用于上述所有 MIT 项目（各项目版权归其各自作者所有）：

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
