# 全局记忆的审核、发布与回滚

仅供有权维护本机 SQLite 数据库的开发/运营人员使用。普通家长只能管理本家庭专属记忆；此工具不提供网页写入接口，也不凭家长 PIN 获得全局发布权限。本版审核人是本地操作记录，不是独立账号认证或双人审批系统。不要把数据库路径、草稿或维护命令交给儿童端。

## 内容边界

- 允许的键：`world.home.name`、`world.garden`、`world.scene.<slug>`、`world.activity.<slug>`。slug 为小写英文开头、最多 32 位英文数字和短横线。
- 小屋、花园、场景必须为 `imaginary`，表示虚构背景；活动必须为 `plan`，表示建议而非已发生的共同经历。轻活动仅开放绘画、涂色、折纸、阅读、数数、观察、想象、种花或简单伸展。
- 不发布角色身份、人设、安全规则、权限、亲密关系、私人经历、个人信息、外链、联系方式、危险活动或提示词指令。换角色/改变权限必须经过代码与产品审核，不能利用 `world.*` 实现。
- 草稿必须人工审阅后明确写 `reviewed:true`。最多 32 条，每条内容 1–120 字；重复键、未知字段、越界键和明显个人信息/指令会被程序拒绝。程序的规则检查不能证明所有自然语言都安全，审核人仍需逐条确认它确属虚构背景或适龄轻活动。
- 本版全部条目统一 `audience:"all"`，覆盖应用提供的全部年龄段；不实现按年龄分组投放。统一 `validity:"until-replaced"`：提交即生效，直到下次发布或回滚替换，没有定时发布、最短展示期或自动到期。若内容不宜全年龄或需要特定期限，请勿用本工具发布。
- 发布是**完整快照替换**。草稿未列出的旧键会移除；空列表表示明确清空全局条目。家长已确认的专属记忆保存在其他表，本工具不会修改；同键专属约定的优先级由应用维持。

## 草稿格式

将下列示例另存为草稿文件，只用虚构资料；示例不是已发布内容。

```json
{
  "reviewed": true,
  "audience": "all",
  "validity": "until-replaced",
  "items": [
    { "key": "world.home.name", "kind": "imaginary", "content": "小屋叫云朵小屋" },
    { "key": "world.garden", "kind": "imaginary", "content": "想象中的小屋外有一块可以一起种花的小花园" },
    { "key": "world.activity.draw", "kind": "plan", "content": "可以画一朵想象中的小花" }
  ]
}
```

## 操作顺序

在代码根目录执行，使用 Node 22.13 或以上及项目现有的 `tsx`。Mac 本机可在命令前加 `PATH=/usr/local/nodejs/bin:$PATH`。必须显式指定已存在的数据库文件；工具不会因为路径拼错而创建一个新的运行库。下面的 `/绝对路径/…` 均为占位，须由操作者核对后替换。

1. 查看当前版本及审核记录。

   ```sh
   node --import tsx ops/global-memory.ts snapshot --db /绝对路径/baoyan.sqlite
   node --import tsx ops/global-memory.ts history --db /绝对路径/baoyan.sqlite
   ```

2. 先预览差异，确认增加、修改、移除的条目和 `baseRevision`。

   ```sh
   node --import tsx ops/global-memory.ts preview --db /绝对路径/baoyan.sqlite --draft /绝对路径/draft.json
   ```

   `snapshot`、`history`、`preview` 只读。旧库尚无全局表时，它们用临时内存库中的内置 r1 做比较并输出 `databaseInitialized:false`，不会迁移或修改运行库。

3. 审核人确认后，用刚刚核对的版本号发布。命令会再次输出差异，然后提交。

   ```sh
   node --import tsx ops/global-memory.ts publish --db /绝对路径/baoyan.sqlite --draft /绝对路径/draft.json --expected-revision 1 --reviewer reviewer-id --note '已逐条审核虚构背景和轻活动'
   ```

   `--expected-revision`、`--reviewer`、`--note` 缺一不可。不要在说明中写儿童信息或密钥。若出现 `REVISION_CONFLICT`，表示期间已有发布或数据库正被更新；重新预览并人工核对，不能盲目递增参数自动重试。

4. 要撤销内容，先查看历史，再回滚到已存在的目标版本。

   ```sh
   node --import tsx ops/global-memory.ts rollback --db /绝对路径/baoyan.sqlite --target-revision 1 --expected-revision 2 --reviewer reviewer-id --note '复核后恢复初始背景'
   ```

   此例将 r1 的条目恢复为新的 **r3**，不会把当前版本号倒退成 r1，也不会删除 r2。回滚仍须通过当前内容规则，并保留目标版本、审核人和原因。

每行输出是一个 JSON 对象；发布/回滚先输出预览事件，成功后才输出 `published`/`rolled-back`。看到预览不代表发布成功，应检查退出码和最后的成功事件。不要对运行库做“演示发布”；演练只使用独立临时库。

## 版本和应用集成

`createGlobalMemoryStore(db, { now? })` 使用传入的应用数据库，首次导入 `apps/server/fixtures/global-memories.json` 为 r1，维护 `global_memory_releases` 和 `global_memory_head` 两表。所有历史发布均保留。`snapshot()` 每次读取当前指针，`history()` 返回倒序审核记录，`preview(draft)` 不写入。

发布/回滚在同一 `BEGIN IMMEDIATE` 事务中校验预期版本、插入新完整快照，再以版本条件切换当前指针。失败整体回滚；两名审核人依据同一旧版本提交，只有先成功的一方能发布。内容带哈希用于发现意外损坏，不构成对拥有数据库写权限者的防篡改保证。

应用必须比较 `snapshot().revision`，使旧上下文、候选记忆、待播回复及异步响应失效，并通知前端停止旧音频；此模块只管理发布数据，不管理通话或浏览器状态。不要把本地审核人的身份和发布说明暴露给普通孩子端。全局更新不会自动删除家长已确认的同键专属约定。

## 验证

```sh
node --import tsx --test tests/global-memory.test.ts
```

测试只使用内存/临时库，涵盖完整差异、旧发布保留、回滚新版本、两个数据库连接的版本冲突、越界拒绝、内容完整性和只读 CLI 预览；不执行运行库发布。
