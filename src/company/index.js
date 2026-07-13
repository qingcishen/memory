/**
 * Company System · 角色公司的固定事实 + 持久项目线视图。
 *
 * 公司身份、组织、人员和项目定义来自 CompanionConfig.company（不可随口改名）；
 * 项目的每日进展复用 story_lines 持久化，避免再造一套互相打架的剧情数据库。
 */

import { sanitizeForPrompt } from '../promptSafety.js';

export function normalizeCompany(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const people = uniqueBy(raw.people, 'name').map((person) => ({
    name: text(person.name),
    title: text(person.title),
    department: text(person.department),
    relationship: text(person.relationship),
    personality: text(person.personality),
    workStyle: text(person.workStyle ?? person.work_style),
  })).filter((person) => person.name);
  const departments = uniqueBy(raw.departments, 'id').map((department) => ({
    id: text(department.id),
    name: text(department.name),
    lead: text(department.lead),
    headcount: positiveInt(department.headcount),
    responsibilities: stringList(department.responsibilities),
  })).filter((department) => department.id && department.name);
  const businessLines = uniqueBy(raw.businessLines ?? raw.business_lines, 'id').map((line) => ({
    id: text(line.id),
    name: text(line.name),
    description: text(line.description),
    revenueModel: text(line.revenueModel ?? line.revenue_model),
  })).filter((line) => line.id && line.name);
  const projects = uniqueBy(raw.projects, 'id').map((project) => ({
    id: text(project.id),
    name: text(project.name),
    status: text(project.status) || 'planning',
    owner: text(project.owner),
    department: text(project.department),
    client: text(project.client),
    description: text(project.description),
    currentMilestone: text(project.currentMilestone ?? project.current_milestone),
    nextMilestone: text(project.nextMilestone ?? project.next_milestone),
    risk: text(project.risk),
  })).filter((project) => project.id && project.name);
  const locations = (Array.isArray(raw.locations) ? raw.locations : []).map((location) => ({
    name: text(location?.name),
    city: text(location?.city),
    address: text(location?.address),
    purpose: text(location?.purpose),
  })).filter((location) => location.name);

  return {
    id: text(raw.id) || 'company',
    name: text(raw.name),
    legalName: text(raw.legalName ?? raw.legal_name ?? raw.name),
    shortName: text(raw.shortName ?? raw.short_name ?? raw.name),
    industry: text(raw.industry),
    foundedYear: positiveInt(raw.foundedYear ?? raw.founded_year),
    headquarters: text(raw.headquarters),
    ownership: text(raw.ownership),
    scale: text(raw.scale),
    stage: text(raw.stage),
    mission: text(raw.mission),
    description: text(raw.description),
    leader: {
      name: text(raw.leader?.name),
      title: text(raw.leader?.title),
      responsibilities: stringList(raw.leader?.responsibilities),
      managementStyle: text(raw.leader?.managementStyle ?? raw.leader?.management_style),
    },
    officeHours: {
      timezone: text(raw.officeHours?.timezone ?? raw.office_hours?.timezone) || 'Asia/Shanghai',
      weekdays: stringList(raw.officeHours?.weekdays ?? raw.office_hours?.weekdays),
      start: text(raw.officeHours?.start ?? raw.office_hours?.start) || '09:30',
      end: text(raw.officeHours?.end ?? raw.office_hours?.end) || '18:00',
    },
    businessLines,
    departments,
    people,
    projects,
    locations,
    rules: stringList(raw.rules),
  };
}

/** StoryEngine 固定卡司：公司人物进入同一个知识图谱，职位不再漂移。 */
export function companyCast(company) {
  const c = normalizeCompany(company);
  if (!c) return [];
  return c.people.map((person) => ({
    name: person.name,
    role: roleKey(person.title || person.department || 'colleague'),
    closeness: relationshipCloseness(person.relationship),
  }));
}

/**
 * 给 StoryEngine 的公司项目硬事实。故事拍可以推进，但不能改变项目身份、负责人、
 * 客户和经营边界；这样夜间自动推进与公司页、聊天使用的是同一套事实。
 */
export function companyStoryFacts(company, line = {}) {
  const c = normalizeCompany(company);
  if (!c) return [];
  const storylineId = text(line.id ?? line.storyline_key);
  const project = c.projects.find((item) => item.id === storylineId);
  if (!project) return [];
  const owner = c.people.find((person) => person.name === project.owner);
  return [
    `公司：${c.name}；负责人：${c.leader.name}（${c.leader.title}）`,
    `项目：${project.name}；当前阶段：${project.status}；项目负责人：${project.owner || '未指定'}`,
    project.department ? `负责部门：${project.department}` : '',
    project.client ? `客户/对象：${project.client}` : '',
    project.description ? `项目范围：${project.description}` : '',
    project.currentMilestone ? `配置基线进展：${project.currentMilestone}` : '',
    project.nextMilestone ? `配置基线下一节点：${project.nextMilestone}` : '',
    project.risk ? `已知风险：${project.risk}` : '',
    owner ? `${owner.name}的固定身份：${owner.title}，${owner.department}；工作方式：${owner.workStyle}` : '',
    ...c.rules.map((rule) => `经营边界：${rule}`),
    '以上是硬事实。只推进一个合理的小节点；禁止新增未记录的合同、营收、融资、裁员、事故、客户真名或人员任免。',
  ].filter(Boolean);
}

/** 把 story_lines 的实时进度合并进配置项目，供 UI 和 prompt 共用。 */
export function buildCompanySnapshot(company, storyLines = [], { now = Date.now(), currentActivity = '' } = {}) {
  const c = normalizeCompany(company);
  if (!c) return null;
  const storyById = new Map((storyLines || []).map((line) => [String(line.storyline_key ?? line.id ?? ''), line]));
  const projects = c.projects.map((project) => {
    const story = storyById.get(project.id);
    return {
      ...project,
      stage: story?.stage ?? project.status,
      lastBeat: text(story?.last_beat) || project.currentMilestone,
      nextBeat: text(story?.next_beat_hint) || project.nextMilestone,
      lastBeatAt: story?.last_beat_at ?? null,
      sharing: Number(story?.last_beat_sharing) || 0,
      freshness: projectFreshness(story?.last_beat_at, now),
    };
  });
  const office = officeStatus(c.officeHours, now);
  const activeProjects = projects.filter((project) => !['closed', 'done', 'cancelled'].includes(project.stage));
  const priorities = activeProjects
    .slice()
    .sort((a, b) => projectPriority(b) - projectPriority(a))
    .slice(0, 3)
    .map((project, index) => ({
      rank: index + 1,
      projectId: project.id,
      projectName: project.name,
      owner: project.owner,
      action: project.nextBeat || project.currentMilestone || project.description,
      risk: project.risk,
      stage: project.stage,
    }));
  const activity = text(currentActivity);
  return {
    ...c,
    projects,
    operations: {
      ...office,
      currentActivity: activity,
      workMode: workMode(activity, office.open),
      todayFocus: activity && isWorkActivity(activity)
        ? activity
        : priorities[0]?.action || '暂无待推进事项',
      priorities,
      activeProjectCount: activeProjects.length,
      updatedAt: new Date(now).toISOString(),
    },
  };
}

/** 独立高显著度公司事实槽。只在工作相关对话里展开细节，平时作为防穿帮底座。 */
export function companyToPrompt(company, { storySnapshot = null, currentActivity = '', userMessage = '', now = Date.now() } = {}) {
  const c = normalizeCompany(company);
  if (!c?.name) return '';
  const workTurn = /(公司|工作|上班|开会|项目|客户|团队|同事|董事长|产品|业务|清弈)/.test(String(userMessage));
  const storyLines = storySnapshot?.lines ?? [];
  const snapshot = buildCompanySnapshot(c, storyLines, { now, currentActivity });
  const people = workTurn
    ? snapshot.people.slice(0, 8).map((person) => `${person.name}（${person.title}${person.department ? `，${person.department}` : ''}）`).join('、')
    : '';
  const business = snapshot.businessLines.map((line) => `${line.name}（${line.description}）`).join('、');
  const projects = workTurn
    ? snapshot.projects.slice(0, 5).map((project) =>
        `${project.name}[${project.stage}]：${project.lastBeat || project.description}${project.nextBeat ? `；下一步 ${project.nextBeat}` : ''}`
      ).join('\n- ')
    : '';
  const lines = [
    '【公司系统·确定事实】',
    `${snapshot.name}${snapshot.legalName && snapshot.legalName !== snapshot.name ? `（全称：${snapshot.legalName}）` : ''}，${snapshot.industry}，总部在${snapshot.headquarters}。${snapshot.ownership}；规模${snapshot.scale}。`,
    `${snapshot.leader.name || '她'}的职务是${snapshot.leader.title || '负责人'}。职责：${snapshot.leader.responsibilities.join('、') || '公司经营与重大决策'}。`,
    workTurn && business ? `主营业务：${business}。` : '',
    people ? `固定同事：${people}。人物姓名、职位、部门不可擅自更换。` : '',
    projects ? `当前项目：\n- ${projects}` : '',
    workTurn ? `公司当地时间 ${snapshot.operations.localTime}（${snapshot.operations.phaseLabel}）；她当前状态：${snapshot.operations.workMode}。办公时间不等于她一定身在公司。` : '',
    workTurn && currentActivity ? `此刻工作状态：${currentActivity}。只有当前活动确实在公司/工作时，才把会议、工位、文件等当成正在发生。` : '',
    workTurn && snapshot.rules.length ? `固定经营约束：${snapshot.rules.join('；')}` : '',
    '公司档案是确定事实；故事线是已经发生的项目进度。禁止凭空新增公司名、职位、同事、客户合同或营收数字；没有记录的细节就模糊带过。',
    workTurn
      ? '本轮正在聊公司，可以用具体的人名、项目和进展自然回答，但别像念组织架构或商业计划书。'
      : '本轮若与工作无关，公司只作为身份底座，不要主动把话题硬拐到公司。',
  ];
  return lines.map(sanitizeForPrompt).filter(Boolean).join('\n');
}

function officeStatus(hours, now) {
  const timeZone = hours?.timezone || 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(now));
  const value = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = value('weekday');
  const minute = Number(value('hour')) * 60 + Number(value('minute'));
  const [startH, startM] = String(hours?.start || '09:30').split(':').map(Number);
  const [endH, endM] = String(hours?.end || '18:00').split(':').map(Number);
  const weekdays = hours?.weekdays?.length ? hours.weekdays : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const startMinute = startH * 60 + startM;
  const endMinute = endH * 60 + endM;
  const workday = weekdays.includes(weekday);
  const open = workday && minute >= startMinute && minute < endMinute;
  let phase = 'off';
  let phaseLabel = workday ? '非办公时段' : '休息日';
  if (workday && minute < startMinute) { phase = 'before-work'; phaseLabel = '上班前'; }
  else if (open && minute < 12 * 60) { phase = 'morning'; phaseLabel = '上午办公'; }
  else if (open && minute < 14 * 60) { phase = 'midday'; phaseLabel = '午间时段'; }
  else if (open) { phase = 'afternoon'; phaseLabel = '下午办公'; }
  else if (workday) { phase = 'after-work'; phaseLabel = '下班后'; }
  return {
    open,
    label: open ? '营业中' : '非办公时段',
    phase,
    phaseLabel,
    weekday,
    localTime: `${value('hour')}:${value('minute')}`,
  };
}

function projectPriority(project) {
  const stageScore = { climax: 50, rising: 40, setup: 30, planning: 20, cooldown: 10 }[project.stage] ?? 0;
  return stageScore + (project.risk ? 4 : 0) + (project.nextBeat ? 2 : 0);
}

function projectFreshness(lastBeatAt, now) {
  if (!lastBeatAt) return { kind: 'baseline', label: '配置基线', ageDays: null };
  const timestamp = new Date(lastBeatAt).getTime();
  if (!Number.isFinite(timestamp)) return { kind: 'baseline', label: '配置基线', ageDays: null };
  const ageDays = Math.max(0, Math.floor((now - timestamp) / 86400000));
  if (ageDays === 0) return { kind: 'today', label: '今日更新', ageDays };
  if (ageDays <= 3) return { kind: 'recent', label: `${ageDays} 天前更新`, ageDays };
  return { kind: 'stale', label: `${ageDays} 天未更新`, ageDays };
}

function isWorkActivity(activity) {
  return /(公司|工作|上班|开会|项目|客户|汇报|审|经营|数据|面试|出差)/.test(activity);
}

function workMode(activity, officeOpen) {
  if (activity && isWorkActivity(activity)) return '正在工作';
  if (officeOpen) return '办公时间';
  return '私人时间';
}

function uniqueBy(items, key) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((item) => {
    const value = text(item?.[key]);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function stringList(value) {
  return (Array.isArray(value) ? value : []).map(text).filter(Boolean);
}

function text(value) {
  return String(value ?? '').trim();
}

function positiveInt(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function roleKey(value) {
  const role = String(value || 'colleague');
  if (/首席技术官|\bcto\b/i.test(role)) return 'cto';
  if (/执行副总|总裁办/.test(role)) return 'executive_partner';
  if (/交付|客户成功/.test(role)) return 'delivery_director';
  if (/企业业务|销售|商务/.test(role)) return 'business_director';
  return role.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'colleague';
}

function relationshipCloseness(value) {
  const relation = String(value || '');
  if (/亲信|多年|信任|好友/.test(relation)) return 0.82;
  if (/核心|直接汇报|搭档/.test(relation)) return 0.7;
  return 0.55;
}
