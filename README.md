# UUID Manager

Mindustry 154.3 客户端侧 UUID/UID 管理模组。

当前版本：`v1.1.0`

## 功能

- 在“加入游戏”界面玩家昵称下方直接编辑 `UUID`（8-byte Base64）。
- 实时显示 `UID`（3位 shortID）与 `UID(SHA1)`。
- 支持保存多个 UUID（备注、快速切换）。
- 支持按服务器 `ip:port` 自动切换 UUID。
- 内置 UID 数据库：
  - 设置里可执行“穷举所有3位UID(8秒)”构建本地数据库。
  - 支持从剪贴板导入他人数据库，按 `三位UID + 长id` 去重。
  - 设置中查询会列出同一三位UID对应的所有长id，并可逐条复制。
  - 构建后可在设置中查询，也可在加入游戏界面直接查库。

## 安装

将 `zip` 或 `jar` 产物导入 Mindustry 模组目录：

- 推荐：`构建/uuidmanager-1.1.0.zip`
- 备用：`构建/uuidmanager-1.1.0.jar`

## 本地构建

在 `uuidManager/` 目录执行：

```bash
./gradlew distAll
```

产物：

- `build/libs/uuidmanager.zip`
- `build/libs/uuidmanager.jar`
- 以及根目录 `构建/` 下的版本化副本。

## 注意

- 该模组为客户端侧工具，UUID 相同不等于自动获得他人管理权限。
- 审批码首次通过后会缓存，本地后续不再重复输入。
