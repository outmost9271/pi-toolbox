# pi-toolbox

`pi-toolbox` 是一个 Pi package，用于按项目启用集中存放在 `/agent-pi/tools/` 中的能力包。

默认不加载任何能力。项目启用某项能力后，插件只为该项目加载对应 Skill，并将对应 `bin` 目录注入 Agent `bash` 工具的 `PATH`。

## 安装

```bash
pi install git:github.com/outmost9271/pi-toolbox
```

安装是全局的，但只有管理命令本身全局加载。能力仍然按项目关闭。

## 使用

```text
/toolbox
/toolbox list
/toolbox status
/toolbox enable exa
/toolbox disable exa
```

项目配置写入启动 Pi 时的：

```text
ctx.cwd/.pi/toolbox.json
```

如果当前目录位于 Git 工作区，插件会将配置的准确仓库相对路径写入本地 `.git/info/exclude`，不会修改项目 `.gitignore`。

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

所有清单路径都必须位于对应能力目录内。项目配置只能引用已发现的能力标识，不能注入任意路径。

## 作用范围

PATH 只注入 Agent 调用的 `bash` 工具，不修改外层 Shell、用户输入的 `!`/`!!` 命令或系统全局环境。

能力目录中的认证与状态由所有启用该能力的项目共享，但不会写入项目配置或本仓库。
