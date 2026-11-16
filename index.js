/**
 * DeepSight 深度推理研究法 · Host 工具插件
 *
 * 只做方法论里**算不住、也守不住**的那一小块：证据等级与行动建议之间的硬约束。
 *
 *   deepsight_contract —— 开跑前锁定本次研究的验收契约（框架 / 模式 / 阈值 / 强制审查）
 *   deepsight_audit    —— 提交结论账本，返回确定的占比、退回、封顶、刹车与 Council 触发判定
 *   guard(present)     —— 出口闸门：判定为 block 时拒绝交付，使 [C] 级结论无法直接进入行动建议
 *
 * 框架的定义、对抗模板、约束链等知识仍在 skill 里按需加载，不重复进本文件。
 *
 * @module dsh-deepsight
 */

import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const name = 'deepsight'
const inject = ['tools']

/** 八套框架：key → 中文名 + 信号词（供 auto 路由）。 */
const FRAMEWORKS = {
	investment: { label: '投资研究', signals: ['估值', '护城河', '安全边际', '标的', '尽调', '投资'] },
	technology: { label: '技术评估', signals: ['技术路线', 'trl', '量产', '材料', '工艺', '专利', '可行性'] },
	strategy: { label: '战略转型', signals: ['企业战略', '数字化转型', '战略规划', '转型', '十五五', '规划'] },
	market: { label: '市场机会', signals: ['tam', '赛道选择', '进入策略', '市场规模', '新市场', '区域扩张'] },
	startup: { label: '创业评估', signals: ['mvp', 'pmf', '融资', '创业', '单位经济'] },
	industry: { label: '行业研究', signals: ['产业链', '竞争格局', '行业', '价值链', '趋势'] },
	organization: { label: '组织设计', signals: ['组织架构', '变革', '激励', '人才', '岗位'] },
	platform: { label: '平台/生态', signals: ['网络效应', '多边市场', '平台', '生态', '赢家通吃'] }
}

/** Phase 0.0 战略决策强制审查的信号词。 */
const PIVOT_SIGNALS = ['转型', '重启', 'pivot', '变成', '合并', '拆分', '新业务线', '品牌重塑', '商业模式切换']

/** 证据等级的三档含义，随契约一起返回，避免模型自创口径。 */
const TIER_MARKS = [
	{ tier: 'A', meaning: '[A-验证] 搜索与推理双重支持，外部独立来源可查证；利益相关方自我确认最高只能 [B]' },
	{ tier: 'B', meaning: '[B-推理] 推理链产出、逻辑自洽，但未经独立外部验证' },
	{ tier: 'C', meaning: '[C-推断] 从 B 级推导的次级结论，或 Fermi 估算 / 经验类推' }
]

const GLOBAL_KEY = '__global__'

/**
 * 包内 skill 目录。用 import.meta.url 解析，所以 link 安装与 registry 安装都成立，
 * 不再依赖任何外部绝对路径。
 */
const SKILL_DIR = fileURLToPath(new URL('./skills/deepsight/', import.meta.url))

/**
 * 给模型看的 skill 描述。上游 frontmatter 的 description 提到 Firecrawl 等 DSH 中不存在的搜索工具，
 * 这里改写为与 DSH 实际能力一致的说法；正文仍按上游原样分发。
 */
const SKILL_DESCRIPTION =
	'DeepSight 深度推理研究法完整流程：Phase 0 路由（八套框架按决策落点选一）→ Phase 1 四步递进（约束追问、搜索验证、对抗审查、冲突闭环、证据分级）→ Phase 2 多厂商 Council 交叉验证 → Phase 3 报告交付。含证据分级口径、决策刹车与十四类常见陷阱。适用于需要因果推理而非事实检索的深度分析。'

/** 读包内 SKILL.md，拆出 frontmatter 与正文。 */
function loadSkill() {
	const file = join(SKILL_DIR, 'SKILL.md')
	const raw = readFileSync(file, 'utf8')
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
	const front = match === null ? '' : match[1]
	// frontmatter 后面通常还跟一个空行，去掉前导换行，正文从标题开始
	const body = (match === null ? raw : match[2]).replace(/^(?:\r?\n)+/, '')
	const name = /^name:\s*(.+?)\s*$/m.exec(front)?.[1] ?? 'deepsight'
	const whenToUse = /^whenToUse:\s*(.+?)\s*$/m.exec(front)?.[1]
	return { name, body, whenToUse, path: file }
}

/** runId → 契约；sessionId → 最近一次 runId；sessionId → 最近一次判定。 */
const runs = new Map()
const sessionRuns = new Map()
const latestVerdict = new Map()

/**
 * 账本目录解析顺序：DEEPSIGHT_LEDGER_DIR →（兼容旧名）DSH_DEEPSIGHT_DIR → $DSH_HOME/deepsight。
 *
 * 对外文档只写 DEEPSIGHT_LEDGER_DIR：`DSH_` 前缀是 DSH 的保留命名空间，只允许启动环境设置，
 * 写进 $DSH_HOME/.env 会导致 DSH 拒绝启动（only the launching environment may set）。
 */
async function resolveLedgerDir() {
	const explicit = process.env.DEEPSIGHT_LEDGER_DIR ?? process.env.DSH_DEEPSIGHT_DIR
	if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
	return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'deepsight')
}

/** 账本与趋势笔记的落点。 */
async function resolveLedgerPath() {
	const dir = await resolveLedgerDir()
	return {
		dir,
		file: join(dir, 'deepsight-ledger.jsonl'),
		summary: join(dir, 'DeepSight-审计趋势.md')
	}
}

/** 追加一行账本。写失败不抛，用返回值报告，判决结果不受影响。 */
async function appendLedger(value) {
	const { file } = await resolveLedgerPath()
	const record = {
		at: new Date().toISOString(),
		runId: value.runId,
		total: value.total,
		countsA: value.countsA,
		countsB: value.countsB,
		countsC: value.countsC,
		pctA: value.pctA,
		pctB: value.pctB,
		pctC: value.pctC,
		tierCap: value.tierCap,
		diversityD: value.diversityD,
		returnForRegrade: value.returnForRegrade,
		cTierInRange: value.cTierInRange,
		councilTriggered: value.councilTriggered,
		blockedClaims: value.blockedClaims,
		openConflicts: value.openConflicts,
		actionClaimCount: value.actionClaimCount,
		verdict: value.verdict
	}
	const run = value.runId === '' ? undefined : runs.get(value.runId)
	if (run) {
		record.framework = run.framework
		record.mode = run.mode
		record.question = run.question.length > 300 ? `${run.question.slice(0, 300)}…` : run.question
	}
	try {
		await mkdir(dirname(file), { recursive: true })
		await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
		return { ledgerPersisted: true, ledgerPath: file }
	} catch {
		return { ledgerPersisted: false, ledgerPath: file }
	}
}

/** 读账本；只处理最近 maxLines 行，损坏行计数跳过而不是让整次读取失败。 */
async function readLedger(maxLines = 2000) {
	const { file } = await resolveLedgerPath()
	let raw
	try {
		raw = await readFile(file, 'utf8')
	} catch {
		return { path: file, records: [], skipped: 0, truncated: false }
	}
	const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '')
	const truncated = lines.length > maxLines
	const slice = truncated ? lines.slice(-maxLines) : lines
	const records = []
	let skipped = 0
	for (const line of slice) {
		try {
			const parsed = JSON.parse(line)
			if (parsed !== null && typeof parsed === 'object') records.push(parsed)
			else skipped += 1
		} catch {
			skipped += 1
		}
	}
	return { path: file, records, skipped, truncated }
}

/** 跨报告汇总。 */
async function summarizeTrend(input) {
	const days = optionalNumber(input.days, 0, 'days')
	const limit = Math.max(1, Math.min(20, Math.trunc(optionalNumber(input.limit, 5, 'limit'))))
	const { path, records, skipped, truncated } = await readLedger()

	let rows = records
	if (days > 0) {
		const cutoff = Date.now() - days * 86400000
		rows = rows.filter((record) => {
			const at = Date.parse(String(record.at ?? ''))
			return Number.isFinite(at) ? at >= cutoff : true
		})
	}

	const totalRuns = rows.length
	const divisor = totalRuns === 0 ? 1 : totalRuns
	const sumOf = (field) => rows.reduce((sum, record) => sum + (Number.isFinite(record[field]) ? record[field] : 0), 0)

	const byFramework = new Map()
	for (const record of rows) {
		const key = typeof record.framework === 'string' && record.framework !== '' ? record.framework : 'unknown'
		const entry = byFramework.get(key) ?? { framework: key, runs: 0, blockRuns: 0, cSum: 0 }
		entry.runs += 1
		if (record.verdict === 'block') entry.blockRuns += 1
		entry.cSum += Number.isFinite(record.pctC) ? record.pctC : 0
		byFramework.set(key, entry)
	}

	const frameworks = [...byFramework.values()]
		.map((entry) => ({
			framework: entry.framework,
			runs: entry.runs,
			blockRuns: entry.blockRuns,
			avgPctC: round(entry.cSum / entry.runs)
		}))
		.sort((left, right) => right.runs - left.runs)
		.slice(0, 8)

	const recent = [...rows]
		.slice(-limit)
		.reverse()
		.map((record) => ({
			at: String(record.at ?? ''),
			runId: String(record.runId ?? ''),
			framework: String(record.framework ?? ''),
			verdict: String(record.verdict ?? ''),
			pctA: Number.isFinite(record.pctA) ? record.pctA : 0,
			pctC: Number.isFinite(record.pctC) ? record.pctC : 0
		}))

	const payload = {
		ledgerPath: path,
		totalRuns,
		passRuns: rows.filter((record) => record.verdict === 'pass').length,
		returnRuns: rows.filter((record) => record.verdict === 'return').length,
		blockRuns: rows.filter((record) => record.verdict === 'block').length,
		avgPctA: round(sumOf('pctA') / divisor),
		avgPctB: round(sumOf('pctB') / divisor),
		avgPctC: round(sumOf('pctC') / divisor),
		avgDiversity: round(sumOf('diversityD') / divisor),
		councilTriggeredRuns: rows.filter((record) => record.councilTriggered === true).length,
		frameworks,
		recent,
		skippedRecords: skipped,
		truncated,
		summaryPath: '',
		summaryWritten: false
	}

	if (input.write === true) {
		const { summary } = await resolveLedgerPath()
		payload.summaryPath = summary
		const frontMatter = [
			'---',
			`updated: ${new Date().toISOString()}`,
			'tags: [deepsight, 审计趋势]',
			'---',
			'',
			'> 由 deepsight_trend 自动覆盖写入，手改会被下次覆盖。原始数据见同目录 deepsight-ledger.jsonl。',
			''
		].join('\n')
		try {
			await mkdir(dirname(summary), { recursive: true })
			await writeFile(summary, `${frontMatter}${renderTrend(payload, false)}\n`, 'utf8')
			payload.summaryWritten = true
		} catch {
			payload.summaryWritten = false
		}
	}

	return payload
}

/** 数字取整到指定小数位，避免浮点噪声进入交付物。 */
function round(value, digits = 1) {
	const factor = 10 ** digits
	return Math.round((value + Number.EPSILON) * factor) / factor
}

/** 统一文本结果块。 */
function text(value) {
	return [{ type: 'text', text: value }]
}

/**
 * 把「属性级 required: true」的书写方式转换为注册表要求的对象级 required 数组。
 * 输出 schema 只接受标准 JSON Schema，这里做一次递归规范化。
 */
function normalizeSchema(node) {
	if (node === null || typeof node !== 'object') return node
	if (Array.isArray(node)) return node.map(normalizeSchema)
	const out = {}
	const required = []
	for (const [key, value] of Object.entries(node)) {
		if (key === 'required' && typeof value === 'boolean') continue
		out[key] = normalizeSchema(value)
	}
	if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
		for (const [propertyName, child] of Object.entries(out.properties)) {
			if (child && typeof child === 'object' && typeof child.required === 'boolean') {
				if (child.required) required.push(propertyName)
				delete child.required
			}
		}
		if (required.length > 0) out.required = required
	}
	return out
}

/** 可选数字参数，给默认值；显式传错就报可读错误。 */
function optionalNumber(value, fallback, field) {
	if (value === undefined || value === null) return fallback
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isFinite(parsed)) throw new Error(`参数 ${field} 必须是数字，收到 ${JSON.stringify(value)}`)
	return parsed
}

/** 把 A-验证 / a / B 之类统一成 A / B / C。 */
function normalizeTier(value) {
	if (typeof value !== 'string') return null
	const letter = value.trim().charAt(0).toUpperCase()
	return letter === 'A' || letter === 'B' || letter === 'C' ? letter : null
}

/** 按信号词命中数选框架；全部未命中时按消歧规则退到行业研究。 */
function detectFramework(question) {
	const q = question.toLowerCase()
	let best = null
	let bestScore = 0
	for (const [key, meta] of Object.entries(FRAMEWORKS)) {
		const score = meta.signals.filter((signal) => q.includes(signal.toLowerCase())).length
		if (score > bestScore) {
			bestScore = score
			best = key
		}
	}
	if (best === null) return { key: 'industry', reason: '未命中任何框架信号词，按消歧规则退到行业研究。' }
	return { key: best, reason: `auto 路由：命中「${FRAMEWORKS[best].label}」信号词 ${bestScore} 个。` }
}

/** 问题是否带重大战略转向信号，需要先做反方论证。 */
function detectPivot(question) {
	const q = question.toLowerCase()
	return PIVOT_SIGNALS.some((signal) => q.includes(signal.toLowerCase()))
}

/** 生成契约记录。 */
function makeContract(input) {
	const question = typeof input.question === 'string' ? input.question.trim() : ''
	if (question === '') throw new Error('参数 question 不能为空：先把要被审判的那个问题写清楚。')

	let mode = input.mode
	if (mode === undefined || mode === null) mode = 'light'
	if (mode !== 'light' && mode !== 'deep') throw new Error('参数 mode 只能是 light 或 deep')

	let framework = input.framework
	if (framework === undefined || framework === null) framework = 'auto'
	let frameworkKey = framework
	let frameworkReason = '调用方显式指定。'
	if (framework === 'auto') {
		const detected = detectFramework(question)
		frameworkKey = detected.key
		frameworkReason = detected.reason
	} else if (!FRAMEWORKS[framework]) {
		throw new Error(`参数 framework 只能是 auto 或 ${Object.keys(FRAMEWORKS).join(' / ')}`)
	}

	const bTierMaxPct = optionalNumber(input.bTierMaxPct, 70, 'bTierMaxPct')
	const cTierMinPct = optionalNumber(input.cTierMinPct, 20, 'cTierMinPct')
	const cTierMaxPct = optionalNumber(input.cTierMaxPct, 35, 'cTierMaxPct')
	if (bTierMaxPct <= 0 || bTierMaxPct >= 100) throw new Error('参数 bTierMaxPct 必须在 (0, 100) 之间')
	if (cTierMinPct < 0 || cTierMaxPct > 100 || cTierMinPct >= cTierMaxPct) {
		throw new Error('参数 cTierMinPct / cTierMaxPct 必须满足 0 <= min < max <= 100')
	}

	const phase0Required = input.phase0Required === undefined ? detectPivot(question) : input.phase0Required === true

	const runId = `ds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

	const nextSteps = []
	if (phase0Required) {
		nextSteps.push('先做 Phase 0.0 战略决策强制审查：置信度校准 → Council 五角色攻击 → 反面证据清单，用户确认修正方向后才出执行计划。')
	}
	nextSteps.push(`按「${FRAMEWORKS[frameworkKey].label}」框架四步推进；每步结束把结论以 deepsight_audit 提交，不要攒到最后。`)
	nextSteps.push('结论必须逐条标 A / B / C；[C] 级不得进入行动建议，只能标为「待外部验证」并附翻盘条件。')
	nextSteps.push(`交付前最后一次 deepsight_audit 必须返回 verdict=pass，否则 present 会被出口闸门拒绝。`)

	const record = {
		runId,
		question,
		framework: frameworkKey,
		frameworkLabel: FRAMEWORKS[frameworkKey].label,
		frameworkReason,
		mode,
		bTierMaxPct,
		cTierMinPct,
		cTierMaxPct,
		phase0Required,
		councilRule: '[C] 占比 >30% 强制触发 Council 交叉验证；20-30% 且真金白银决策建议触发；其余跳过。独立模型族 D<3 时终审证据级封顶 [B]。',
		marks: TIER_MARKS.map((item) => `${item.tier}：${item.meaning}`),
		nextSteps
	}

	runs.set(runId, record)
	return record
}

/** 对账本做确定性判定。 */
function auditLedger(input, sessionKey) {
	const claimsIn = Array.isArray(input.claims) ? input.claims : []
	if (claimsIn.length === 0) throw new Error('参数 claims 至少需要一条结论，否则无从判定。')

	const key = sessionKey ?? GLOBAL_KEY
	let runId = typeof input.runId === 'string' && input.runId !== '' ? input.runId : sessionRuns.get(key)
	if (runId === undefined) runId = ''
	const run = runId === '' ? undefined : runs.get(runId)

	const bTierMaxPct = run ? run.bTierMaxPct : 70
	const cTierMinPct = run ? run.cTierMinPct : 20
	const cTierMaxPct = run ? run.cTierMaxPct : 35

	const claims = claimsIn.map((raw, index) => {
		const tier = normalizeTier(raw?.tier)
		if (tier === null) throw new Error(`claims[${index}].tier 必须是 A / B / C，收到 ${JSON.stringify(raw?.tier)}`)
		const id = typeof raw?.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : `c${index + 1}`
		const conflict = typeof raw?.conflict === 'string' ? raw.conflict.trim().toLowerCase() : 'none'
		const basisDeclared = raw?.basisClaimIds !== undefined
		if (basisDeclared && !Array.isArray(raw.basisClaimIds)) {
			throw new Error(`claims[${index}].basisClaimIds 必须是结论 id 数组`)
		}
		const basis = basisDeclared ? raw.basisClaimIds.map((value) => String(value).trim()).filter((value) => value !== '') : []
		return { id, tier, conflict, basisDeclared, basis }
	})

	const total = claims.length
	const countOf = (tier) => claims.filter((claim) => claim.tier === tier).length
	const countsA = countOf('A')
	const countsB = countOf('B')
	const countsC = countOf('C')
	const pctA = round((countsA / total) * 100)
	const pctB = round((countsB / total) * 100)
	const pctC = round((countsC / total) * 100)

	const actionClaimIds = Array.isArray(input.actionClaimIds) ? input.actionClaimIds.map((value) => String(value).trim()) : []
	const actionSet = [...new Set(actionClaimIds)]
	const byId = new Map(claims.map((claim) => [claim.id, claim]))

	/** 从一条结论出发沿 basisClaimIds 追溯全部可达结论（防环），并收集未知 id。 */
	const closureOf = (startId) => {
		const reached = new Set()
		const unknown = new Set()
		const start = byId.get(startId)
		const stack = start === undefined ? [] : [...start.basis]
		while (stack.length > 0) {
			const next = stack.pop()
			if (reached.has(next)) continue
			reached.add(next)
			const claim = byId.get(next)
			if (claim === undefined) {
				unknown.add(next)
				continue
			}
			for (const parent of claim.basis) if (!reached.has(parent)) stack.push(parent)
		}
		return { reached, unknown }
	}

	const blocked = new Set()
	const missingProvenance = new Set()
	const unknownBasis = new Set()
	const cSources = new Set()

	for (const id of actionSet) {
		const claim = byId.get(id)
		if (claim === undefined) {
			unknownBasis.add(id)
			blocked.add(id)
			continue
		}
		if (!claim.basisDeclared) {
			missingProvenance.add(id)
			blocked.add(id)
			continue
		}
		const { reached, unknown } = closureOf(id)
		if (unknown.size > 0) {
			for (const item of unknown) unknownBasis.add(item)
			blocked.add(id)
			continue
		}
		let hitC = claim.tier === 'C'
		if (hitC) cSources.add(id)
		for (const parentId of reached) {
			const parent = byId.get(parentId)
			if (parent !== undefined && parent.tier === 'C') {
				hitC = true
				cSources.add(parentId)
			}
		}
		if (hitC) blocked.add(id)
	}

	const blockedClaims = [...blocked]
	const openConflicts = claims.filter((claim) => claim.conflict === 'open').map((claim) => claim.id)

	const familiesInput = Array.isArray(input.council?.modelFamilies) ? input.council.modelFamilies : []
	const families = [
		...new Set(
			familiesInput
				.map((family) => String(family).trim().toLowerCase())
				.filter((family) => family !== '')
		)
	]
	const diversityD = families.length
	const tierCap = diversityD >= 3 ? 'A' : 'B'

	const returnForRegrade = pctB > bTierMaxPct
	const cTierInRange = pctC >= cTierMinPct && pctC <= cTierMaxPct
	const councilTriggered = pctC > 30 || (pctC >= 20 && input.bigDecision === true)

	const reasons = []
	if (returnForRegrade) {
		reasons.push(`[B] 占比 ${pctB}% 超过上限 ${bTierMaxPct}%：分析停在推理层，退回重标或补外部验证。`)
	}
	if (!cTierInRange) {
		reasons.push(`[C] 占比 ${pctC}% 不在目标区间 ${cTierMinPct}-${cTierMaxPct}%。`)
	}
	if (diversityD < 3) {
		reasons.push(`独立模型族 D=${diversityD}（<3）：终审证据级封顶 [B]，任何 [A] 级结论须下调，且报告要显式标注这次 Council 的强度。`)
	}
	if (missingProvenance.size > 0) {
		reasons.push(
			`行动依据缺少来源声明：${[...missingProvenance].join('、')} 没有给出 basisClaimIds。行动依据必须声明它是「一级观察」（空数组）还是「从哪几条推出来的」，省略不予放行。`
		)
	}
	if (unknownBasis.size > 0) {
		reasons.push(`引用了未知结论：${[...unknownBasis].join('、')}，来源链无法追溯到本批 claims。`)
	}
	if (cSources.size > 0) {
		reasons.push(
			`决策刹车（含派生追溯）：行动依据的可达来源里出现 [C] 级 ${[...cSources].join('、')}，必须降级为「待外部验证」、换用可独立验证的来源，或把派生结论重新标注为 [C]。`
		)
	}
	if (openConflicts.length > 0) {
		reasons.push(`冲突未闭环：${openConflicts.join('、')} 仍为 open，回路未闭合，不得静默选边。`)
	}
	if (councilTriggered) {
		reasons.push('[C] 占比达到 Phase 2 Council 触发条件，交付前应做跨模型族交叉验证。')
	}
	if (reasons.length === 0) {
		reasons.push('三档分布、模型族多样性与冲突状态均满足当前契约。')
	}

	let verdict = 'pass'
	if (blockedClaims.length > 0 || openConflicts.length > 0) verdict = 'block'
	else if (returnForRegrade) verdict = 'return'

	latestVerdict.set(key, { runId, verdict, reason: reasons[0] })

	return {
		runId,
		total,
		countsA,
		countsB,
		countsC,
		pctA,
		pctB,
		pctC,
		tierCap,
		diversityD,
		returnForRegrade,
		cTierInRange,
		councilTriggered,
		blockedClaims,
		openConflicts,
		actionClaimCount: actionClaimIds.length,
		cSources: [...cSources],
		verdict,
		reasons
	}
}

/** 契约的可读渲染。 */
function renderContract(value) {
	const lines = [
		`## DeepSight 契约 · ${value.runId}`,
		'',
		`- 问题：${value.question}`,
		`- 框架：${value.frameworkLabel}（${value.framework}）— ${value.frameworkReason}`,
		`- 模式：${value.mode === 'deep' ? '深度' : '轻量'}`,
		`- 证据阈值：[B] ≤ ${value.bTierMaxPct}% · [C] ${value.cTierMinPct}-${value.cTierMaxPct}%`,
		`- Phase 0.0 战略决策强制审查：${value.phase0Required ? '**必须执行**' : '不触发'}`,
		'',
		'**证据等级口径**',
		...value.marks.map((mark) => `- ${mark}`),
		'',
		`**Council 规则**：${value.councilRule}`,
		'',
		'**推进顺序**',
		...value.nextSteps.map((step, index) => `${index + 1}. ${step}`)
	]
	return lines.join('\n')
}

/** 判定的可读渲染。 */
function renderAudit(value) {
	const badge = value.verdict === 'pass' ? '✅ pass' : value.verdict === 'return' ? '↩︎ return（退回重标）' : '⛔ block（交付被拦）'
	const lines = [
		`## DeepSight 审计 · ${badge}`,
		'',
		`| 档位 | 条数 | 占比 |`,
		`|---|---|---|`,
		`| [A-验证] | ${value.countsA} | ${value.pctA}% |`,
		`| [B-推理] | ${value.countsB} | ${value.pctB}% |`,
		`| [C-推断] | ${value.countsC} | ${value.pctC}% |`,
		`| 合计 | ${value.total} | 100% |`,
		'',
		`- 终审证据级上限：**[${value.tierCap}]**（独立模型族 D=${value.diversityD}）`,
		`- [B] 超限退回：${value.returnForRegrade ? '是' : '否'} · [C] 在目标区间：${value.cTierInRange ? '是' : '否'} · Council 触发：${value.councilTriggered ? '是' : '否'}`,
		`- 行动建议引用的结论数：${value.actionClaimCount}`
	]
	if (value.blockedClaims.length > 0) lines.push(`- 被拦下的行动依据：${value.blockedClaims.join('、')}`)
	if (value.cSources.length > 0) lines.push(`- 来源链命中的 [C] 级：${value.cSources.join('、')}（含通过 basisClaimIds 派生追溯到的）`)
	if (value.openConflicts.length > 0) lines.push(`- 未闭环冲突：${value.openConflicts.join('、')}`)
	lines.push('', '**判定理由**', ...value.reasons.map((reason) => `- ${reason}`))
	return lines.join('\n')
}

/** 跨报告趋势的可读渲染。includePath=false 用于写文件时不自我引用。 */
function renderTrend(value, includePath = true) {
	if (value.totalRuns === 0) {
		return [
			'## DeepSight 账本趋势 · 暂无记录',
			'',
			`- 账本：${value.ledgerPath}`,
			`- 还没有任何落盘记录${value.skippedRecords > 0 ? `（已跳过 ${value.skippedRecords} 条损坏行）` : ''}。先跑一次 deepsight_audit。`
		].join('\n')
	}
	const lines = [
		'## DeepSight 账本趋势',
		'',
		`- 账本：${value.ledgerPath}${value.truncated ? '（只读最近 2000 行）' : ''}`,
		`- 记录数：${value.totalRuns} · pass ${value.passRuns} / return ${value.returnRuns} / block ${value.blockRuns}`,
		`- 平均分布：[A] ${value.avgPctA}% · [B] ${value.avgPctB}% · [C] ${value.avgPctC}%`,
		`- 平均独立模型族 D：${value.avgDiversity} · Council 触发的记录：${value.councilTriggeredRuns}`,
		'',
		'**按框架**',
		'| 框架 | 次数 | 被判 block | 平均 [C] |',
		'|---|---|---|---|'
	]
	if (value.frameworks.length === 0) lines.push('| 无框架标记 | 0 | 0 | 0% |')
	else for (const item of value.frameworks) lines.push(`| ${item.framework} | ${item.runs} | ${item.blockRuns} | ${item.avgPctC}% |`)
	lines.push('', '**最近记录**')
	if (value.recent.length === 0) lines.push('- 无')
	else {
		lines.push('| 时间 | 框架 | 判定 | [A] | [C] |', '|---|---|---|---|---|')
		for (const item of value.recent) lines.push(`| ${item.at} | ${item.framework === '' ? '-' : item.framework} | ${item.verdict} | ${item.pctA}% | ${item.pctC}% |`)
	}
	if (includePath && value.summaryWritten === true) lines.push('', `已覆盖写入笔记：${value.summaryPath}`)
	return lines.join('\n')
}

/** 插件入口：注册一个 skill、三个工具与一个出口闸门。 */
function apply(ctx) {
	// 方法论与本包一起分发，注册进本 preset 的层，只影响 DeepSight 会话。
	// skills 走可选访问：拿不到时工具照常注册，不让整个插件失活。
	const skills = ctx.get('skills')
	if (skills !== undefined) {
		ctx.effect(() => {
			try {
				const skill = loadSkill()
				return skills.register({
					name: skill.name,
					description: SKILL_DESCRIPTION,
					content: skill.body,
					source: 'bundled',
					path: skill.path,
					resourceBase: { kind: 'directory', path: SKILL_DIR },
					...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse })
				})
			} catch {
				return () => {}
			}
		})
	}

	const register = (definition) =>
		ctx.tools.register({
			...definition,
			output: { ...definition.output, schema: normalizeSchema(definition.output.schema) }
		})

	register({
		name: 'deepsight_contract',
		description:
			'开跑前锁定一次 DeepSight 深度研究的验收契约：按决策落点选框架、定模式、定证据阈值、判定是否必须执行 Phase 0.0 战略决策强制审查，并返回 runId 供后续审计引用。研究开始时就调，不要等写完再补。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				question: { type: 'string', description: '要被审判的研究问题原文。' },
				framework: {
					type: 'string',
					description: '框架 key；省略或 auto 时按信号词自动路由，未命中退到行业研究。',
					enum: ['auto', 'investment', 'strategy', 'technology', 'market', 'startup', 'industry', 'organization', 'platform']
				},
				mode: { type: 'string', description: 'light 轻量（2 轮追问 + 1 轮对抗）或 deep 深度（完整四步 + 可选 Council）。默认 light。', enum: ['light', 'deep'] },
				bTierMaxPct: { type: 'number', description: '[B] 占比上限，默认 70；超过则退回重标。' },
				cTierMinPct: { type: 'number', description: '[C] 占比目标下限，默认 20。' },
				cTierMaxPct: { type: 'number', description: '[C] 占比目标上限，默认 35。' },
				phase0Required: { type: 'boolean', description: '是否强制 Phase 0.0 反方论证；省略时按问题里的战略转向信号词自动判定。' }
			},
			required: ['question']
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					runId: { type: 'string', required: true },
					question: { type: 'string', required: true },
					framework: { type: 'string', required: true },
					frameworkLabel: { type: 'string', required: true },
					frameworkReason: { type: 'string', required: true },
					mode: { type: 'string', required: true },
					bTierMaxPct: { type: 'number', required: true },
					cTierMinPct: { type: 'number', required: true },
					cTierMaxPct: { type: 'number', required: true },
					phase0Required: { type: 'boolean', required: true },
					councilRule: { type: 'string', required: true },
					marks: { type: 'array', required: true, items: { type: 'string' } },
					nextSteps: { type: 'array', required: true, items: { type: 'string' } }
				}
			},
			render: (_args, value) => text(renderContract(value))
		},
		execute(args, exec) {
			const value = makeContract(args ?? {})
			if (exec?.agent?.id) sessionRuns.set(exec.agent.id, value.runId)
			return Promise.resolve(value)
		},
		presentCall: (args) => ({ card: 'generic', title: '锁定 DeepSight 研究契约', kind: 'other', rawInput: args })
	})

	register({
		name: 'deepsight_audit',
		description:
			'提交本次研究的结论账本，返回确定性判定：[A]/[B]/[C] 占比、[B] 是否超限退回、独立模型族 D 值与证据级封顶、未闭环冲突、行动依据的来源链检查（沿 basisClaimIds 追溯，出现 [C] 或未声明来源即拦）、Council 是否应触发，以及 pass / return / block 结论。占比与追溯由工具计算，不要用模型心算代替。每次调用都会追加一行到账本，供 deepsight_trend 汇总。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				runId: { type: 'string', description: 'deepsight_contract 返回的 runId；省略时用本会话最近一次契约。' },
				claims: {
					type: 'array',
					description: '本次要审计的结论清单，每条一个证据等级。',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							id: { type: 'string', description: '结论编号，行动建议引用它。' },
							text: { type: 'string', description: '结论原文，便于人读。' },
							tier: { type: 'string', description: '证据等级：A / B / C（也接受 A-验证 这类写法）。' },
							basisClaimIds: {
								type: 'array',
								description:
									'这条结论是从哪几条结论推出来的（引用本批 claim 的 id）。一级观察用空数组 []。若该结论进入 actionClaimIds，本字段必须给出，省略即拦；来源链上出现 [C] 级也会被拦。',
								items: { type: 'string' }
							},
							conflict: { type: 'string', description: '冲突状态：none / resolved / retained / open。open 表示回路未闭合。' }
						},
						required: ['tier']
					}
				},
				actionClaimIds: {
					type: 'array',
					description:
						'行动建议所依据的结论 id。每一条被引用的结论都必须在 claims 里用 basisClaimIds 声明来源（一级观察为空数组），工具会沿来源链做传递闭包，任一路径出现 [C] 即触发决策刹车。',
					items: { type: 'string' }
				},
				bigDecision: { type: 'boolean', description: '本次结论是否用于投资 / 采购 / 战略方向决策，影响 Council 建议触发。' },
				council: {
					type: 'object',
					additionalProperties: false,
					description: 'Phase 2 Council 的实际执行情况；不传视为未做交叉验证（D=0）。',
					properties: {
						modelFamilies: { type: 'array', description: '参与审计的独立模型族（同族不同尺寸只算一个）。', items: { type: 'string' } }
					}
				}
			},
			required: ['claims']
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					runId: { type: 'string', required: true },
					total: { type: 'integer', required: true },
					countsA: { type: 'integer', required: true },
					countsB: { type: 'integer', required: true },
					countsC: { type: 'integer', required: true },
					pctA: { type: 'number', required: true },
					pctB: { type: 'number', required: true },
					pctC: { type: 'number', required: true },
					tierCap: { type: 'string', required: true },
					diversityD: { type: 'integer', required: true },
					returnForRegrade: { type: 'boolean', required: true },
					cTierInRange: { type: 'boolean', required: true },
					councilTriggered: { type: 'boolean', required: true },
					blockedClaims: { type: 'array', required: true, items: { type: 'string' } },
					cSources: { type: 'array', required: true, items: { type: 'string' } },
					openConflicts: { type: 'array', required: true, items: { type: 'string' } },
					actionClaimCount: { type: 'integer', required: true },
					verdict: { type: 'string', required: true },
					reasons: { type: 'array', required: true, items: { type: 'string' } },
					ledgerPersisted: { type: 'boolean', required: true },
					ledgerPath: { type: 'string', required: true }
				}
			},
			render: (_args, value) => text(renderAudit(value))
		},
		async execute(args, exec) {
			const value = auditLedger(args ?? {}, exec?.agent?.id)
			const saved = await appendLedger(value)
			return { ...value, ...saved }
		},
		presentCall: (args) => ({ card: 'generic', title: '审计 DeepSight 结论账本', kind: 'other', rawInput: args })
	})

	register({
		name: 'deepsight_trend',
		description:
			'读取已落盘的审计账本，汇总跨报告趋势：记录数、pass/return/block 分布、平均证据分布与平均独立模型族数、Council 触发次数、按框架的 block 率与平均 [C] 占比、最近若干条记录。只读账本；write=true 时另把结果覆盖写成同目录的 Obsidian 笔记。用于回答「这个方法论到底改变了什么」，不要靠翻旧对话统计。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				days: { type: 'integer', description: '只看最近多少天；0 或不传表示全部。' },
				limit: { type: 'integer', description: '最近记录条数，1-20，默认 5。' },
				write: { type: 'boolean', description: '是否把结果覆盖写入同目录的 DeepSight-审计趋势.md（Obsidian 可读）。默认 false，只返回不落盘。' }
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					ledgerPath: { type: 'string', required: true },
					totalRuns: { type: 'integer', required: true },
					passRuns: { type: 'integer', required: true },
					returnRuns: { type: 'integer', required: true },
					blockRuns: { type: 'integer', required: true },
					avgPctA: { type: 'number', required: true },
					avgPctB: { type: 'number', required: true },
					avgPctC: { type: 'number', required: true },
					avgDiversity: { type: 'number', required: true },
					councilTriggeredRuns: { type: 'integer', required: true },
					frameworks: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								framework: { type: 'string', required: true },
								runs: { type: 'integer', required: true },
								blockRuns: { type: 'integer', required: true },
								avgPctC: { type: 'number', required: true }
							}
						}
					},
					recent: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								at: { type: 'string', required: true },
								runId: { type: 'string', required: true },
								framework: { type: 'string', required: true },
								verdict: { type: 'string', required: true },
								pctA: { type: 'number', required: true },
								pctC: { type: 'number', required: true }
							}
						}
					},
					skippedRecords: { type: 'integer', required: true },
					truncated: { type: 'boolean', required: true },
					summaryPath: { type: 'string', required: true },
					summaryWritten: { type: 'boolean', required: true }
				}
			},
			render: (_args, value) => text(renderTrend(value))
		},
		async execute(args) {
			return summarizeTrend(args ?? {})
		},
		presentCall: (args) => ({ card: 'generic', title: '汇总 DeepSight 账本趋势', kind: 'other', rawInput: args })
	})

	ctx.effect(() =>
		ctx.tools.guard((execution) => {
			if (execution.name !== 'present') return undefined
			const state = latestVerdict.get(execution.agent?.id ?? GLOBAL_KEY)
			if (state === undefined || state.verdict !== 'block') return undefined
			return `DeepSight 出口闸门拒绝了 present。${state.reason} 处理完再交付。`
		})
	)
}

export { apply, inject, name }
