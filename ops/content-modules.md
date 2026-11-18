# 故事与学习模块接入说明

2026-09-30工程快照；最新产品状态始终读取项目根目录唯一基线。

## 接口

```ts
import { createContentEngine } from '../apps/server/src/content-engine.js';

const content = createContentEngine({ now: Date.now });
const context = { ageGroup: '6-8' as const, remainingSeconds: 120 };
const catalog = content.catalog(context.ageGroup);
// catalog.stories：当前年龄段5篇摘要；不传年龄返回20篇。
// catalog.learningTopics：arithmetic / units / chinese / english。

content.handle({ callId, ...context, text: '讲故事：paper-boat-test' });
content.control(callId, 'next', context);
content.control(callId, 'pause', context);
content.control(callId, 'resume', context);
content.control(callId, 'repeat', context);
content.control(callId, 'stop', context);
// 分支中的选项：control(callId, 'choose:apology', context)。

content.handle({ callId, ...context, text: '学习：arithmetic' });
content.control(callId, 'learning:confirm', context);
content.handle({ callId, ...context, text: '12' });
content.control(callId, 'learning:explain', context);
content.control(callId, 'learning:similar', context);
```

handle返回undefined表示交给正常聊天；已处理结果统一`handled:true`，含`reply`、`presentation:'story'|'learning'`及对应状态。无需调用聊天模型；播音仍交给已配置的TTS。

故事状态含`id/title/segment/total/status/endsAt`及当前可选`choices`。segment从1开始。最后可播段生成后仍是`playing`，保持暂停/恢复/重听能力；前端实际播完才发`complete`确认。complete仅允许最后段且返回同段正文，调用层保留replyId不重新TTS；不能自动请求下一段。重听完成段会再次进入playing。分支必须等待现有选项，next不能替孩子选择。讲故事、具体标题、睡前/友谊等主题及“几分钟”自然请求也可进入；不适合当前年龄的id、未发布id会明确拒绝。

学习状态含`topic/stage/question/step/totalSteps/endsAt`。题干先进入confirm，确认后才能回答或解释；下一步只给一小步，不自动把全部步骤念完。实际运算用BigInt有理数精确校验，不用eval或模型自评。长度、质量和时间换算不能跨维度；回答带单位时需符合目标单位，等价的千克/公斤可接受。错误答案给方法提示；不支持题型明确说明并废弃旧题，避免继续核对过时题目。

## 时间、取消与纠错

剩余时间必须为正且有限。开始故事的截止是现在＋请求时长与通话剩余时间的较小值；每次control只能收紧截止。暂停/恢复、重听不延时；截止后不再返回可播放的旧段落。故事元数据的时长是选题用的估计，不是TTS实测保证。

取消前可调用`content.cancel(callId)`暂停并保留通话内进度；挂断/撤回/通话清理调用`content.clear(callId)`。内容状态不落库，不跨日恢复，没有声纹或记忆数据。

按句纠错前，每轮执行前取`checkpoint(callId)`。快照可JSON序列化，包含故事、学习与活动类型；更正本轮时`restore(callId, snapshot)`再处理新文字，先前有效段落/题目仍保留。快照的截止仍有效，过期恢复也不能继续。由接入层保管快照，不接受客户端直接提交。重复请求的幂等处理由调用层负责，避免把同一“下一段”重复推进。

## 内容边界与验收

20篇文本为项目原创，按四个年龄段各5篇，每篇3段；4篇包含固定分支。来源与published元数据随目录返回。SQLite内容目录已支持受控本机审稿、审核、发布、下架和回滚；没有家庭端全局发布入口、供应商动态生成故事、全课程、复杂应用题、方程、拍照读题、发音评分。

算术最多5个数、加减乘除，输入值绝对值不超过100000；小数最多6位。3–5岁只允许0–10整数加减且结果非负。输入支持常见中文数字和加减乘除口述，小数及分数答案精确比较。语文/英语是固定常用反义词和5个基础词的小练习，不应宣传成完整学科课程。

故事20项、助学21项、内容运营18项及App双实例集成5项，共64项测试通过，覆盖截止与不延时、暂停/恢复/重听、实际播完ACK、固定分支、分龄目录、跨call隔离、checkpoint回滚、改题、运算顺序、小数/分数、单位正确性、不支持范围、待审不暴露、审核hash、下架旧段停止、学习开关、回滚、只读CLI与完整CLI发布链。App测试还覆盖独立连接发布时两个进程的目录刷新、已生成回复拒绝旧TTS、pending供应商晚到409和挂断不带旧前文。未调用收费模型、没有使用真实家庭资料；真实TTS、H5手机与儿童适龄体验由root集成后另行验收。

## 初始20篇文本的模型辅助编辑复核

复核对象为源码固定文本和四组完整分支，非真人审稿或儿童质量验收。逐篇核对了情节收尾、年龄适配方向、危险情节、羞辱/威胁、陪伴边界与“必须听完”暗示。没有发现需要立即撤下的显著文本问题。目录文字均为第三人称虚构叙事，宝妍没有声称这些是自己的真实经历；动物与风云拟人按故事处理。当前限时、暂停、停止规则允许未听完就结束。

| 年龄 | 故事 | 复核要点与结论 |
| --- | --- | --- |
| 3–5 | 小云朵的慢慢路 | 无比赛压力，允许休息，安静收尾；通过基础编辑复核 |
| 3–5 | 小兔的红杯子 | 两种分支均借助大人/共同寻找，保留自己的需要，不要求共享饮用；通过 |
| 3–5 | 小蜗牛先走一步 | 找适合路径，不催促克服害怕，无危险攀爬指令；通过 |
| 3–5 | 小猫和气呼呼的风 | 生气被承认，大人陪伴，无处罚或威胁，不要求马上开心；通过 |
| 3–5 | 小鸭子的影子朋友 | 安全院内观察，影子解释基本正确，动物拟人属于虚构；通过 |
| 6–8 | 蓝铅笔去了哪里 | 两分支均解决误会并核实事实，不把担心或错误等同坏孩子；通过 |
| 6–8 | 纸船的第二次出发 | 浅水盆实验与收纳，允许失败和停止，无独自近水建议；通过 |
| 6–8 | 可以安静一会儿的座位 | 尊重暂不倾诉，不连问或施加情绪标签；通过 |
| 6–8 | 图书角的小铃铛 | 接纳承认失误并修补，不羞辱或威胁惩罚；通过 |
| 6–8 | 月亮不用等我 | 允许明天继续，角色家人是故事关系，不假定用户家庭结构；通过 |
| 9–12 | 一座桥，两种办法 | 两分支均有测试、合并方案和贡献记录，分歧可合作；通过 |
| 9–12 | 没发出去的那条消息 | 区分感受和猜测，允许延迟回应，不鼓励孤立或控制朋友；通过 |
| 9–12 | 窗台上的空白格 | 不伪造记录，承认未知，不为失败贴人格标签；通过 |
| 9–12 | 先说好这一句 | 允许紧张和停顿，练习循序，不承诺一次成功；通过 |
| 9–12 | 明天那一页 | 只准备可控步骤，休息不被扣分或贬低；通过 |
| 13–14 | 那张多出来的票 | 两分支均说清边界、有限帮助和责任，不以友谊绑架；通过 |
| 13–14 | 排名之外的一条线 | 感受被接住，用具体改进代替排名羞辱，不承诺成绩；通过 |
| 13–14 | 转发之前的三分钟 | 核对来源与日期，公开信息经许可，不擅自扩散私事；通过 |
| 13–14 | 我漏掉的那一页 | 承担与补救分开，承认错误不等于羞辱，不要求隐瞒；通过 |
| 13–14 | 允许今天到这里 | 保留结束点和休息，无强迫完成或依赖宝妍暗示；通过 |

以上结论只来自文本编辑检查；具体孩子的理解程度、偏好、触发情境和声音情感仍需目标家庭验证。

## 内容运营

`createContentStore(db,{now})`只管理`content_catalog_releases/content_catalog_head/content_story_drafts/content_catalog_audit`四表。首次初始化种子为20篇原创，审核来源明确标注`internal-rules`及“未代替真人适龄审核”，不能宣称已真人审核。再初始化保留现有发布/停用状态。

应用应注入`createContentEngine({now,catalogProvider:contentStore.publishedStories,learningTopicsProvider:contentStore.enabledLearningTopics})`；每次handle/control/目录请求刷新已发布目录。下架或发布了不同故事版本时，旧进度停止，不能重听旧文本。固定学习类型只支持开关，不接受动态执行逻辑。已生成回复或TTS尚在播放的失效保护需应用层把内容目录revision纳入reply/speech有效性检查。

本机工具用`node --import tsx ops/content-manager.ts --help`看完整命令。Node22生产构建后改为`node dist/server/ops/content-manager.js`。维护者持有受控服务器访问权限，家庭PIN没有全局发布权限。

流程是`preview → draft → review → publish`：preview只读校验；draft记录草稿；review针对确定草稿版本与正文摘要登记审核；publish再次校验结构、安全、来源、草稿版本、摘要及目录expectedRevision，原子提交。修改草稿会撤销旧审核。disable下架；learning开关固定类型；rollback将已有审核版本恢复为新的目录revision并留审计，不能覆盖或抹去历史。

输入JSON示例字段：`id/title/ageGroup/theme/durationSeconds/source/segments/choices?`。ageGroup只能是四个已知年龄段，durationSeconds为30–600秒，segments严格3段且各35–700字。source为`{kind:'original'|'licensed',description,license?}`，授权内容必须有授权说明。可选choices为2–3个`{id,label,ending}`，ID与标签不能重复。HTML、链接、密钥格式、联系方式、身份号码和部分明确危害内容会被基础检查拒绝；规则检查没有能力替代编辑逐篇审查。
