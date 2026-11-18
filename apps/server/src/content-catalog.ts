import type { AgeGroup } from './types.js';

export type StoryTheme = '友谊' | '勇气' | '情绪' | '好奇' | '责任' | '关怀' | '睡前';
export type StoryChoice = { id: string; label: string; ending: string };
export type StoryDefinition = {
  id: string;
  title: string;
  ageGroup: AgeGroup;
  theme: StoryTheme;
  durationSeconds: number;
  source: string;
  publication: 'published';
  revision?: number;
  segments: readonly [string, string, string];
  choices?: readonly StoryChoice[];
};

/** Texts were written for this project. Fixed choices change the ending, never the safety boundary. */
export const ORIGINAL_STORIES: readonly StoryDefinition[] = [
  {
    id: 'small-cloud', title: '小云朵的慢慢路', ageGroup: '3-5', theme: '睡前', durationSeconds: 60,
    source: '项目原创', publication: 'published', segments: [
      '傍晚，小云朵跟着风走。大云朵一下就飘过了山，它还在树梢上。它有点着急。风轻轻说：“今天没有比赛，我们慢慢走。”',
      '小云朵放慢脚步，看见一片弯弯的叶子。叶子接住一滴水，像捧着一颗亮珠子。小云朵原来没有看过这么小的东西。',
      '天暗了，小云朵停在山边。小鸟回了窝，叶子也安静下来。它不用赶上谁。风很轻，明天的路可以明天再走。故事讲完了。',
    ],
  },
  {
    id: 'rabbit-red-cup', title: '小兔的红杯子', ageGroup: '3-5', theme: '关怀', durationSeconds: 90,
    source: '项目原创', publication: 'published', segments: [
      '小兔有一只红杯子。下午，小熊来玩，找不到自己的水杯。小兔把红杯子放到桌上，又停住了：它也想喝水。',
      '小兔想了一会儿。可以请大人找一只干净杯子，也可以陪小熊一起去找。两种办法都不用谁一直忍着口渴。你想选“找杯子”还是“一起找”？',
      '大人拿来一只干净杯子。小兔和小熊各喝了几口水，再回去搭积木。照顾朋友，也可以照顾自己。故事讲完了。',
    ], choices: [
      { id: 'ask', label: '找杯子', ending: '小兔请大人拿来一只干净杯子。小熊说：“谢谢你帮我想办法。”两只杯子并排站在桌上，大家都喝到了水，再回去搭积木。故事讲完了。' },
      { id: 'search', label: '一起找', ending: '小兔陪小熊去问大人，原来小熊的杯子放在书包旁。两人各自喝了水。帮忙不一定要把自己的东西全让出去，一起找办法也很好。故事讲完了。' },
    ],
  },
  {
    id: 'snail-first-step', title: '小蜗牛先走一步', ageGroup: '3-5', theme: '勇气', durationSeconds: 60,
    source: '项目原创', publication: 'published', segments: [
      '小蜗牛想去看院子里的黄花。门口的石头看起来好高。它缩回壳里，说：“我怕爬不过去。”妈妈陪它坐了一小会儿。',
      '妈妈说：“先看看石头旁边。”那里有一条平平的小路。小蜗牛伸出触角，只往前挪了一点。没有人催它一次走完。',
      '小蜗牛沿着小路来到黄花边。花香很淡，它闻到了。它记住了今天的第一小步。以后害怕时，也可以先找一条适合自己的路。故事讲完了。',
    ],
  },
  {
    id: 'kitten-wind', title: '小猫和气呼呼的风', ageGroup: '3-5', theme: '情绪', durationSeconds: 90,
    source: '项目原创', publication: 'published', segments: [
      '小猫搭的纸房子倒了。它皱着眉，把爪子握得紧紧的。它想把纸都推开。爸爸说：“你很生气，我们先把手放在膝盖上。”',
      '小猫没有马上高兴。它和爸爸慢慢呼了一口气，又喝了一点水。等手不那么紧了，它指着倒下的墙说：“这块又掉了。”',
      '爸爸帮小猫把墙底折宽一点。小猫重新搭了一块，剩下的明天再搭。生气可以说出来，纸房子可以慢慢修。故事讲完了。',
    ],
  },
  {
    id: 'duck-shadow', title: '小鸭子的影子朋友', ageGroup: '3-5', theme: '好奇', durationSeconds: 60,
    source: '项目原创', publication: 'published', segments: [
      '太阳照进院子，小鸭脚边出现一个黑黑的形状。它走一步，那个形状也走一步。小鸭问奶奶：“它为什么总跟着我？”',
      '奶奶让它举起翅膀，地上的形状也举了起来。小鸭又躲到树荫里，形状变得不明显了。它发现，光照过来的地方才看得清。',
      '小鸭回到阳光里，向自己的影子挥挥翅膀。奶奶说：“这是光被你挡住后留下的影子。”小鸭带着一个新发现回家了。故事讲完了。',
    ],
  },
  {
    id: 'missing-blue-pencil', title: '蓝铅笔去了哪里', ageGroup: '6-8', theme: '友谊', durationSeconds: 120,
    source: '项目原创', publication: 'published', segments: [
      '阿禾准备画海，蓝铅笔却不见了。他看见小满桌上也有一支蓝铅笔，差一点就说“你拿了我的”。他先停住，问：“你见过我的铅笔吗？”',
      '小满说这是自己的，还指给阿禾看笔尾的名字。阿禾有点不好意思。现在可以说“我刚才误会了”，也可以先说“一起找找”。你想选哪句？',
      '阿禾在自己的画册下面找到了铅笔。他告诉小满刚才有点着急，小满点点头。两人接着画：一片蓝海，一条黄色的小船。故事讲完了。',
    ], choices: [
      { id: 'apology', label: '我刚才误会了', ending: '阿禾说：“我刚才误会了，对不起。”小满陪他翻开画册，蓝铅笔就在下面。阿禾下次着急时，准备先问清楚。两人继续画海和小船。故事讲完了。' },
      { id: 'together', label: '一起找找', ending: '两人一起挪开画册，找到了蓝铅笔。阿禾补上一句：“我刚才差点误会你，对不起。”小满说：“现在找到了。”他们把两支铅笔的名字都写清楚了。故事讲完了。' },
    ],
  },
  {
    id: 'paper-boat-test', title: '纸船的第二次出发', ageGroup: '6-8', theme: '好奇', durationSeconds: 120,
    source: '项目原创', publication: 'published', segments: [
      '米米在浅水盆里试纸船。第一只很快歪了，她说：“我不会做。”哥哥拿来一张纸，提议只改一处：把两边折得一样宽。',
      '第二只船浮得久一点，后来还是湿了。米米画了两条记录：第一只很快歪，第二只慢一点。她发现失败也能告诉自己哪里变了。',
      '她把纸船晾在托盘里，收好水盆。下一次可以换纸试，但今天先到这里。实验不是每次都成功，而是每次多知道一点。故事讲完了。',
    ],
  },
  {
    id: 'quiet-seat', title: '可以安静一会儿的座位', ageGroup: '6-8', theme: '情绪', durationSeconds: 90,
    source: '项目原创', publication: 'published', segments: [
      '运动会结束后，小乔坐在操场边。朋友问她为什么不说话，她摇摇头。她跑丢了一只鞋，还没缓过来。老师陪她坐下，没有马上问很多问题。',
      '过了一会儿，小乔说：“我现在不想讲。”老师回答：“好。你可以先喝水，等想说了再说。”朋友坐在旁边，给她留了一点位置。',
      '小乔后来讲起那只跑掉的鞋，自己也笑了一下。她知道了，朋友可以陪着，也可以给人安静的时间。安静并不表示不喜欢谁。故事讲完了。',
    ],
  },
  {
    id: 'library-bell', title: '图书角的小铃铛', ageGroup: '6-8', theme: '责任', durationSeconds: 120,
    source: '项目原创', publication: 'published', segments: [
      '班里的图书角挂着一个小铃铛，提醒大家还书。阿乐借的书被雨水弄湿了一角。他把书放回书包，想等没人注意时再还。',
      '到了还书日，阿乐把湿角指给老师看。他说自己没有收好。老师和他一起铺平书页，再请管理员判断能不能修，阿乐也把借书卡交了出来。',
      '书修好后仍留着浅浅的痕迹。阿乐做了一个书袋，下雨时先把书装进去。他没有把错误藏起来，也学会了下一次怎么照顾书。故事讲完了。',
    ],
  },
  {
    id: 'moon-wait', title: '月亮不用等我', ageGroup: '6-8', theme: '睡前', durationSeconds: 90,
    source: '项目原创', publication: 'published', segments: [
      '小宁睡前总想把今天的事都想完。窗外的月亮圆圆的，她问妈妈：“如果我睡了，今天会不会还没结束？”妈妈把她的本子放在床边。',
      '小宁在本子上记了一件想留到明天的事：给小草浇水。别的念头来了，也不用一个个追着跑。妈妈说：“今天做过的事，不会因为休息就消失。”',
      '房间渐渐安静。月亮还在窗外，小宁已经不必等着它。需要休息的时候，明天可以替今天接着走。这个故事到这里结束，晚安。',
    ],
  },
  {
    id: 'bridge-team', title: '一座桥，两种办法', ageGroup: '9-12', theme: '友谊', durationSeconds: 150,
    source: '项目原创', publication: 'published', segments: [
      '小组要用纸搭桥。安然想折三角形支架，阿启想把桥面卷厚。两人都说自己的办法更好，桌上的纸却一直没有动。组员提议先各做一个小样。',
      '第一次测试，三角支架站得稳，厚桥面不容易弯。安然准备选“合并方案”，阿启想“再测一次”。两种选择都需要把结果写下来。你想选哪一种？',
      '大家把支架和桥面合在一起，用相同的积木比较承重。桥撑住了更多积木。小组交上的不只是作品，还有两次测试记录。意见不同也能成为合作的材料。故事讲完了。',
    ], choices: [
      { id: 'combine', label: '合并方案', ending: '他们组合了三角支架和厚桥面，按同样方式放积木，桥更稳了。安然在记录中写上每个人的贡献。好办法不必只属于一个人。故事讲完了。' },
      { id: 'again', label: '再测一次', ending: '大家用同样数量的纸再测一次，确认了各自的优点，然后决定把两种办法组合。阿启说：“再试一次让我更有把握。”桥和记录一起完成了。故事讲完了。' },
    ],
  },
  {
    id: 'wrong-message', title: '没发出去的那条消息', ageGroup: '9-12', theme: '情绪', durationSeconds: 150,
    source: '项目原创', publication: 'published', segments: [
      '可岚看见朋友没有回复，以为自己被故意忽略。她打了一大段责怪的话，手指停在发送键上。她先把手机放下，去洗了一把脸。',
      '回来后，可岚把消息改成一句：“你刚才没回复，我有点担心，我们约的事还算数吗？”朋友后来解释，他正在帮家里搬东西，没看手机。',
      '可岚没有假装自己没难过，也没有把猜测当事实。两人重新约好时间。那段没有发出去的消息提醒她：感受可以是真的，猜想仍需要核对。故事讲完了。',
    ],
  },
  {
    id: 'seed-record', title: '窗台上的空白格', ageGroup: '9-12', theme: '好奇', durationSeconds: 150,
    source: '项目原创', publication: 'published', segments: [
      '晓舟每天记录豆苗的高度。周末出门，他忘了测两天。回家后，本子里留下两个空格。他想照着前后的数字补上，看起来会完整一点。',
      '姐姐说：“可以估计，但要写明那是估计。”晓舟最后把两格标为“未测”，旁边记下忘测的原因。他用尺子继续量，数据没有因此停止。',
      '展示时，同学问起空格，晓舟如实说明。他们讨论了记录提醒的办法。一本可信的记录可以有空白，下一次改进从知道空白在哪里开始。故事讲完了。',
    ],
  },
  {
    id: 'stage-one-line', title: '先说好这一句', ageGroup: '9-12', theme: '勇气', durationSeconds: 120,
    source: '项目原创', publication: 'published', segments: [
      '小屿要在班会介绍图书角。他一想到站起来就心跳很快。老师没有要求他马上背完全文，只请他选出最想让同学听到的一句。',
      '小屿对着空椅子说了一次，又对朋友说了一次。他把第一句话写在卡片上。正式介绍时，他仍然紧张，但知道卡片就在手里。',
      '那一天，小屿停顿了两次，也讲完了自己的推荐。回座位后，他记下有效的办法：小练习、提示卡和允许停顿。勇敢可以带着紧张一起出现。故事讲完了。',
    ],
  },
  {
    id: 'night-notebook', title: '明天那一页', ageGroup: '9-12', theme: '睡前', durationSeconds: 120,
    source: '项目原创', publication: 'published', segments: [
      '临睡前，沐沐还在想明天的小组展示。她想把每一种意外都想一遍，越想越清醒。爸爸请她写下真正能准备的一件事：把资料放进书包。',
      '沐沐检查了资料，把还没确定的事写在另一页，标上“明天再看”。她没有解决所有可能发生的事，但把眼前能做的步骤做完了。',
      '灯关了，书包安静地靠在椅子边。明天还没有来到，今晚可以先休息。那页纸留在本子里，不需要她一直盯着。故事讲完了。',
    ],
  },
  {
    id: 'boundary-ticket', title: '那张多出来的票', ageGroup: '13-14', theme: '友谊', durationSeconds: 180,
    source: '项目原创', publication: 'published', segments: [
      '林朔答应帮同学整理活动报名。同学又请他代写整份介绍，说朋友就应该帮忙。林朔有自己的安排，担心拒绝会让关系变坏。',
      '他可以选“说明边界”：讲清自己能帮到哪里；也可以选“约好时间”：把有限的一段时间讲明白。两种办法都不用替别人承担全部任务。你想选哪一种？',
      '林朔说明自己只负责整理报名，可以留十分钟一起讨论介绍。同学起初有点失望，后来找了其他人分工。关系可以容纳不同的需要，也需要清楚的约定。故事讲完了。',
    ], choices: [
      { id: 'boundary', label: '说明边界', ending: '林朔说：“报名我会按约定完成，整份介绍需要你自己写。我能帮你看看结构。”同学分好了任务。把边界说清楚，帮助才更容易持续。故事讲完了。' },
      { id: 'time', label: '约好时间', ending: '林朔提出一起讨论十分钟，之后去完成自己的安排。他们把这十分钟用来列提纲，介绍仍由同学完成。双方都知道了约定的范围。故事讲完了。' },
    ],
  },
  {
    id: 'ranking-outside', title: '排名之外的一条线', ageGroup: '13-14', theme: '情绪', durationSeconds: 180,
    source: '项目原创', publication: 'published', segments: [
      '许遥看到测验排名下降，觉得之前的努力都没有用。回家后，她不想听“下次一定考好”。姐姐先陪她坐了一会儿，等她自己把试卷拿出来。',
      '她们发现错误分成两类：一道没读完条件，一道还没掌握。许遥只选了其中一种来练，把“必须马上追回排名”改成“先核对题目条件”。',
      '一周后，许遥做题时少漏了一处条件。成绩还会变化，这条进步线却可以记录。她没有因为一次排名就否认努力，也没有把心情交给下一次分数决定。故事讲完了。',
    ],
  },
  {
    id: 'rumor-check', title: '转发之前的三分钟', ageGroup: '13-14', theme: '好奇', durationSeconds: 150,
    source: '项目原创', publication: 'published', segments: [
      '群里传来一张截图，说学校要取消社团。亦辰很着急，准备转发。朋友提醒他先看看消息来自哪里。截图没有日期，也没有完整通知。',
      '亦辰去问社团老师。原来只是一个教室临时调整，活动照常。他把老师允许公开的安排发回群里，也说明旧截图还没有来源。',
      '有人说他太认真，亦辰没有争论，只留下能核对的信息。暂停三分钟没有耽误重要消息，却减少了一次误传。好奇也包括问一句“我怎么知道”。故事讲完了。',
    ],
  },
  {
    id: 'team-admission', title: '我漏掉的那一页', ageGroup: '13-14', theme: '责任', durationSeconds: 180,
    source: '项目原创', publication: 'published', segments: [
      '小组展示前，周澈发现自己漏做一页资料。他想把原因推给文件没同步，但组员正在依赖这页。周澈告诉大家：“这一页我没完成，需要补救。”',
      '大家判断剩下的时间，只保留必要图表，由周澈补资料，另一位同学检查来源。周澈记下分工，没有要求别人替他隐瞒错误。',
      '展示完成后，小组加了一次提前检查。周澈仍要承担自己漏做的后果，也得到了修正的机会。承认错误不是最后一步，后面还有具体的行动。故事讲完了。',
    ],
  },
  {
    id: 'rest-permission', title: '允许今天到这里', ageGroup: '13-14', theme: '睡前', durationSeconds: 150,
    source: '项目原创', publication: 'published', segments: [
      '舒言关掉书本，又打开，觉得没多做两页就不安心。桌边的清单已经划掉大半，剩下的不是今晚必须完成。她却把休息看成落后。',
      '她重新圈出明天优先的一项，和家人确认需要调整的安排。没完成的事项被写清楚，已经完成的也没有被抹掉。她给自己定下今晚的结束点。',
      '书本合上了，任务还在，但不用今夜全部完成。休息也是安排中的一部分。舒言留给明天一点空间，也让今天在这里结束。这个故事讲完了。',
    ],
  },
];

export function storyCatalog(ageGroup?: AgeGroup, stories: readonly StoryDefinition[] = ORIGINAL_STORIES) {
  return stories.filter(story => !ageGroup || story.ageGroup === ageGroup).map(({ id, title, ageGroup: age, theme, durationSeconds, source, publication, choices, revision }) => ({
    id, title, ageGroup: age, theme, durationSeconds, source, publication, segments: 3,
    interactive: !!choices?.length, revision: revision || 1,
  }));
}
