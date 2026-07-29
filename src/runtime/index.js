// 让她"活着"的后台调度循环。
//
// reply() 只在你发消息时跑; 但她该有自己的节奏: 心情随时间回落、作息在走、偶尔生病、
// 夜里反思、想念了主动找你。这些"无对话时"的演变由 CompanionRuntime 按节拍驱动:
//   - 维护 tick: orchestrator.maintain() —— settle(心情回落) + tickActivity(作息/生病), 夜里加 reflect/story/dedupe
//   - 主动 tick: 复用 ProactiveScheduler(防打扰/冷却/作息), 决定要不要主动发一句
//
// 单进程起步 (setInterval); 纯逻辑 isNightlyDue 离线可测, 整个 runtime 可注入 mock 测。

const HOUR = 60 * 60 * 1000;

/** 本地日历日 key (YYYY-MM-DD), 带时区偏移 (分钟)。 */
export function localDayKey(now, tzOffsetMinutes = null) {
  const offset = tzOffsetMinutes == null ? 0 : Number(tzOffsetMinutes) * 60 * 1000;
  const d = new Date(now + offset);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

/** 本地小时 (0-23), 带时区偏移。 */
export function localHour(now, tzOffsetMinutes = null) {
  const offset = tzOffsetMinutes == null ? 0 : Number(tzOffsetMinutes) * 60 * 1000;
  return new Date(now + offset).getUTCHours();
}

/** 夜间维护是否该跑: 本地时间已过 nightlyHour, 且今天还没跑过。 */
export function isNightlyDue(now, lastNightlyDay, nightlyHour = 4, tzOffsetMinutes = null) {
  const today = localDayKey(now, tzOffsetMinutes);
  if (lastNightlyDay === today) return false;
  return localHour(now, tzOffsetMinutes) >= nightlyHour;
}

export class CompanionRuntime {
  /**
   * @param orchestrator 必填, 提供 maintain()
   * @param proactiveScheduler 可选, 提供 tick() (主动消息); 没有就只跑维护
 * @param options { maintainEveryMs, proactiveEveryMs, existenceEveryMs, nightlyHour, timezoneOffsetMinutes }
   */
  constructor({ orchestrator, proactiveScheduler = null, clock = () => Date.now(), options = {} } = {}) {
    if (!orchestrator) throw new Error('CompanionRuntime 需要 orchestrator');
    this.orchestrator = orchestrator;
    this.proactiveScheduler = proactiveScheduler;
    this.clock = clock;
    this.options = {
      maintainEveryMs: 15 * 60 * 1000, // 维护每 15min
      proactiveEveryMs: 30 * 60 * 1000, // 主动性检查每 30min
      existenceEveryMs: 30 * 1000, // 连续状态心跳每 30s
      nightlyHour: 4, // 凌晨 4 点跑夜间反思
      timezoneOffsetMinutes: null,
      ...options,
    };
    this._lastNightlyDay = null;
    this._timers = [];
    this._existenceInFlight = null;
  }

  /** 跑一轮维护; 到点了顺带跑夜间 reflect/story/dedupe (每天一次)。 */
  async maintainTick() {
    const now = this.clock();
    const nightly = isNightlyDue(now, this._lastNightlyDay, this.options.nightlyHour, this.options.timezoneOffsetMinutes);
    const r = await this.orchestrator.maintain({ now, nightly }).catch((e) => {
      console.error('[runtime.maintain]', e);
      return null;
    });
    if (nightly) this._lastNightlyDay = localDayKey(now, this.options.timezoneOffsetMinutes);
    return { nightly, result: r };
  }

  /** 跑一轮主动性 (有 scheduler 才跑); 返回 scheduler.tick 的结果或 null。 */
  async proactiveTick(ctx = {}) {
    if (!this.proactiveScheduler || typeof this.proactiveScheduler.tick !== 'function') return null;
    return this.proactiveScheduler.tick({ now: this.clock(), ...ctx }).catch((e) => {
      console.error('[runtime.proactive]', e);
      return null;
    });
  }

  /** 连续存在心跳；若内驱力自然越阈，仍通过 ProactiveScheduler 的硬门再投递。 */
  async existenceTick() {
    if (typeof this.orchestrator.existence?.heartbeat !== 'function') return null;
    if (this._existenceInFlight) return this._existenceInFlight;
    const now = this.clock();
    const task = (async () => {
      const result = await this.orchestrator.existence
        .heartbeat({
          now,
          // I-2: 把亲密快照传给心跳，用于性张力弧线 desire 加成。
          getIntimacy: () =>
            this.orchestrator.stateLayer?.stateLayer?.intimacy?.snapshot?.() ?? Promise.resolve(null),
        })
        .catch((error) => {
          console.error('[runtime.existence]', error);
          return null;
        });
      const decision = result?.contactDecision ?? result?.decision ?? null;
      if (decision?.contact && this.proactiveScheduler) {
        const reason =
          decision.reason?.content ??
          decision.reason?.reason ??
          (typeof decision.reason === 'string' ? decision.reason : null);
        await this.proactiveTick({
          now,
          existenceDecision: decision,
          ...(reason ? { reason } : {}),
        });
      }
      return result;
    })();
    this._existenceInFlight = task.finally(() => {
      this._existenceInFlight = null;
    });
    return this._existenceInFlight;
  }

  /** 启动后台定时器 (两条独立节拍)。 */
  start() {
    if (this._timers.length) return;
    this._timers.push(setInterval(() => this.maintainTick(), this.options.maintainEveryMs));
    if (this.orchestrator.existence) {
      this.existenceTick();
      this._timers.push(
        setInterval(() => this.existenceTick(), this.options.existenceEveryMs),
      );
    }
    if (this.proactiveScheduler) {
      this._timers.push(setInterval(() => this.proactiveTick(), this.options.proactiveEveryMs));
    }
    // 防止定时器拖住进程退出 (Node): 允许 unref
    for (const t of this._timers) if (typeof t.unref === 'function') t.unref();
    return this;
  }

  stop() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
  }
}
