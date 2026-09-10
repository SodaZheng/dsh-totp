# 收录准备 / Listing preparation

依据 [awesome-dsh-plugin 贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md#how-submissions-are-reviewed--收录如何评审) 整理，核对日期：2026-09-10。此文件记录本插件的实现证据，不代表维护者已通过收录或安全审计。

## 提交内容

将 [SodaZheng__dsh-totp.yml](SodaZheng__dsh-totp.yml) 复制到收录仓库的 `data/plugins/SodaZheng__dsh-totp.yml`，仅提交这一项。目标仓库的 README 由条目生成。

分类选择 `security`。描述只声明已实现的能力：个人 Web 实例的纯 TOTP 访问验证、设置内扫码绑定、一次性恢复码、动态保护开关与所有页面授权撤销。首次安装默认关闭，保护开启后才要求 TOTP；它不提供密码加 TOTP 双因素认证或多用户权限。

未填写 `tarball`：项目已有 npm 包，并可从源码安装，无需填入尚不存在的 GitHub Release 资产。概念封面也未用作功能截图。

## 代码与验证依据

| 核对项 | 本插件的依据 |
| --- | --- |
| 可安装 bundle | `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，包含内部 WebServer 与访问网关两个实际入口；`check:package` 验证入口和运行引用均在发布包中。 |
| 扫码绑定 | `src/enrollment.js` 生成本地二维码，按页面绑定临时流程；`src/client.js` 注册设置入口。网关测试覆盖确认后保留当前页、撤销其他页面。 |
| TOTP 与恢复 | `src/core.js` 使用 `otpauth` 验证动态码，SQLite 保存消费记录与恢复码摘要；测试覆盖重启防重放、时间容差、限流、一次性恢复与损坏状态拒绝。 |
| 动态启停和锁定 | `src/gateway.js` 在服务端切换保护、撤销页面凭据并关闭连接；测试实际建立 HTTP 与 WebSocket 连接，验证锁定后的拒绝行为。 |
| 不是空壳或聚合包 | 网关、状态存储、绑定界面、设置页和本机管理均由本仓库提供；依赖不是一组被重新包装的插件。 |
| 上游依赖 | `otpauth`、`qrcode`、`ws` 直接依赖其 npm 包；官方 `@deepseek-ai/*` 包声明为 peer。WebServer peer 精确限定 `0.1.2-rc.1`，显式接受该预发布版，不声称兼容未验证版本。 |
| 安装行为 | 无安装或构建钩子。普通 `npm pack` 直接打包；`prepublishOnly` 在 `npm publish` 前执行 `verify`。`npm run release` 管理版本、npm 发布与 Git 推送。 |
| 网络与凭据 | 运行源码请求固定回环 DSH 上游或浏览器同源接口，无第三方遥测接口；二维码在本地生成。原生 DSH Cookie 保留在服务端。Windows 数据目录 ACL 调整发生在运行时，用于收紧当前用户访问权限。 |
| 本机管理边界 | CLI 使用数据目录中的控制凭据；在线控制同时验证回环来源、Host 和独立密钥，离线修改须取得 owner lease。它是本机管理员入口，不要求手机 TOTP。 |
| 验证范围 | `npm run verify` 包含语法、核心功能、网关、配置和发布脚本测试，以及 bundle YAML、前端模块注册和发布包检查。网关测试使用真实回环 HTTP/WebSocket 连接和模拟 DSH 上游，浏览器体验需在实际 DSH 上复核。 |

## 与已有条目的重叠

列表已经收录 [xbzbing/dsh-auth-gateway](https://github.com/xbzbing/dsh-auth-gateway) 的密码 + TOTP 网关，也收录了 [SummerSec/dsh-web-auth](https://github.com/SummerSec/dsh-web-auth) 等访问控制插件。以上描述来自它们在列表中的条目，未据此推断其他仓库缺少某项能力。

补充核查了四个同类仓库的实现，固定提交链接、实际做法与本插件取舍见 [源码对照](../plugin-conventions.md)。CI 和完整测试是本项目的质量措施，不是所有 DSH 插件统一采用的收录格式。

本插件提交时应强调自身的组合：仅用 TOTP 登录，在 DSH 设置内绑定和换绑，绑定完成后当前页直接继续使用，保护可动态启停，锁定会撤销所有页面授权。不应写成“首个”“唯一”“更安全”或“已无同类插件”。是否构成足够的新增价值，由收录维护者阅读实现后判断。

## 远端条件

2026-09-10 检查 GitHub API 和公共 npm registry 时：

- 仓库为公开、未归档的独立仓库，已有 `dsh-plugin` topic。
- 仓库创建时间是 **2026-09-09 17:36:51（Asia/Shanghai）**；需到 **2026-09-10 17:36:51** 才满 1 天。这个门槛不能通过本地代码修改提前满足。
- npm 已有 `dsh-totp@0.0.2`。本地修订只有在推送源码并按需发布新版本后，才能成为维护者或 npm 用户实际读取的内容。
- 当前没有在主分支找到本插件的同名条目；提交前应重新检查现有条目和待合并 PR，避免重复投稿。

来源：[仓库元数据](https://api.github.com/repos/SodaZheng/dsh-totp)、[npm 元数据](https://registry.npmjs.org/dsh-totp/latest)、[已有条目](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/tree/main/data/plugins)。这些是检查时的状态，提交时应重新核实。

## 本次验证记录

2026-09-10，本地 macOS：

- Node.js `24.21.0`：语法检查及全部 45 项测试通过，其中 22 项覆盖插件功能、网关、启动、Config 和 bundle / client 契约，23 项覆盖发布脚本。
- npm 发布清单检查通过：23 个文件，包含运行入口和所有本地运行引用；bundle YAML 解析与前端 module loader / 设置插槽注册检查通过。普通 `npm pack` 没有执行测试或构建钩子。
- 使用修订后的实际 `.tgz`，在临时 `DSH_HOME` 与独立数据目录中通过 `dsh plugin --profile web add` 安装。DSH `0.1.2-rc.1` / Node.js `26.3.0` 启动成功；终端入口可见，页面引导成功，HTML 引用的 2 个脚本返回成功，状态接口显示首次安装保护关闭；声明的 `--trusted-host` 返回成功，未声明的域名返回 403。
- 安装时 pnpm 提示该 profile 未声明两个官方 peer；本次运行由 DSH 的共享模块解析提供，真实启动已验证。保留官方包的 peer 声明和精确兼容目标，不据此声称支持其他版本。
- 临时 DSH 已停止。上述检查没有操作个人 profile、实际验证器或远端仓库。尚未执行 Linux / Windows CI 和完整浏览器交互验收。

## 最后复核

在独立 DSH profile 和独立 `DSH_TOTP_DATA_DIR` 中安装打包文件，使用目标 DSH `0.1.2-rc.1`：首次进入后绑定，保存恢复码，验证第二个页面需要动态码，测试开关、锁定、恢复换绑和重启。不要使用个人实际绑定数据做开发测试。

安装本插件会替换 WebServer，并接管外部 HTTP 入口；不要与其他登录网关叠加。远程传输、个人实例范围、宿主机权限边界和第三方连接兼容限制详见根目录 README 的安全边界。
