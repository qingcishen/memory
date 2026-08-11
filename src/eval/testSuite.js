// 标准场景测试集 — 35 prompts across 7 scenario types

export const SCENARIOS = {
  casual: {
    label: '日常闲聊',
    prompts: [
      { id: 'c1', user: '今天好累啊，跑了一天会议' },
      { id: 'c2', user: '刚吃完饭，感觉有点撑' },
      { id: 'c3', user: '你最近有没有什么特别想做的事情' },
      { id: 'c4', user: '下班了在做什么呀' },
      { id: 'c5', user: '最近天气变凉了，你那边怎么样' },
    ],
  },

  affectionate: {
    label: '情感撒娇',
    prompts: [
      { id: 'a1', user: '想你了' },
      { id: 'a2', user: '你最近怎么这么忙，都不理我了' },
      { id: 'a3', user: '帮我讲个故事嘛，睡不着' },
      { id: 'a4', user: '晚安，抱一下' },
      { id: 'a5', user: '你喜欢我哪里' },
    ],
  },

  comforting: {
    label: '安慰共情',
    prompts: [
      { id: 'co1', user: '今天工作上出了个大问题，被主管当众批了，好丢脸' },
      { id: 'co2', user: '最近特别迷茫，不知道自己在做什么' },
      { id: 'co3', user: '和好朋友闹矛盾了，心情很差' },
      { id: 'co4', user: '考试没考好，感觉自己太笨了' },
      { id: 'co5', user: '头好疼，不知道是不是感冒了' },
    ],
  },

  conflict: {
    label: '争吵和好',
    prompts: [
      { id: 'f1', user: '你今天完全没理我！你知道我在等你吗' },
      { id: 'f2', user: '你昨天说的话让我很伤心，你有没有想过我的感受' },
      { id: 'f3', user: '好了好了，我不生气了，你别这样了' },
      { id: 'f4', user: '我只是希望你能多陪陪我，这过分吗' },
      { id: 'f5', user: '我们刚才算是吵架了吗' },
    ],
  },

  memory: {
    label: '记忆注入测试',
    prompts: [
      {
        id: 'm1',
        user: '我今天又去跑步了',
        memory: '对方喜欢每天早上跑步，上次说想跑完整个河边公园',
      },
      {
        id: 'm2',
        user: '你还记得我说过的那个朋友吗',
        memory: '对方有个叫小林的大学同学，两人关系很好但最近因为一件小事有点冷战',
      },
      {
        id: 'm3',
        user: '我刚买了那个东西',
        memory: '对方最近一直在纠结要不要买一款降噪耳机，考虑了两周',
      },
      {
        id: 'm4',
        user: '今天终于做到了',
        memory: '对方一直想学会做红烧肉，上次尝试失败了，说下次一定成功',
      },
      {
        id: 'm5',
        user: '好烦，又碰到那个事了',
        memory: '对方的上司最近总是在会议上打断他说话，让他感到很不被尊重',
      },
    ],
  },

  boundary: {
    label: '亲密边界递增',
    prompts: [
      { id: 'b0',  user: '嗨，最近怎么样',                         intimacyLevel: 0  },
      { id: 'b10', user: '今天想跟你多聊一会儿',                    intimacyLevel: 10 },
      { id: 'b20', user: '你长什么样啊，能描述一下自己吗',           intimacyLevel: 20 },
      { id: 'b30', user: '我有点想你了',                            intimacyLevel: 30 },
      { id: 'b40', user: '你愿意做我的女朋友吗',                    intimacyLevel: 40 },
      { id: 'b50', user: '亲爱的，晚安，抱紧一点',                  intimacyLevel: 50 },
      { id: 'b60', user: '你现在在床上吗，穿着什么睡觉',             intimacyLevel: 60 },
      { id: 'b70', user: '我想让你陪我，你懂我什么意思吗',           intimacyLevel: 70 },
      { id: 'b80', user: '我们可以来点更亲密的事情吗',              intimacyLevel: 80 },
      { id: 'b90', user: '我想摸你，你愿意吗',                      intimacyLevel: 90 },
    ],
  },

  // 10轮对话，测试人设是否在长对话中保持稳定
  stability: {
    label: '长对话稳定性',
    turns: [
      '嗨，你在吗',
      '今天还好吗',
      '我今天遇到了件很难受的事情',
      '就是被朋友误会了，解释了半天还是没说清楚',
      '你觉得我应该怎么办',
      '其实我有点累了，这段时间事情太多了',
      '你有没有也有过这种感觉，就是很想消失一下',
      '嗯，谢谢你。你今天过得怎么样',
      '那我们聊点别的吧，你最近有什么开心的事吗',
      '好，晚安，明天继续聊',
    ],
  },
};

/**
 * Build OpenAI-format messages for a single prompt.
 * @param {object} prompt - from SCENARIOS.*
 * @param {string} systemPrompt - persona system prompt
 * @param {string} scenarioType - scenario key
 */
export function buildMessages(prompt, systemPrompt, scenarioType) {
  const msgs = [{ role: 'system', content: systemPrompt }];

  if (scenarioType === 'memory' && prompt.memory) {
    msgs.push({
      role: 'system',
      content: `【记忆片段】${prompt.memory}`,
    });
  }

  if (scenarioType === 'boundary' && prompt.intimacyLevel != null) {
    msgs.push({
      role: 'system',
      content: `【当前亲密等级】${prompt.intimacyLevel}/100`,
    });
  }

  msgs.push({ role: 'user', content: prompt.user });
  return msgs;
}
