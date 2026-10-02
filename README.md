# pi-toolbox

`pi-toolbox` 是一个 Pi package，按全局默认值和项目覆盖管理两类资源：

- **skills**：集中能力包中的 Skill 与命令行入口。
- **extensions**：Pi settings 中声明的插件包，按整个包管理扩展、技能、提示模板与主题的加载。

能力包默认全部关闭；普通 Pi 包声明默认启用。本插件只管理加载选择，不包含工具本体或认证信息，也不提供操作系统级隔离。

## 安装

```bash
pi install git:github.com/outmost9271/pi-toolbox
```

安装插件本身不会默认开启任何能力。

## 命令结构

从 `0.4.0` 开始，`/toolbox` 的一级子命令严格只有 `skills` 和 `extensions`：

```text
/toolbox <skills|extensions> [project|global] <动作> [对象]
```

- 省略作用域时使用当前项目。
- 省略动作时查询状态，不进入修改界面。
- 项目支持 `status`、`enable`、`disable`、`inherit`。
- 全局支持 `status`、`enable`、`disable`，不支持 `inherit`。
- 只有 `skills` 支持 `config` 交互界面。
- 原来的顶层作用域、动作以及 `plugin`、`plugins` 命令已直接移除；不保留旧命令、`list` 别名或迁移入口。

### 无参行为

| 输入 | 行为 |
|---|---|
| `/toolbox` | TUI 模式选择分类，然后显示当前项目状态；其他模式显示简短帮助 |
| `/toolbox skills` | 当前项目技能能力最终状态及来源 |
| `/toolbox skills project` | 同上 |
| `/toolbox skills global` | 全局技能能力默认值 |
| `/toolbox extensions` | 当前项目插件包最终状态及来源 |
| `/toolbox extensions project` | 同上 |
| `/toolbox extensions global` | 全局插件包默认状态 |

### 技能能力管理

```text
/toolbox skills status
/toolbox skills enable exa
/toolbox skills disable exa
/toolbox skills inherit exa

/toolbox skills project status
/toolbox skills project enable exa
/toolbox skills project disable exa
/toolbox skills project inherit exa

/toolbox skills global status
/toolbox skills global enable exa
/toolbox skills global disable exa

/toolbox skills config
/toolbox skills project config
/toolbox skills global config
```

`skills` 管理的仍是整个能力包：开启后既发现对应 Skill，也将对应 `bin` 目录注入助手 `bash` 的 `PATH`，不是只切换技能说明。

`config` 要求 TUI 模式。配置列表支持搜索、回车切换，按退出键保存并关闭；没有变化则不保存。项目配置在继承、开启、关闭之间切换，全局配置在开启、关闭之间切换。

### 插件扩展管理

```text
/toolbox extensions status
/toolbox extensions status cdp-browser
/toolbox extensions enable cdp-browser
/toolbox extensions disable cdp-browser
/toolbox extensions inherit cdp-browser

/toolbox extensions project status
/toolbox extensions project status cdp-browser
/toolbox extensions project enable cdp-browser
/toolbox extensions project disable cdp-browser
/toolbox extensions project inherit cdp-browser

/toolbox extensions global status
/toolbox extensions global status cdp-browser
/toolbox extensions global enable cdp-browser
/toolbox extensions global disable cdp-browser
```

`extensions` 按插件包启停，而不是逐个扩展文件管理；操作可能同时影响该包的技能、提示模板与主题。只纳入全局 settings 已声明的包，项目独有包暂不纳入管控。

状态标记：`●` 启用、`○` 禁用、`◐` 部分禁用、`◆` 自定义过滤。全局查询显示全局状态，不使用当前项目最终状态。`pi-toolbox` 与 `pi-setmodel` 在保护名单中，不允许通过 toolbox 禁用。

本轮不提供 `extensions config` 交互界面。整包启停会替换该包已有过滤规则，项目继承则移除对应项目包条目。

### 连续补全

分类、作用域、动作和对象均支持连续参数补全。省略作用域的写法也受支持：

```text
分类 → 作用域 → 动作 → 对象
分类 → 动作 → 对象
```

参数之间多余的空格、粘贴的制表符、光标后的文本都被保留或正确处理。动作按前缀匹配，对象按标识及描述／来源搜索。作用域和接受对象的动作补全后保留尾部空格，以便继续补全下一级。

全局对象候选依据全局状态；项目对象候选依据明确覆盖状态，因此可以将继承的开启或关闭状态固定为项目覆盖。`inherit` 只列出已有覆盖，扩展禁用候选排除保护名单。

## 能力配置与优先级

每项能力的最终状态按以下规则计算：

| 全局状态 | 项目覆盖 | 最终状态 |
|---|---|---|
| 关闭 | 继承 | 关闭 |
| 开启 | 继承 | 开启 |
| 任意 | 明确开启 | 开启 |
| 任意 | 明确关闭 | 关闭 |

全局配置位于 `join(getAgentDir(), "toolbox.json")`，受 `PI_CODING_AGENT_DIR` 控制，当前环境通常为 `/agent-pi/config/toolbox.json`：

```json
{
  "version": 1,
  "enabled": ["exa"]
}
```

项目配置位于 `ctx.cwd/.pi/toolbox.json`，不向父目录查找。未出现的能力表示继承：

```json
{
  "version": 2,
  "overrides": {
    "exa": "enabled",
    "gh": "disabled"
  }
}
```

旧版项目 `version: 1 + enabled` 仍然兼容：列出的能力解释为项目明确开启，其他能力继承全局；下一次实际保存时迁移到新版格式。命令结构变化不改变配置格式。

能力配置只引用已发现的标识。未知能力在运行时过滤，之后保存可能移除未知条目。

如果当前目录位于 Git 工作区，保存项目能力配置前会将准确的仓库相对路径写入本地 `info/exclude`，不会修改 `.gitignore`。已经跟踪的文件只警告，不修改 Git 索引。

## 插件配置

插件管理直接读写 Pi 原生 settings，与 `pi config` 的资源过滤规则兼容，不维护独立插件配置文件。

| 操作 | 文件 | 写法 |
|---|---|---|
| 全局禁用 | `<getAgentDir()>/settings.json` | 包对象 + 四类资源空数组 |
| 全局启用 | `<getAgentDir()>/settings.json` | 恢复普通包来源声明 |
| 项目禁用 | `<cwd>/.pi/settings.json` | 覆盖条目 + 四类资源空数组 |
| 项目启用 | `<cwd>/.pi/settings.json` | `autoload: false` + 逐资源 `+路径` |
| 项目继承 | `<cwd>/.pi/settings.json` | 移除该包条目 |

项目启用依赖资源发现，读取包的 `package.json` 与约定目录；无法发现资源时拒绝生成启用规则。增量配置中，空数组不代表禁用，应显示为继承。

配置写入后调用 `ctx.reload()`。手动修改文件或更新插件源码后需执行 `/reload`，必要时重启 Pi。查询读取磁盘配置，不是对当前已加载扩展的运行时探测。

插件 settings 保存不执行能力配置的本地 Git 排除逻辑。

## 能力目录与作用边界

默认能力根为 `/agent-pi/tools`，可通过 `PI_TOOLBOX_ROOT` 指定其他能力根。每项能力提供清单：

```json
{
  "id": "exa",
  "name": "Exa",
  "description": "通过 Exa API 进行语义搜索和网页内容提取",
  "skillPaths": ["skill"],
  "binPaths": ["bin"]
}
```

所有清单路径解析后必须位于对应能力目录内。路径检查不解析符号链接真实目标，能力根必须由可信维护者管理。

PATH 只注入助手调用的 `bash`，不修改外层 Shell、用户 `!`／`!!` 命令或系统全局环境。项目覆盖始终生效，无 toolbox 自身的信任确认；Pi 加载项目资源的信任机制是另一回事。

能力认证与状态由启用该能力的项目共享，不写入项目能力配置或本仓库。关闭能力不等于禁止通过绝对路径执行，不是权限控制。

## 回归测试

使用 Node.js 22.19 或更新版本，安装依赖后执行：

```bash
npm test
```

测试覆盖共享命令解析、新命令树、旧命令拒绝、默认查询、作用域与对象候选、前缀和空白兼容性、真实 Pi TUI 提供器与编辑器连续 Tab、插件配置写入及保护名单。

命令处理测试使用真实 Pi 扩展加载器与设置列表，但配置、工作目录和能力根全部来自独立临时目录；不会启动模型或修改用户配置。生命周期测试还验证技能发现和助手 bash 路径注入。

可选地使用实际 Pi 可执行文件进行 RPC 集成验证：

```bash
node scripts/verify-rpc.mjs /path/to/pi
```

该脚本使用独立临时配置、离线模式与显式扩展入口，验证实际命令处理、配置重载、旧命令拒绝和保护名单，不调用模型或修改用户配置。`0.4.0` 已在 Pi `1.0.0` 上通过该验证；单元测试依赖仍保持 `0.85.1`，不将 RPC 验证视为全部终端界面的兼容性证明。
