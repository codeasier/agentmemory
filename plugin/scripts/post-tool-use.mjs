#!/usr/bin/env node
import { execSync } from "node:child_process";
import { basename } from "node:path";
//#region src/hooks/_project.ts
function resolveProject(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	try {
		const top = execSync("git rev-parse --show-toplevel", {
			cwd: dir,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 500
		}).toString().trim();
		if (top) return basename(top);
	} catch {}
	return basename(dir);
}
function hookCwd(data) {
	if (!data || typeof data !== "object") return void 0;
	if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
	const roots = data.workspace_roots;
	if (Array.isArray(roots)) {
		for (const root of roots) if (typeof root === "string" && root.trim()) return root;
	}
	const projectDir = process.env["DEVIN_PROJECT_DIR"] || process.env["CLAUDE_PROJECT_DIR"];
	if (projectDir && projectDir.trim()) return projectDir;
}
//#endregion
//#region src/hooks/truncate.ts
const TRUNCATION_MARKER = "...[truncated]";
function serializedLength(value) {
	return JSON.stringify(value)?.length ?? 0;
}
function truncate(value, max) {
	if (typeof value === "string") {
		if (serializedLength(value) <= max) return value;
		let keep = 0;
		let hi = value.length;
		while (keep < hi) {
			const mid = Math.ceil((keep + hi) / 2);
			if (serializedLength(value.slice(0, mid) + "...[truncated]") <= max) keep = mid;
			else hi = mid - 1;
		}
		return value.slice(0, keep) + TRUNCATION_MARKER;
	}
	if (Array.isArray(value)) {
		if (serializedLength(value) <= max) return value;
		const bounded = [];
		let remaining = Math.max(0, max - 2);
		for (const item of value) {
			const comma = bounded.length > 0 ? 1 : 0;
			if (remaining <= comma) break;
			const next = truncate(item, remaining - comma);
			const cost = comma + serializedLength(next);
			if (cost > remaining) continue;
			bounded.push(next);
			remaining -= cost;
		}
		return bounded;
	}
	if (typeof value === "object" && value !== null) {
		if (serializedLength(value) <= max) return value;
		const bounded = {};
		let remaining = Math.max(0, max - 2);
		const sized = Object.entries(value).map((entry) => ({
			entry,
			size: serializedLength(entry[1])
		}));
		sized.sort((a, b) => a.size - b.size);
		for (const { entry } of sized) {
			const [key, item] = entry;
			const overhead = (Object.keys(bounded).length > 0 ? 1 : 0) + JSON.stringify(key).length + 1;
			if (remaining <= overhead) continue;
			const next = truncate(item, remaining - overhead);
			const cost = overhead + serializedLength(next);
			if (cost > remaining) continue;
			bounded[key] = next;
			remaining -= cost;
		}
		return bounded;
	}
	return value;
}
//#endregion
//#region src/hooks/post-tool-use.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (!data || typeof data !== "object") return;
	if (isSdkChildContext(data)) return;
	const sessionId = data.session_id || data.sessionId || data.conversation_id || "unknown";
	const toolName = data.tool_name ?? data.toolName;
	const toolInput = data.tool_input ?? data.toolArgs;
	const { imageData, cleanOutput } = extractImageData(toolOutput(data));
	const cwd = hookCwd(data) || process.cwd();
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "post_tool_use",
			sessionId,
			project: resolveProject(cwd),
			cwd,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				tool_name: toolName,
				tool_input: toolInput,
				tool_output: truncate(cleanOutput, 32e3),
				...imageData ? { image_data: imageData } : {}
			}
		}),
		signal: AbortSignal.timeout(3e3)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 500).unref();
}
function toolOutput(data) {
	if (data.tool_response !== void 0) return data.tool_response;
	if (data.tool_output !== void 0) return data.tool_output;
	const result = data.tool_result ?? data.toolResult;
	if (typeof result === "object" && result !== null) {
		const obj = result;
		return obj.text_result_for_llm ?? obj.textResultForLlm ?? result;
	}
	return result;
}
function isBase64Image(val) {
	return typeof val === "string" && (val.startsWith("data:image/") || val.startsWith("iVBORw0KGgo") || val.startsWith("/9j/"));
}
function extractImageData(output) {
	if (isBase64Image(output)) return {
		imageData: output,
		cleanOutput: "[image data extracted]"
	};
	if (typeof output === "object" && output !== null && !Array.isArray(output)) {
		const obj = output;
		let imageData;
		const clean = {};
		for (const [key, val] of Object.entries(obj)) if (!imageData && isBase64Image(val)) {
			imageData = val;
			clean[key] = "[image data extracted]";
		} else clean[key] = val;
		return {
			imageData,
			cleanOutput: clean
		};
	}
	return {
		imageData: void 0,
		cleanOutput: output
	};
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=post-tool-use.mjs.map