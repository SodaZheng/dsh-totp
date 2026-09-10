# DSH 插件实现对照

核查日期：2026-09-10。实际阅读了下列仓库的 `package.json`、bundle patch、Host 入口及其测试 / 发布脚本。链接固定到检查时的提交，方便复核；没有运行或复制这些插件的认证实现。

## 核查结果

| 样本 | 读到的实际做法 |
| --- | --- |
| [xbzbing/dsh-auth-gateway](https://github.com/xbzbing/dsh-auth-gateway/tree/4d0b404174496e71a05478904dd5c9d42f4ed0f1) | `dsh.bundle.patch` + Web client 声明；`check` 包含 Node 测试；Host 导出 Standard Schema `Config`。网关在同进程内代理回环上游，并通过 `console.log` 输出外部访问地址、通过 `ctx.logger` 记录运行事件。 |
| [SummerSec/dsh-web-auth](https://github.com/SummerSec/dsh-web-auth/tree/b722e44a881d71fc3eb943627d654a6e293876f8) | 直接发布 JavaScript 源文件；bundle 禁用原 WebServer 并插入替代服务；导出 Schemastery `Config`。`prepublishOnly` 运行 `check`，`pack:check` 只预览打包清单。 |
| [TecFancy/dsh-auth-gate](https://github.com/TecFancy/dsh-auth-gate/tree/105277d6858425e27daec2cbcaede579f623a3ee) | TypeScript 项目，`prepack` 负责构建；完整质量检查集中在 `verify`；另有客户端 module loader 的 bundle 检查。CI 包含 Linux / Windows，Host 导出 Schemastery `Config`。 |
| [0QwQ0/dsh-ui-auth](https://github.com/0QwQ0/dsh-ui-auth/tree/608da8baf005067635e3bd8c98a07979783dd88a) | `dsh.bundle.patch` + Web client；`prepack` 运行语法、密码学、Host / client 和安全测试；另设商店契约检查。说明完整测试放在 `prepack` 也有实际先例，并非所有插件都采用同一发布流程。 |

四个样本都使用 `package.json` 中的 `dsh.bundle.patch` 作为安装声明。测试、构建和发布脚本的组织不同；同类项目的选择只能说明有先例，不能替代[当前收录要求](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。例如部分样本仍把官方包放在 `dependencies`，本项目继续遵循指南，把所用官方包声明为 peer。

## 本插件采用的做法

- **保留源码分发。** 本插件没有 TypeScript 或需构建的前端资源，直接发布 `src/` 即可；不增加只为模仿其他仓库而存在的构建步骤。
- **发布前完整检查。** 参考 SummerSec 的生命周期划分与 TecFancy 的集中检查入口，提供 `npm run verify`，由 `prepublishOnly` 调用。普通 `npm pack` 不再触发整套测试及临时 Git 仓库操作。`npm run release` 原有版本、npm 发布与 Git 推送流程保留。
- **导出 `Config`。** 使用已经声明的 Schemastery peer，在创建状态目录或监听端口前验证配置和默认值；检查会话时长关系及访问地址格式。`host` 对齐目标 DSH 的 `127.0.0.1` / `0.0.0.0` 两个监听选项。
- **保留 Web runtime 配置。** xbzbing 的 bundle 明确指出 Cordis 会替换整段 `config`。本插件在关闭原始地址打印和浏览器打开时，继续传递 `surfaceContext` 与 `ctx.webStartup.trustedHosts`，避免丢掉 CLI 信任域名。
- **保留终端地址输出。** xbzbing 的 `index.js` 和目标版本官方 Web runtime 都直接用 `console.log` 打印外部入口；这是合适的用法。输出中不含 DSH 原生凭据，内部运行日志仍使用宿主 logger。
- **验证前端真实注册契约。** 参考 TecFancy 的 bundle 检查目的，本插件检查实际 `__ModuleLoader__.load` 注册、包名、factory 与设置插槽。bundle YAML 由开发依赖 `yaml` 解析，`!!js` 表达式在检查器中保留为数据，不靠搜索固定仓库名判断安装配置。
- **保留认证边界。** 继续使用内部 WebServer 强制回环、动态内部端口、纯 TOTP 登录和服务端授权。其他插件的密码、多用户或反向代理方案不自动成为本插件需要复制的功能。

`dsh.plugin.json` 是本项目发布脚本同步的辅助元数据；DSH 的安装依据仍是 `package.json` 与 `cordis.patch.yml`。CI、测试数量及本地收录说明不是收录规范中的统一硬性要求。

## 对照入口

- xbzbing：[package.json](https://github.com/xbzbing/dsh-auth-gateway/blob/4d0b404174496e71a05478904dd5c9d42f4ed0f1/package.json)、[patch](https://github.com/xbzbing/dsh-auth-gateway/blob/4d0b404174496e71a05478904dd5c9d42f4ed0f1/cordis.patch.yml)、[Host 入口](https://github.com/xbzbing/dsh-auth-gateway/blob/4d0b404174496e71a05478904dd5c9d42f4ed0f1/index.js)。
- SummerSec：[package.json](https://github.com/SummerSec/dsh-web-auth/blob/b722e44a881d71fc3eb943627d654a6e293876f8/package.json)、[Host 入口](https://github.com/SummerSec/dsh-web-auth/blob/b722e44a881d71fc3eb943627d654a6e293876f8/src/index.js)。
- TecFancy：[package.json](https://github.com/TecFancy/dsh-auth-gate/blob/105277d6858425e27daec2cbcaede579f623a3ee/package.json)、[bundle 检查](https://github.com/TecFancy/dsh-auth-gate/blob/105277d6858425e27daec2cbcaede579f623a3ee/scripts/verify-bundle.mjs)。
- 0QwQ0：[package.json](https://github.com/0QwQ0/dsh-ui-auth/blob/608da8baf005067635e3bd8c98a07979783dd88a/package.json)。
