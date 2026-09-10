# pi-toolbox

`pi-toolbox` 是一个 Pi package，用于按全局默认值和项目覆盖启用集中存放在 `/agent-pi/tools/` 中的能力包，并对已安装的 Pi 插件包（`packages`）提供插件级三态管控。

默认所有能力均为关闭状态。只有最终状态为开启的能力才会加载对应 Skill，并将对应 `bin` 目录注入 Agent `bash` 工具的 `PATH`。插件包默认保持全局启用，仅在被显式禁用时停止加载。

## 安装

```bash
pi install git:github.com/outmost9271/pi-toolbox
```

安装是全局的，但管理插件本身不会默认开启任何能力。

## TUI 使用

```text
/toolbox                         # 选择编辑当前项目或全局配置
/toolbox project                 # 编辑当前项目三态覆盖
/toolbox global                  # 编辑全局默认值
/toolbox status                  # 查看当前项目最终状态及来源
/toolbox global status           # 查看全局默认值
/toolbox enable exa              # 当前项目明确开启，兼容原有用法
/toolbox disable exa             # 当前项目明确关闭
/toolbox inherit exa             # 当前项目恢复继承
/toolbox global enable exa       # 全局开启
/toolbox global disable exa      # 全局关闭
```

命令、作用域、动作和能力名称均支持连续参数补全。参数之间的多余空格及粘贴的制表符也受支持；补全作用域或启停动作后保留末尾空格，以便继续补全下一级。

## 插件管控

除能力包外，本插件还可对 Pi settings 中的插件包（`packages`）执行插件级三态管控：全局启用／禁用、项目启用／禁用／继承。写入的配置与 `pi config` 完全同构，两个界面互相兼容。

```text
/toolbox plugins                          # 列出插件及三态状态
/toolbox plugins status                   # 同上
/toolbox plugin status [<插件>]           # 查看单个插件详情
/toolbox plugin enable <插件>             # 当前项目启用（全局禁用时生成强制包含规则）
/toolbox plugin disable <插件>            # 当前项目禁用
/toolbox plugin inherit <插件>            # 当前项目恢复继承
/toolbox plugin global enable <插件>      # 全局启用
/toolbox plugin global disable <插件>     # 全局禁用
```

状态标记：`●` 启用、`○` 禁用、`◐` 部分禁用、`◆` 自定义过滤。`pi-toolbox` 与 `pi-setmodel` 在保护名单中，不允许被禁用。

配置写入位置：

| 操作 | 文件 | 写法 |
|---|---|---|
| 全局禁用 | `<getAgentDir()>/settings.json` | 条目对象 + 四类资源空数组 |
| 项目禁用 | `<cwd>/.pi/settings.json` | 覆盖条目 + 四类资源空数组 |
| 项目启用 | `<cwd>/.pi/settings.json` | `autoload: false` + 逐资源 `+路径` |
| 项目继承 | `<cwd>/.pi/settings.json` | 移除该包条目 |

项目启用依赖资源清单发现（读取包目录的 `package.json` 与约定目录）；无法发现资源目录时拒绝生成启用规则。插件配置写入后需重启 Pi 进程（或 `/reload`）才会影响扩展加载；`/toolbox plugins` 的状态读取始终反映磁盘上的最新配置。

## 回归测试

使用 Node.js 22.19 或更新版本，安装依赖后执行 `npm test`。测试调用源码中的补全函数，并使用真实的 Pi TUI 补全提供器验证文本插入、光标位置、全局／项目候选过滤及空白兼容性；插件管控测试覆盖身份解析、状态计算、资源发现、配置写入与保护名单，不启动模型或读取用户配置。

## 配置优先级

以下为能力（`/agent-pi/tools/`）的优先级规则；插件管控不维护独立配置文件，直接读写 Pi settings。

每项能力的最终状态按以下规则计算：

| 全局状态 | 项目覆盖 | 最终状态 |
|---|---|---|
| 关闭 | 继承 | 关闭 |
| 开启 | 继承 | 开启 |
| 关闭 | 明确开启 | 开启 |
| 开启 | 明确关闭 | 关闭 |

全局配置位于 Pi Agent 配置目录：

```text
<getAgentDir()>/toolbox.json
```

当前环境通常为 `/agent-pi/config/toolbox.json`，格式如下：

```json
{
  "version": 1,
  "enabled": ["exa"]
}
```

项目配置以启动 Pi 时的 `ctx.cwd` 为准：

```text
ctx.cwd/.pi/toolbox.json
```

项目配置使用三态覆盖；未出现的能力表示继承：

```json
{
  "version": 2,
  "overrides": {
    "exa": "enabled",
    "gh": "disabled"
  }
}
```

旧版项目配置仍受支持：

```json
{
  "version": 1,
  "enabled": ["exa"]
}
```

旧版中列出的能力解释为项目明确开启，未列出的能力解释为继承全局；项目配置下一次修改时写成新版格式。

如果当前目录位于 Git 工作区，插件会将项目配置的准确仓库相对路径写入本地 `.git/info/exclude`，不会修改项目 `.gitignore`。全局配置不属于项目。

## 能力目录

每项能力位于 `/agent-pi/tools/<id>/`，并提供 `manifest.json`：

```json
{
  "id": "exa",
  "name": "Exa",
  "description": "通过 Exa API 进行语义搜索和网页内容提取",
  "skillPaths": ["skill"],
  "binPaths": ["bin"]
}
```

所有清单路径都必须位于对应能力目录内。配置只能引用已发现的能力标识，不能注入任意路径。

## 作用范围

PATH 只注入 Agent 调用的 `bash` 工具，不修改外层 Shell、用户输入的 `!`/`!!` 命令或系统全局环境。

全局开启能力后，该能力默认在所有项目生效。所有项目均可直接明确开启或关闭单项能力，项目覆盖始终生效，无需信任确认。

能力目录中的认证与状态由所有启用该能力的项目共享，但不会写入项目配置或本仓库。
