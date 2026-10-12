#!/usr/bin/env node
/**
 * Jev (TypeSafe System One) 模型 HTTP 测试用例。
 *
 * Jev 不是聊天模型，它的线协议只有一条：
 *
 *   POST {baseUrl}/systemone
 *   Authorization: Bearer <key>
 *   {
 *     "model": "jev-latest",
 *     "state": <JSON 值：string | object | array>,
 *     "questions": {
 *       "<id>": { "type": "choice", "instructions": "...", "criteria": { "<label>": "含义" } },
 *       "<id>": { "type": "score",  "instructions": "...", "criteria": ["最低", "…", "最高"] },
 *       "<id>": { "type": "noul",   "instructions": "..." }
 *     }
 *   }
 *
 * 返回（实测样例，score 另外带 legend/probabilities/层级期望值）：
 *   {
 *     "model": "jev-1.13.0",
 *     "usage": { "input_tokens": N, "output_tokens": N },
 *     "answers": {
 *       "<id>": { "type": "choice", "choice": "<label>", "probabilities": {…}, "confidence": 0..1 },
 *       "<id>": { "type": "score",  "score": <小数，层级期望值>, "confidence": 0..1,
 *                 "legend": { "0": "低", … }, "probabilities": { "0": 0.0, … } },
 *       "<id>": { "type": "noul",   "noul": 0..1 }
 *     }
 *   }
 *
 * 端点未必在 baseUrl 直接下挂：New API 网关把 System One 挂在根前缀 /typesafe 下，
 * 即 http://localhost:3000/typesafe/v1/systemone。本脚本按 baseUrl 原样拼 /systemone，
 * 不猜前缀，所以 baseUrl 要显式给到前缀那一层。
 *
 * 用法：
 *   node scripts/test-jev.mjs [--base-url URL] [--key KEY] [--model ID] [--case NAME]… [--list]
 *
 * 配置优先级：命令行 > 环境变量 > 默认值。
 *   baseUrl  JEV_BASE_URL / TYPESAFE_BASE_URL   默认 https://api.typesafe.ai/v1
 *   key      JEV_API_KEY  / TYPESAFE_API_KEY    （必填；缺失时只跑不需要鉴权的用例）
 *   model    JEV_MODEL    / TYPESAFE_DEFAULT_MODEL  默认 jev-latest
 *
 * 退出码：0 全部通过；1 有用例失败；2 配置/连通性错误（host 没暴露 System One）。
 */

import process from 'node:process';

/* ------------------------------------------------------------------ 配置 */

function parseArgs(argv) {
	const opts = { cases: [], list: false, baseUrl: undefined, key: undefined, model: undefined };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const take = () => {
			const value = argv[i + 1];
			i += 1;
			if (value === undefined) throw new Error(`${arg} 缺少取值`);
			return value;
		};
		switch (arg) {
			case '--base-url': opts.baseUrl = take(); break;
			case '--key': opts.key = take(); break;
			case '--model': opts.model = take(); break;
			case '--case': opts.cases.push(take()); break;
			case '--list': opts.list = true; break;
			case '-h':
			case '--help': opts.help = true; break;
			default: throw new Error(`未知参数：${arg}`);
		}
	}
	return opts;
}

function resolveConfig(opts) {
	const env = process.env;
	const baseUrl = (opts.baseUrl ?? env.JEV_BASE_URL ?? env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai/v1').trim();
	const key = (opts.key ?? env.JEV_API_KEY ?? env.TYPESAFE_API_KEY ?? '').trim();
	const model = (opts.model ?? env.JEV_MODEL ?? env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest').trim();
	return { baseUrl, key, model };
}

/** baseUrl 可能是根（…/v1）也可能是完整端点（…/v1/systemone），两种都接受。 */
function endpointOf(baseUrl) {
	const trimmed = baseUrl.replace(/\/+$/u, '');
	return /\/systemone$/u.test(trimmed) ? trimmed : `${trimmed}/systemone`;
}

/* -------------------------------------------------------------- 断言工具 */

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const inUnit = (value) => isNumber(value) && value >= 0 && value <= 1;

class Case {
	constructor(name) {
		this.name = name;
		this.checks = [];
		this.notes = [];
		this.skipped = null;
	}
	check(label, condition, detail) {
		this.checks.push({ label, ok: Boolean(condition), detail });
		return Boolean(condition);
	}
	note(text) { this.notes.push(text); }
	skip(reason) { this.skipped = reason; }
	get ok() { return this.skipped === null && this.checks.every((item) => item.ok); }
}

/* ---------------------------------------------------------------- HTTP */

async function post(url, { key, body, timeoutMs = 30_000 }) {
	const headers = { 'content-type': 'application/json' };
	if (key) headers.authorization = `Bearer ${key}`;
	const started = Date.now();
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		let json;
		try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
		return { status: response.status, ok: response.ok, text, json, ms: Date.now() - started };
	} catch (error) {
		return { status: 0, ok: false, text: String(error?.message ?? error), json: undefined, ms: Date.now() - started, transportError: error };
	}
}

const clip = (text, max = 600) => {
	const value = String(text ?? '');
	return value.length > max ? `${value.slice(0, max)}…(${value.length}B)` : value;
};

/** New API 网关的预扣费不足：这是账户余额问题，不是模型/契约失败。 */
function isQuotaError(res) {
	const text = typeof res.text === 'string' ? res.text : '';
	return /预扣费|剩余额度|insufficient|quota|balance/i.test(text);
}

/** 若响应是网关预扣费不足，把用例标成 SKIP 而不是 FAIL；返回 true 表示已跳过。 */
function guardQuota(caseObj, res) {
	if (res.status === 402 || (res.status === 403 && isQuotaError(res))) {
		caseObj.skip(`网关预扣费不足（HTTP ${res.status}），非模型问题`);
		return true;
	}
	return false;
}

/* --------------------------------------------------------------- 用例集 */

// 结构探针的期望值，供多个用例复用。
const CRITERIA = {
	payments: '佣金/支付失败',
	account: '登录与账号访问',
	other: '其它',
};
const SCORE_SCALE = ['很平静', '略有不满', '非常愤怒'];
const TICKET_STATE = {
	ticket: {
		subject: 'Payout failed three times',
		body: 'My payouts have failed three times. The bank says everything is fine. Please fix this.',
		attempts: 3,
	},
};

function buildContractBody(model) {
	return {
		model,
		state: TICKET_STATE,
		questions: {
			queue: { type: 'choice', instructions: 'Which team should handle this ticket?', criteria: CRITERIA },
			severity: { type: 'score', instructions: 'How severe is the situation?', criteria: SCORE_SCALE },
			escalate: { type: 'noul', instructions: 'Does this message require urgent human attention?' },
		},
	};
}

/** 校验单条 answer 的结构与取值域。 */
function validateAnswer(caseObj, id, answer, question) {
	if (!caseObj.check(`answers.${id} 存在且为对象`, isRecord(answer), clip(JSON.stringify(answer)))) return;

	if (question.type === 'choice') {
		caseObj.check(
			`${id}.choice 落在 criteria 内`,
			typeof answer.choice === 'string' && Object.hasOwn(question.criteria, answer.choice),
			`choice=${JSON.stringify(answer.choice)}`,
		);
		const probs = answer.probabilities;
		if (caseObj.check(`${id}.probabilities 为对象`, isRecord(probs), clip(JSON.stringify(probs)))) {
			const keys = Object.keys(probs);
			caseObj.check(
				`${id}.probabilities 覆盖全部 criteria 键`,
				Object.keys(question.criteria).every((key) => keys.includes(key)) && keys.length === Object.keys(question.criteria).length,
				`keys=${keys.join(',')}`,
			);
			caseObj.check(`${id}.probabilities 各项 ∈ [0,1]`, Object.values(probs).every(inUnit), clip(JSON.stringify(probs)));
			const sum = Object.values(probs).reduce((total, value) => total + (isNumber(value) ? value : 0), 0);
			caseObj.check(`${id}.probabilities 归一（Σ≈1）`, Math.abs(sum - 1) <= 0.02, `Σ=${sum.toFixed(4)}`);
			caseObj.check(
				`${id}.choice 与最大概率项一致`,
				isNumber(probs[answer.choice]) && probs[answer.choice] === Math.max(...Object.values(probs).filter(isNumber)),
				`P(${answer.choice})=${probs[answer.choice]}`,
			);
		}
		caseObj.check(`${id}.confidence ∈ [0,1]`, inUnit(answer.confidence), `confidence=${answer.confidence}`);
		return;
	}

	if (question.type === 'score') {
		const max = question.criteria.length - 1;
		caseObj.check(
			`${id}.score 落在 [0, ${max}]`,
			isNumber(answer.score) && answer.score >= -1e-6 && answer.score <= max + 1e-6,
			`score=${answer.score}`,
		);
		caseObj.check(`${id}.confidence ∈ [0,1]`, inUnit(answer.confidence), `confidence=${answer.confidence}`);
		// 真实网关的 score 还带层分布（键是层级索引字符串），有就校验，没有则容忍。
		if (answer.probabilities !== undefined) {
			const keys = Object.keys(answer.probabilities);
			caseObj.check(
				`${id}.probabilities 覆盖 0..${max}`,
				keys.length === max + 1 && Array.from({ length: max + 1 }, (_v, i) => String(i)).every((key) => keys.includes(key)),
				`keys=${keys.join(',')}`,
			);
			const sum = Object.values(answer.probabilities).reduce((total, value) => total + (isNumber(value) ? value : 0), 0);
			caseObj.check(`${id}.probabilities 归一（Σ≈1）`, Math.abs(sum - 1) <= 0.02, `Σ=${sum.toFixed(4)}`);
			const expected = Object.entries(answer.probabilities).reduce((total, [key, prob]) => total + Number(key) * (isNumber(prob) ? prob : 0), 0);
			caseObj.check(`${id}.score 与层分布期望一致`, Math.abs(expected - answer.score) <= 0.05, `Σi·P(i)=${expected.toFixed(3)} score=${answer.score}`);
		}
		return;
	}

	// noul：字段名就是 noul，值是 true 的概率。
	caseObj.check(`${id}.noul ∈ [0,1]`, inUnit(answer.noul), `noul=${answer.noul}`);
}

const CASES = [
	{
		name: 'contract-object-state',
		describe: '对象 state + choice/score/noul：一次往返返回三类答案并满足各自取值域',
		needsKey: true,
		async run(caseObj, ctx) {
			const body = buildContractBody(ctx.model);
			const res = await post(ctx.endpoint, { key: ctx.key, body });
			if (guardQuota(caseObj, res)) return;
			if (!caseObj.check('HTTP 200', res.status === 200, `status=${res.status} body=${clip(res.text)}`)) return;
			const data = res.json;
			if (!caseObj.check('响应为 JSON 对象', isRecord(data), clip(res.text))) return;
			caseObj.check('回显 model 为字符串', typeof data.model === 'string' && data.model.length > 0, `model=${data.model}`);
			if (caseObj.check('answers 为对象', isRecord(data.answers), clip(JSON.stringify(data.answers)))) {
				for (const [id, question] of Object.entries(body.questions)) {
					validateAnswer(caseObj, id, data.answers?.[id], question);
				}
			}
			if (isRecord(data.usage)) {
				caseObj.check('usage.input_tokens 为正数', isNumber(data.usage.input_tokens) && data.usage.input_tokens > 0, `usage=${JSON.stringify(data.usage)}`);
			} else {
				caseObj.note('响应未带 usage，跳过 token 校验（部分网关会剥离）');
			}
			caseObj.note(`延迟 ${res.ms}ms`);
		},
	},
	{
		name: 'contract-string-state',
		describe: '纯字符串 state 也被接受（state 允许 string | object | array）',
		needsKey: true,
		async run(caseObj, ctx) {
			const body = {
				model: ctx.model,
				state: 'Please refund the duplicate charge I was billed twice.',
				questions: {
					refund: { type: 'noul', instructions: 'Does the customer request a refund?' },
				},
			};
			const res = await post(ctx.endpoint, { key: ctx.key, body });
			if (guardQuota(caseObj, res)) return;
			if (!caseObj.check('HTTP 200', res.status === 200, `status=${res.status} body=${clip(res.text)}`)) return;
			const answer = res.json?.answers?.refund;
			caseObj.check('answers.refund.noul ∈ [0,1]', isRecord(answer) && inUnit(answer.noul), clip(JSON.stringify(answer)));
		},
	},
	{
		name: 'reproducibility',
		describe: '同一 state 连发三次，choice 标签保持一致（判别模型应当稳定）',
		needsKey: true,
		async run(caseObj, ctx) {
			const body = buildContractBody(ctx.model);
			const labels = [];
			for (let i = 0; i < 3; i += 1) {
				const res = await post(ctx.endpoint, { key: ctx.key, body });
				if (guardQuota(caseObj, res)) { caseObj.note(`第 ${i + 1} 次调用被网关拒于预扣费（余额不足）`); return; }
				if (!caseObj.check(`第 ${i + 1} 次调用 HTTP 200`, res.status === 200, `status=${res.status} body=${clip(res.text)}`)) return;
				labels.push(res.json?.answers?.queue?.choice);
			}
			if (labels.length < 2) { caseObj.note('可用样本不足两次，跳过一致性断言'); return; }
			caseObj.check(`${labels.length} 次 choice 一致`, new Set(labels).size === 1, `labels=${JSON.stringify(labels)}`);
		},
	},
	{
		name: 'auth-missing',
		describe: '不带 Authorization 必须被拒（401/403），不能返回答案',
		needsKey: false,
		async run(caseObj, ctx) {
			const res = await post(ctx.endpoint, { key: '', body: buildContractBody(ctx.model) });
			caseObj.check(
				'缺少密钥被拒（401/403）',
				res.status === 401 || res.status === 403,
				`status=${res.status} body=${clip(res.text)}`,
			);
			caseObj.check('未泄漏 answers', !isRecord(res.json?.answers), clip(JSON.stringify(res.json?.answers)));
		},
	},
	{
		name: 'auth-invalid',
		describe: '伪造 Bearer 必须被拒（401/403）',
		needsKey: false,
		async run(caseObj, ctx) {
			const res = await post(ctx.endpoint, { key: 'jev_not-a-real-key', body: buildContractBody(ctx.model) });
			caseObj.check(
				'伪造密钥被拒（401/403）',
				res.status === 401 || res.status === 403,
				`status=${res.status} body=${clip(res.text)}`,
			);
		},
	},
	{
		name: 'invalid-choice-criteria',
		describe: 'choice 的 criteria 为空应被拒（4xx），不得静默返回答案',
		needsKey: true,
		async run(caseObj, ctx) {
			const body = {
				model: ctx.model,
				state: 'hello',
				questions: { pick: { type: 'choice', instructions: 'Pick one', criteria: {} } },
			};
			const res = await post(ctx.endpoint, { key: ctx.key, body });
			if (guardQuota(caseObj, res)) return;
			caseObj.check('空 criteria 被拒（4xx）', res.status >= 400 && res.status < 500, `status=${res.status} body=${clip(res.text)}`);
		},
	},
	{
		name: 'unknown-model',
		describe: '不存在的 model 不能返回看似正常的 answers',
		needsKey: true,
		async run(caseObj, ctx) {
			const body = buildContractBody('jev-definitely-not-a-real-model');
			const res = await post(ctx.endpoint, { key: ctx.key, body });
			if (guardQuota(caseObj, res)) return;
			const answered = isRecord(res.json?.answers) && Object.keys(res.json.answers).length > 0;
			caseObj.check('未知 model 未被当作正常请求处理', !res.ok || !answered, `status=${res.status} body=${clip(res.text)}`);
		},
	},
];

/* ------------------------------------------------------------------ 主流程 */

const C = {
	green: (text) => (process.stdout.isTTY ? `\u001b[32m${text}\u001b[0m` : text),
	red: (text) => (process.stdout.isTTY ? `\u001b[31m${text}\u001b[0m` : text),
	dim: (text) => (process.stdout.isTTY ? `\u001b[2m${text}\u001b[0m` : text),
	bold: (text) => (process.stdout.isTTY ? `\u001b[1m${text}\u001b[0m` : text),
};

function printHelp() {
	process.stdout.write(`${C.bold('jev 模型 HTTP 测试用例')}\n\n`);
	process.stdout.write('  node scripts/test-jev.mjs [--base-url URL] [--key KEY] [--model ID] [--case NAME]… [--list]\n\n');
	process.stdout.write('环境变量：JEV_BASE_URL / TYPESAFE_BASE_URL、JEV_API_KEY / TYPESAFE_API_KEY、JEV_MODEL / TYPESAFE_DEFAULT_MODEL\n\n');
	process.stdout.write('用例：\n');
	for (const item of CASES) process.stdout.write(`  ${item.name.padEnd(24)} ${item.describe}\n`);
}

async function probeHost(ctx) {
	// 用一个最小合法问题探针（空 questions 会被某些网关/实现判 400，噪声太大）。
	const res = await post(ctx.endpoint, {
		key: ctx.key || 'probe',
		body: { model: ctx.model, state: 'ping', questions: { alive: { type: 'noul', instructions: 'Is this request alive?' } } },
	});
	const notFound = res.status === 404 || res.status === 405;
	if (notFound) {
		process.stderr.write(`${C.red('连通性错误：')}${ctx.endpoint} 返回 ${res.status}，该 host 没有暴露 System One 端点。\n`);
		process.stderr.write(`  · New API 网关（${res.text.includes('X-New-Api') || /new_api/i.test(res.text) ? '已识别为 New API' : '未识别'}）不会内置 /v1/systemone；`);
		process.stderr.write('需要给 jev 绑定一个 type-61「Task Plugin」通道，或 type-60 New API 通道指向真正跑 System One 的上游。\n');
		process.stderr.write('  · 直接打官方时用：--base-url https://api.typesafe.ai/v1 --key <TYPESAFE_API_KEY>\n');
		return false;
	}
	if (res.status === 0) {
		process.stderr.write(`${C.red('连通性错误：')}无法连接 ${ctx.endpoint}：${clip(res.text, 200)}\n`);
		return false;
	}
	if (res.status === 503) {
		process.stderr.write(`${C.red('连通性错误：')}${ctx.endpoint} 返回 503：${clip(res.text, 300)}\n`);
		process.stderr.write('  这通常表示网关有模型名但没有任何可用通道（No available channel）。\n');
		return false;
	}
	if (res.status === 402 || (res.status === 403 && isQuotaError(res))) {
		process.stdout.write(`${C.dim(`探针 ${ctx.endpoint} → 网关预扣费不足（HTTP ${res.status}）；端点可达，仅余额问题。`)}${C.dim(`\n  ${clip(res.text, 160)}`)}\n`);
		return true;
	}
	process.stdout.write(`${C.dim(`探针 ${ctx.endpoint} → HTTP ${res.status}（${res.ms}ms）`)}\n`);
	return true;
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 2;
		return;
	}
	if (opts.help) { printHelp(); return; }
	if (opts.list) {
		for (const item of CASES) process.stdout.write(`${item.name}\t${item.describe}\n`);
		return;
	}

	const config = resolveConfig(opts);
	const ctx = { ...config, endpoint: endpointOf(config.baseUrl) };

	process.stdout.write(`${C.bold('Jev 测试')} ${C.dim(`endpoint=${ctx.endpoint} model=${ctx.model} key=${ctx.key ? `set(${ctx.key.slice(0, 7)}…)` : 'unset'}`)}\n\n`);

	const selected = opts.cases.length > 0
		? CASES.filter((item) => opts.cases.includes(item.name))
		: CASES;
	if (selected.length === 0) {
		process.stderr.write(`没有匹配的用例：${opts.cases.join(', ')}\n`);
		process.exitCode = 2;
		return;
	}

	if (!(await probeHost(ctx))) {
		process.exitCode = 2;
		return;
	}

	let passed = 0;
	let failed = 0;
	let skipped = 0;
	for (const item of selected) {
		if (item.needsKey && !ctx.key) {
			process.stdout.write(`${C.dim('SKIP')} ${item.name} ${C.dim('（需要密钥，未提供）')}\n`);
			skipped += 1;
			continue;
		}
		const caseObj = new Case(item.name);
		process.stdout.write(`${C.bold('▶')} ${item.name} ${C.dim(`— ${item.describe}`)}\n`);
		try {
			await item.run(caseObj, ctx);
		} catch (error) {
			caseObj.check('用例执行未抛异常', false, String(error?.stack ?? error));
		}
		for (const check of caseObj.checks) {
			process.stdout.write(`    ${check.ok ? C.green('PASS') : C.red('FAIL')} ${check.label}${check.ok || check.detail === undefined ? '' : C.dim(`  (${check.detail})`)}\n`);
		}
		for (const note of caseObj.notes) process.stdout.write(`    ${C.dim(`note: ${note}`)}\n`);
		if (caseObj.skipped !== null) {
			skipped += 1;
			process.stdout.write(`  ${C.dim(`⤼ 跳过：${caseObj.skipped}`)}\n\n`);
		} else if (caseObj.ok) {
			passed += 1;
			process.stdout.write(`  ${C.green('✔ 通过')}\n\n`);
		} else {
			failed += 1;
			process.stdout.write(`  ${C.red('✘ 失败')}\n\n`);
		}
	}

	process.stdout.write(`${C.bold('汇总')} 通过 ${passed}，失败 ${failed}，跳过 ${skipped}\n`);
	if (skipped > 0 && failed === 0) process.stdout.write(`${C.dim('（有跳过：密钥/余额或端点不可用，未覆盖的部分见上面的 note）')}\n`);
	process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
	process.stderr.write(`${error?.stack ?? error}\n`);
	process.exitCode = 2;
});
